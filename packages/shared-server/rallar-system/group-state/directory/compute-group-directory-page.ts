import type { GroupDirectoryEntry, GroupDirectoryPage } from '@shared/api/group-directory/group-directory-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { encodeGroupDirectoryCursor, type GroupDirectoryQuery } from './decode-group-directory-query.ts';

export function computeGroupDirectoryPage(
    snapshots: readonly GroupSnapshot[],
    query: GroupDirectoryQuery
): GroupDirectoryPage {
    const ordered = snapshots
        .filter((snapshot) => matchesGroupDirectoryQuery(snapshot, query))
        .toSorted(compareGroupDirectoryOrder)
        .filter((snapshot) => isAfterCursor(snapshot, query));
    const page = ordered.slice(0, query.limit);
    const last = page.at(-1);

    return {
        entries: page.map(toGroupDirectoryEntry),
        nextCursor: last && ordered.length > page.length
            ? encodeGroupDirectoryCursor({
                onlineMemberCount: last.onlineMemberCount,
                groupId: last.group.groupId
            })
            : null
    };
}

function matchesGroupDirectoryQuery(snapshot: GroupSnapshot, query: GroupDirectoryQuery): boolean {
    return (query.kind === null || snapshot.group.kind === query.kind) &&
        (query.q === null || snapshot.group.displayName.toLowerCase().includes(query.q)) &&
        (query.includeEmpty || snapshot.onlineMemberCount > 0);
}

function compareGroupDirectoryOrder(left: GroupSnapshot, right: GroupSnapshot): number {
    if (left.onlineMemberCount !== right.onlineMemberCount) {
        return right.onlineMemberCount - left.onlineMemberCount;
    }
    return left.group.groupId < right.group.groupId ? -1 : left.group.groupId > right.group.groupId ? 1 : 0;
}

function isAfterCursor(snapshot: GroupSnapshot, query: GroupDirectoryQuery): boolean {
    const after = query.after;
    if (after === null) {
        return true;
    }
    return snapshot.onlineMemberCount < after.onlineMemberCount ||
        (snapshot.onlineMemberCount === after.onlineMemberCount && snapshot.group.groupId > after.groupId);
}

function toGroupDirectoryEntry(snapshot: GroupSnapshot): GroupDirectoryEntry {
    const group = snapshot.group;
    return {
        groupRef: {
            applicationId: group.applicationId,
            workspaceId: group.workspaceId,
            groupId: group.groupId
        },
        displayName: group.displayName,
        kind: group.kind,
        joinMode: group.joinMode,
        memberCount: snapshot.memberCount,
        onlineMemberCount: snapshot.onlineMemberCount,
        maxMembers: group.maxMembers,
        isFull: group.maxMembers !== null && snapshot.memberCount >= group.maxMembers,
        lifecycleState: group.lifecycleState
    };
}
