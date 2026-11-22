import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { readGroupSessionSchedule } from '@shared/api/group-sessions/group-session-schedule.ts';
import type { Group } from '@shared/api/group-types.ts';
import {
    changeRoomLobby,
    configureRoomLobby,
    createRoomLobby,
    readRoomLobbyPolicy,
    type RoomLobby
} from '@shared/api/room-lobbies/room-lobby.ts';
import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import type { GroupMutationWriteInput } from '../mutation/group-mutation-result.ts';
import { denyGroupPolicy, GroupPolicyDeniedError } from '../policy/group-policy-result.ts';
import { countGroupSessionOccupiedSeats } from '../schedule/group-session-reservations.ts';
import { computeRoomLobbyPublication } from './room-lobby-publication.ts';
import { computeRoomLobbyEffects, type RoomLobbyRead } from './room-lobby-storage.ts';

export function computeRoomLobbyMutation(input: GroupMutationWriteInput, group: Group) {
    const { command, read, facts } = input;
    const state = read.roomLobby;
    if (!state) {
        return { effects: [], outbox: [], provenance: [] };
    }
    const before = state.lobby?.value ?? null;
    let after = computeRoomLobbyRoster(input, group, state);
    if (after && before === after && input.guard.kind === 'presence') {
        // Connecting a second session can leave the account present. Its write must still observe this lobby activation.
        after = { ...after };
    }
    const expired = before?.expiresAtEpochMs != null && before.expiresAtEpochMs <= facts.attemptAtEpochMs;
    const effects = computeRoomLobbyEffects(state, after, command.aggregateRef, expired ? 'expired' : 'active');
    if (!effects.length) {
        return { effects, outbox: [], provenance: [] };
    }
    const publication = computeRoomLobbyPublication({
        roomRef: command.aggregateRef,
        groupCreatedAtEpochMs: group.created.atEpochMs,
        before,
        after,
        createdAtEpochMs: facts.nowEpochMs,
        retentionMs: facts.expireAtEpochMs - facts.nowEpochMs,
        serviceId: facts.serviceId,
        traceId: facts.traceId
    });
    return { effects, ...publication };
}

function computeRoomLobbyRoster(input: GroupMutationWriteInput, group: Group, state: RoomLobbyRead): RoomLobby | null {
    const { command, facts, read } = input;
    const policy = readRoomLobbyPolicy(group.metadata);
    const now = facts.attemptAtEpochMs;
    const lifetime = [group.expiresAtEpochMs, group.purgeAfterEpochMs].filter((value) => value !== null);
    const expiresAtEpochMs = lifetime.length ? Math.min(...lifetime) : null;
    const schedule = readGroupSessionSchedule(group.metadata);
    if (
        group.status !== 'active' || !policy || schedule?.cancelledAtEpochMs != null ||
        (expiresAtEpochMs !== null && expiresAtEpochMs <= now)
    ) {
        return null;
    }
    if (!group.maxMembers) {
        throw new TypeError('Managed rooms require player capacity');
    }

    let lobby = state.lobby?.value;
    if (!lobby && command.operation !== 'createGroup' &&
        !(command.operation === 'updateGroup' && command.input.roomLobby?.operation === 'configure' && read.group && !readRoomLobbyPolicy(read.group.value.metadata))) {
        throw new RuntimeStateWriteConflictError();
    }
    if (!lobby || command.operation === 'createGroup') {
        lobby = createRoomLobby(command.aggregateRef, group.maxMembers, policy, facts.eventId, expiresAtEpochMs);
    }
    else if (
        group.maxMembers !== lobby.capacity || policy.returnWindowMs !== lobby.policy.returnWindowMs ||
        policy.claimWindowMs !== lobby.policy.claimWindowMs
    ) {
        const configured = configureRoomLobby(lobby, { capacity: group.maxMembers, policy }, now);
        if (configured.rejection) {
            throw new GroupPolicyDeniedError(
                denyGroupPolicy('group-full', 'The requested capacity cannot hold the occupied seats.')
            );
        }
        lobby = configured.lobby;
    }
    if (lobby.expiresAtEpochMs !== expiresAtEpochMs) {
        lobby = { ...lobby, expiresAtEpochMs, revision: lobby.revision + 1 };
    }

    const accounts = new Map(state.accounts.map((account) => [account.principalId, account.stored?.value.seat]));
    for (const change of lobbyParticipationChanges(input, state, lobby)) {
        if (change.kind === 'arrive' || change.kind === 'reserve') {
            const commitment = accounts.get(change.principalId);
            if (commitment && !isSameGroupRef(commitment.roomRef, group)) {
                throw new GroupPolicyDeniedError(
                    denyGroupPolicy(
                        'group-policy-denied',
                        'Release the existing lobby seat before joining another lobby.'
                    )
                );
            }
        }
        const updated = changeRoomLobby(lobby, change, now);
        if (updated.rejection) {
            const reason = updated.rejection === 'full' ? 'group-full' : 'group-admission-closed';
            throw new GroupPolicyDeniedError(denyGroupPolicy(reason, 'The requested lobby seat is unavailable.'));
        }
        lobby = updated.lobby;
    }
    const reservations = input.sessionReservationWrite?.value ?? read.sessionReservations?.value;
    if (
        schedule && reservations && countGroupSessionOccupiedSeats({
                schedule,
                reservations,
                activePlayerPrincipalIds: lobby.seats.map((seat) => seat.principalId),
                nowEpochMs: now
            }) > lobby.capacity
    ) {
        throw new GroupPolicyDeniedError(
            denyGroupPolicy('group-full', 'Available player places are reserved for this scheduled session.')
        );
    }
    return lobby;
}

function lobbyParticipationChanges(
    input: GroupMutationWriteInput,
    state: RoomLobbyRead,
    lobby: RoomLobby
): RoomLobby.Command[] {
    const { command, read, guard } = input;
    const changes: RoomLobby.Command[] = [];
    const livePrincipals = new Set(
        state.sessions.filter((session) =>
            session.status === 'active' && session.expiresAtEpochMs > input.facts.attemptAtEpochMs &&
            !(command.operation === 'disconnectPresence' && session.sessionId === command.sessionId)
        ).map((session) => session.principalId)
    );
    if (command.operation === 'updateGroup') {
        if (command.input.roomLobby?.operation === 'release' && command.input.actorPrincipalId) {
            changes.push({ kind: 'release', principalId: command.input.actorPrincipalId });
        }
        if (!state.lobby) {
            for (const member of read.activeMembers ?? []) {
                if (member.role !== 'spectator' && livePrincipals.has(member.principalId)) {
                    changes.push({ kind: 'arrive', principalId: member.principalId });
                }
            }
        }
    }
    for (const member of input.members) {
        const principalId = member.principalId;
        if (member.status === 'active' && member.role !== 'spectator') {
            const predecessor = principalId === read.targetMember?.principalId ? read.targetMember : read.actorMember;
            if (
                command.operation === 'createGroup' || command.operation === 'joinGroup' ||
                command.operation === 'acceptGroupInvite' ||
                predecessor?.status !== 'active' || predecessor.role === 'spectator'
            ) {
                changes.push({ kind: 'reserve', principalId });
            }
        }
        else if (member.status === 'left' && principalId === command.input.actorPrincipalId) {
            changes.push({ kind: 'away', principalId });
        }
        else {
            changes.push({ kind: 'release', principalId });
        }
    }
    if (
        guard.kind === 'presence' && read.targetMember?.role !== 'spectator' && command.operation === 'connectPresence'
    ) {
        const principalId = guard.value.principalId;
        if (!lobby.seats.some((seat) => seat.principalId === principalId)) {
            throw new GroupPolicyDeniedError(
                denyGroupPolicy('group-admission-closed', 'Join the lobby before confirming a seat.')
            );
        }
        changes.push({ kind: 'arrive', principalId });
        livePrincipals.add(principalId);
    }
    // The final socket may lose its lease before the cleanup worker runs. Resolve that at the fill boundary too.
    for (const seat of lobby.seats) {
        if (seat.present && !livePrincipals.has(seat.principalId)) {
            changes.push({ kind: 'away', principalId: seat.principalId });
        }
    }
    return changes;
}
