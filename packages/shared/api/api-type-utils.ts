import type { GroupRef } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

export function isSameGroupRef(
    left: GroupRef,
    right: GroupRef
): boolean {
    return left.groupId === right.groupId &&
        left.applicationId === right.applicationId &&
        (left.workspaceId ?? '') === (right.workspaceId ?? '');
}

export function isSameGroupScope(
    left: Pick<GroupRef, 'applicationId' | 'workspaceId'>,
    right: Pick<GroupRef, 'applicationId' | 'workspaceId'>
): boolean {
    return left.applicationId === right.applicationId &&
        (left.workspaceId ?? '') === (right.workspaceId ?? '');
}

export function toWebRtcGroupKey(groupRef: GroupRef): string {
    return JSON.stringify([
        groupRef.applicationId,
        groupRef.workspaceId ?? '',
        groupRef.groupId
    ]);
}

export function toScopedGroupKey(groupRef: GroupRef): string {
    return toWebRtcGroupKey(groupRef);
}

export function toScopedRoomKey(groupRef: GroupRef): string {
    return toScopedGroupKey(groupRef);
}

export function toScopedOverlayId(groupRef: GroupRef): string {
    return toScopedGroupKey(groupRef);
}

export function toScopedOverlayKey(groupRef: GroupRef): string {
    return toScopedOverlayId(groupRef);
}

export function isOverlayForGroupRef(
    overlay: Readonly<{ groupRef?: GroupRef; }>,
    groupRef: GroupRef
): boolean {
    return overlay.groupRef === undefined ||
        isSameGroupRef(overlay.groupRef, groupRef);
}

export function toGroupRefFromScope(
    groupId: string,
    scope?: StateScope
): GroupRef | undefined {
    return scope
        ? {
            ...scope,
            groupId
        }
        : undefined;
}

export function toStateScope(ref: GroupRef): StateScope {
    return {
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId ?? ''
    };
}
