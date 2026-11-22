import type { RoomLobby } from '@shared/api/room-lobbies/room-lobby.ts';
import type { GroupMutationWriteInput } from '../mutation/group-mutation-result.ts';

export function computeGroupLobbyMembership(input: GroupMutationWriteInput): RoomLobby.Command[] {
    const { command, read } = input;
    const changes: RoomLobby.Command[] = [];
    for (const member of input.members) {
        const principalId = member.principalId;
        const invitationControlsAccess = read.group?.value.joinMode === 'invite-only' ||
            read.lifecyclePolicy?.status === 'present' &&
                read.lifecyclePolicy.policy.admission.mode === 'manager-approval';
        if (member.status === 'invited') {
            if (invitationControlsAccess && member.invitationExpiresAtEpochMs !== null) {
                changes.push({ kind: 'limit', principalId, eligibleUntilEpochMs: member.invitationExpiresAtEpochMs });
            }
        }
        else if (command.operation === 'revokeGroupInvite' && !invitationControlsAccess) {
            continue;
        }
        else if (member.status === 'active' && member.role !== 'spectator') {
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
    return changes;
}
