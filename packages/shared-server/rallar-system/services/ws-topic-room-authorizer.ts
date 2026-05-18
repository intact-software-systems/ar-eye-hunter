import type { GroupSnapshot } from '@shared/api/group-types.ts';
import {
    isGroupActive,
    isSessionInGroup,
    readGroupVersion,
} from '@shared/api/group-client-views.ts';
import type { RallarServerWsRoomAuthorizer } from '../../rallar-facade/ws-topic-router.ts';

export type CreateGroupRoomWsAuthorizerOptions = Readonly<{
    findGroupSnapshotById(groupId: string): GroupSnapshot | undefined;
}>;

export function createGroupRoomWsAuthorizer(
    options: CreateGroupRoomWsAuthorizerOptions,
): RallarServerWsRoomAuthorizer {
    return (input) => {
        const snapshot = options.findGroupSnapshotById(input.roomId);
        const minSnapshotVersion = input.minSnapshotVersion;

        if (!snapshot) {
            if (minSnapshotVersion !== undefined) {
                return {
                    authorized: false,
                    reason: 'not-yet-in-sync',
                    logMessage:
                        `Room ${input.roomId} cache is missing; requires snapshot version ${minSnapshotVersion}`,
                };
            }

            return false;
        }

        const serverSnapshotVersion = readGroupVersion(snapshot);
        if (
            minSnapshotVersion !== undefined &&
            serverSnapshotVersion < minSnapshotVersion
        ) {
            return {
                authorized: false,
                reason: 'not-yet-in-sync',
                logMessage:
                    `Room ${input.roomId} cache version ${serverSnapshotVersion} is older than required version ${minSnapshotVersion}`,
                serverSnapshotVersion,
            };
        }

        return isGroupActive(snapshot) && isSessionInGroup(snapshot, input.senderId);
    };
}
