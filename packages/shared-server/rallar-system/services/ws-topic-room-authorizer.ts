import { readALMulticastTargetGroupRef } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { isGroupActive, isSessionInGroup, readGroupVersion, } from '@shared/api/group-client-views.ts';
import type { RallarServerWsRoomAuthorizer } from '../../rallar-facade/ws-topic-router.ts';
import { isSameGroupScope } from '@shared/api/api-type-utils.ts';

export type CreateGroupRoomWsAuthorizerOptions = Readonly<{
    findGroupSnapshotByRef?: (
        ref: GroupRef,
        input: Parameters<RallarServerWsRoomAuthorizer>[0],
    ) => GroupSnapshot | undefined;
    findGroupSnapshotById?: (groupId: string) => GroupSnapshot | undefined;
    resolveGroupRef?: (
        input: Parameters<RallarServerWsRoomAuthorizer>[0],
    ) => GroupRef | undefined;
}>;

export function createGroupRoomWsAuthorizer(
    options: CreateGroupRoomWsAuthorizerOptions,
): RallarServerWsRoomAuthorizer {
    return (input) => {
        const groupRef = input.roomRef ??
            (input.message.targets?.mode === 'multicast'
                ? readALMulticastTargetGroupRef(input.message)
                : options.resolveGroupRef?.(input));
        const scopedSnapshot = groupRef
            ? options.findGroupSnapshotByRef?.(groupRef, input)
            : undefined;
        const byIdSnapshot = options.findGroupSnapshotById?.(input.roomId);
        const snapshot = scopedSnapshot ?? (
            byIdSnapshot && (!groupRef || isSameGroupScope(byIdSnapshot.group, groupRef))
                ? byIdSnapshot
                : undefined
        );
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
