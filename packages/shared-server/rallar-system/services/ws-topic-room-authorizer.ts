import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { isGroupActive, isSessionInGroup } from '@shared/api/group-client-views.ts';
import type { RallarServerWsRoomAuthorizer } from '../../rallar-facade/ws-topic-router.ts';

export type CreateGroupRoomWsAuthorizerOptions = Readonly<{
    findGroupSnapshotById(groupId: string): GroupSnapshot | undefined;
}>;

export function createGroupRoomWsAuthorizer(
    options: CreateGroupRoomWsAuthorizerOptions,
): RallarServerWsRoomAuthorizer {
    return (input) => {
        const snapshot = options.findGroupSnapshotById(input.roomId);

        return !!snapshot &&
            isGroupActive(snapshot) &&
            isSessionInGroup(snapshot, input.senderId);
    };
}
