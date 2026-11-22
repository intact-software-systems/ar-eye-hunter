import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { Group } from '@shared/api/group-types.ts';
import { changeRoomLobby, configureRoomLobby, createRoomLobby, readRoomLobbyPolicy, type RoomLobby } from '@shared/api/room-lobbies/room-lobby.ts';
import type { GroupMutationWriteInput } from '../mutation/group-mutation-result.ts';
import { denyGroupPolicy, GroupPolicyDeniedError } from '../policy/group-policy-result.ts';
import { computeRoomLobbyPublication } from './room-lobby-publication.ts';
import { computeRoomLobbyEffects } from './room-lobby-storage.ts';

export function computeRoomLobbyMutation(input: GroupMutationWriteInput, group: Group) {
    const { command, read, facts, guard } = input;
    const state = read.roomLobby;
    if (!state) return { effects: [], outbox: [], provenance: [] };
    const policy = readRoomLobbyPolicy(group.metadata);
    const before = state.lobby?.value ?? null;
    const now = facts.attemptAtEpochMs;
    let lobby = before;
    if (group.status !== 'active' || !policy) lobby = null;
    else {
        if (!group.maxMembers) throw new TypeError('Managed rooms require player capacity');
        if (!lobby || command.operation === 'createGroup') lobby = createRoomLobby(command.aggregateRef, group.maxMembers, policy);
        else if (group.maxMembers !== lobby.capacity || policy.returnWindowMs !== lobby.policy.returnWindowMs || policy.claimWindowMs !== lobby.policy.claimWindowMs) {
            const configured = configureRoomLobby(lobby, { capacity: group.maxMembers, policy }, now);
            if (configured.rejection) throw new GroupPolicyDeniedError(denyGroupPolicy('group-full', 'The requested capacity cannot hold the occupied seats.'));
            lobby = configured.lobby;
        }
        const commands: RoomLobby.Command[] = [];
        if (command.operation === 'updateGroup' && command.input.roomLobby?.operation === 'release' && command.input.actorPrincipalId) {
            commands.push({ kind: 'release', principalId: command.input.actorPrincipalId });
        }
        if (!before && command.operation === 'updateGroup') {
            for (const member of read.activeMembers ?? []) {
                if (member.role !== 'spectator' && state.sessions.some(s => s.principalId === member.principalId && s.status === 'active' && s.expiresAtEpochMs > now)) {
                    commands.push({ kind: 'arrive', principalId: member.principalId });
                }
            }
        }
        for (const member of input.members) {
            const principalId = member.principalId;
            if (member.status === 'active' && member.role !== 'spectator') commands.push({ kind: 'reserve', principalId });
            else if (member.status === 'left' && principalId === command.input.actorPrincipalId) commands.push({ kind: 'away', principalId });
            else commands.push({ kind: 'release', principalId });
        }
        if (guard.kind === 'presence' && read.targetMember?.role !== 'spectator') {
            const { principalId, sessionId } = guard.value;
            if (command.operation === 'connectPresence') {
                if (!lobby.seats.some(seat => seat.principalId === principalId)) {
                    throw new GroupPolicyDeniedError(denyGroupPolicy('group-admission-closed', 'Join the lobby before confirming a seat.'));
                }
                commands.push({ kind: 'arrive', principalId });
            }
            else if (command.operation === 'disconnectPresence' && !state.sessions.some(s => s.sessionId !== sessionId && s.principalId === principalId && s.status === 'active' && s.expiresAtEpochMs > now)) {
                commands.push({ kind: 'away', principalId });
            }
        }
        for (const seat of lobby.seats) {
            // A disconnected socket may already have lost its presence lease before the cleanup worker runs.
            if (seat.present && !state.sessions.some(session => session.principalId === seat.principalId && session.status === 'active' && session.expiresAtEpochMs > now)
                && !commands.some(change => change.kind === 'arrive' && change.principalId === seat.principalId)) {
                commands.push({ kind: 'away', principalId: seat.principalId });
            }
        }
        for (const change of commands) {
            if (change.kind !== 'expire' && (change.kind === 'arrive' || change.kind === 'reserve')) {
                const commitment = state.accounts.find(account => account.principalId === change.principalId)?.stored?.value.seat;
                if (commitment && !isSameGroupRef(commitment.roomRef, group)) {
                    throw new GroupPolicyDeniedError(denyGroupPolicy('group-policy-denied', 'Release the existing lobby seat before joining another lobby.'));
                }
            }
            const updated = changeRoomLobby(lobby, change, now);
            if (updated.rejection) throw new GroupPolicyDeniedError(denyGroupPolicy(updated.rejection === 'full' ? 'group-full' : 'group-admission-closed', 'The requested lobby seat is unavailable.'));
            lobby = updated.lobby;
        }
    }
    const effects = computeRoomLobbyEffects(state, lobby, command.aggregateRef);
    if (!effects.length) return { effects, outbox: [], provenance: [] };
    const publication = computeRoomLobbyPublication({
        roomRef: command.aggregateRef, groupCreatedAtEpochMs: group.created.atEpochMs, before, after: lobby,
        createdAtEpochMs: facts.nowEpochMs, retentionMs: facts.expireAtEpochMs - facts.nowEpochMs,
        serviceId: facts.serviceId, traceId: facts.traceId
    });
    return { effects, ...publication };
}
