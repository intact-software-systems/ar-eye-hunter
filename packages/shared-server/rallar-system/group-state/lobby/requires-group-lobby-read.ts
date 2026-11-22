import { isGroupLifecycleTransitionOperation } from '../mutation/group-mutation-contracts.ts';
import { readRoomLobbyRegistration } from '@shared/api/room-lobbies/room-lobby-registration.ts';
import { readRoomLobbyPolicy } from '@shared/api/room-lobbies/room-lobby-policy.ts';
import type { GroupMutationCommand, GroupMutationRead } from '../mutation/group-mutation-contracts.ts';

/** Player admission, accepted presence, and lifetime/capacity changes share the private room authority. */
export function requiresGroupLobbyRead(command: GroupMutationCommand, read: GroupMutationRead, lobbyDefault: boolean): boolean {
    if (read.idempotency) return false;
    if (command.operation === 'createGroup') {
        return read.expiredGroupEntry !== null || (command.input.roomLobby === undefined ? lobbyDefault : command.input.roomLobby !== null);
    }
    if (command.operation === 'updateGroup' && command.input.roomLobby?.operation === 'configure') return true;
    if (!read.group || !readRoomLobbyPolicy(read.group.value.metadata)) return false;
    if (isGroupLifecycleTransitionOperation(command.operation)) return true;
    switch (command.operation) {
        case 'updateGroup':
            if (command.input.roomClock && readRoomLobbyRegistration(read.group.value.metadata)?.boundary?.program === command.input.roomClock.name) {
                return true;
            }
            return (command.input.metadata !== null && read.group.value.joinMode === 'code') || command.input.roomLobby !== undefined || command.input.joinMode !== null || command.input.status !== null || command.input.kind !== null ||
                command.input.maxMembers !== null || command.input.expiresAtEpochMs !== null || command.input.purgeAfterEpochMs !== null;
        case 'connectPresence':
        case 'disconnectPresence':
        case 'changeGroupSession':
        case 'joinGroup':
        case 'acceptGroupInvite':
        case 'upsertMember':
        case 'grantGroupAdmission':
        case 'setGroupMemberRole':
        case 'transferGroupOwnership':
        case 'createGroupInvite':
        case 'revokeGroupInvite':
        case 'declineGroupAdmission':
        case 'rotateGroupJoinCode':
        case 'banGroupMember':
        case 'removeGroupMember':
            return true;
        default:
            return false;
    }
}
