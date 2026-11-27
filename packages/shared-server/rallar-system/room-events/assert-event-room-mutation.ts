import type { Group } from '@shared/api/group-types.ts';
import { GroupMutationRejectedError, type GroupMutationCommand, type GroupMutationFacts } from '../group-state/mutation/group-mutation-contracts.ts';

/** Room clocks, presence and transport still belong to group state; assignments and closure belong to the event. */
export function assertEventRoomMutation(group: Group, command: GroupMutationCommand, facts: GroupMutationFacts): void {
    const event = group.eventRoom;
    if (!event) return;
    const court = event.lobbyGroupId !== group.groupId;
    switch (command.operation) {
        case 'connectPresence':
        case 'heartbeatPresence':
            if (court && !event.organizerPlaying && command.input.principalId === group.ownerPrincipalId) break;
            return;
        case 'banGroupMember':
        case 'unbanGroupMember':
        case 'removeGroupMember':
            if (facts.internalAuthority === 'guest-expiry') return;
            break;
        case 'transferGroupOwnership':
        case 'setGroupMemberRole':
        case 'upsertMember':
        case 'rotateGroupJoinCode':
            break;
        case 'joinGroup':
        case 'grantGroupAdmission':
        case 'acceptGroupInvite':
        case 'createGroupInvite':
            if (!court) return;
            break;
        case 'updateGroup': {
            const change = command.input;
            if (change.status || change.kind || change.joinMode || change.maxMembers !== null || change.maxSessionsPerMember !== null ||
                change.expiresAtEpochMs !== null || change.purgeAfterEpochMs !== null || change.emptySinceEpochMs !== null ||
                change.roomLobby || (court && change.guestInvitationVerifier)) break;
            return;
        }
        default: return;
    }
    throw new GroupMutationRejectedError('This event controls room admission, management and closure.');
}
