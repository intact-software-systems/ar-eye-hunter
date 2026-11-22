import type { RoomLobby } from '@shared/api/room-lobbies/room-lobby.ts';
import type { GroupMutationWriteInput } from '../mutation/group-mutation-result.ts';
import { denyGroupPolicy, GroupPolicyDeniedError } from '../policy/group-policy-result.ts';
import type { GroupLobbyRead } from './group-lobby-storage.ts';

export function computeGroupLobbyParticipation(
    input: GroupMutationWriteInput,
    state: GroupLobbyRead,
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
