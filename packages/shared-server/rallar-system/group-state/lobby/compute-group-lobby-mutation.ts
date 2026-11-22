import type { ViewInvalidationPublication } from '../../websocket/outbox/compute-view-invalidation-publication.ts';
import type { RuntimeStateGuardedBatchEffect } from '../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { readGroupSessionSchedule, toGroupSessionTiming } from '@shared/api/group-sessions/group-session-schedule.ts';
import type { Group } from '@shared/api/group-types.ts';
import { readRoomLobbyPolicy } from '@shared/api/room-lobbies/room-lobby-policy.ts';
import { changeRoomLobby, configureRoomLobby, createRoomLobby, type RoomLobby } from '@shared/api/room-lobbies/room-lobby.ts';
import { configureRoomLobbyCapacityClaims } from '@shared/api/room-lobbies/room-lobby-allocation.ts';
import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import type { GroupMutationWriteInput } from '../mutation/group-mutation-result.ts';
import { denyGroupPolicy, GroupPolicyDeniedError } from '../policy/group-policy-result.ts';
import { computeGroupLobbyParticipation } from './compute-group-lobby-participation.ts';
import { computeGroupLobbyPublication } from './compute-group-lobby-publication.ts';
import { computeGroupLobbyEffects, type GroupLobbyRead } from './group-lobby-storage.ts';
import { revokedLobbyCandidates } from './group-lobby-wait-access.ts';

interface GroupLobbyMutation extends ViewInvalidationPublication {
    readonly effects: readonly RuntimeStateGuardedBatchEffect[];
}

export function computeGroupLobbyMutation(input: GroupMutationWriteInput, group: Group): GroupLobbyMutation {
    const { command, read, facts } = input;
    const state = read.lobbyState;
    if (!state) {
        return { effects: [], outbox: [], provenance: [] };
    }
    const before = state.lobby?.value ?? null;
    let after = computeGroupLobbyRoster(input, group, state);
    if (after && before === after && input.guard.kind === 'presence') {
        // Connecting a second session can leave the account present. Its write must still observe this lobby activation.
        after = { ...after };
    }
    const expired = before?.expiresAtEpochMs != null && before.expiresAtEpochMs <= facts.attemptAtEpochMs;
    const effects = computeGroupLobbyEffects({ read: state, after, roomRef: command.aggregateRef, mode: expired ? 'expired' : 'active' });
    if (!effects.length) {
        return { effects, outbox: [], provenance: [] };
    }
    const publication = computeGroupLobbyPublication({
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

function computeGroupLobbyRoster(input: GroupMutationWriteInput, group: Group, state: GroupLobbyRead): RoomLobby | null {
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

    let lobby = input.revisedLobby ?? state.lobby?.value;
    if (
        !lobby && command.operation !== 'createGroup' &&
        !(command.operation === 'updateGroup' && command.input.roomLobby?.operation === 'configure' && read.group &&
            !readRoomLobbyPolicy(read.group.value.metadata))
    ) {
        throw new RuntimeStateWriteConflictError();
    }
    if (!lobby || command.operation === 'createGroup') {
        lobby = createRoomLobby({
            roomRef: command.aggregateRef,
            capacity: group.maxMembers,
            policy,
            activationId: facts.eventId,
            expiresAtEpochMs
        });
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
    const revocations = revokedLobbyCandidates({ input, next: group, state, lobby });
    for (const change of [...revocations, ...computeGroupLobbyParticipation(input, state, lobby)]) {
        if (change.kind === 'wait' || change.kind === 'arrive' || change.kind === 'reserve') {
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
    // Apply admissions against their previous reservations first. Exchanging a reservation for a seat must never create an offer between the two writes.
    const reservations = input.sessionReservationWrite?.value ?? read.sessionReservations?.value;
    if (schedule && reservations) {
        const { reservationsExpireAtEpochMs } = toGroupSessionTiming(schedule, now);
        const claims = { principalIds: reservations.principalIds, dueAtEpochMs: reservationsExpireAtEpochMs };
        const updated = configureRoomLobbyCapacityClaims(lobby, claims, now);
        if (updated.rejection) {
            throw new GroupPolicyDeniedError(
                denyGroupPolicy('group-full', 'The scheduled places exceed the available lobby capacity.')
            );
        }
        lobby = updated.lobby;
    }
    return lobby;
}
