import type { GroupDirectoryEntry, GroupDirectoryPage } from '@shared/api/group-directory/group-directory-types.ts';
import { toCanonicalGroupRef, type GroupSnapshot } from '@shared/api/group-types.ts';

import { encodeGroupDirectoryCursor, type GroupDirectoryQuery } from './decode-group-directory-query.ts';

export interface ComputeGroupDirectoryPageInput {
    readonly query: GroupDirectoryQuery;
    /** Admission's cap for groups without their own `maxMembers`; null means uncapped. */
    readonly defaultMaxMembers: number | null;
}

export function computeGroupDirectoryPage(
    snapshots: readonly GroupSnapshot[],
    { query, defaultMaxMembers }: ComputeGroupDirectoryPageInput
): GroupDirectoryPage {
    const ordered = snapshots
        .filter((snapshot) => matchesGroupDirectoryQuery(snapshot, query))
        .toSorted(compareGroupDirectoryOrder)
        .filter((snapshot) => isAfterCursor(snapshot, query));
    const page = ordered.slice(0, query.limit);
    const last = page.at(-1);

    return {
        entries: page.map((snapshot) => toGroupDirectoryEntry(snapshot, defaultMaxMembers)),
        nextCursor: last && ordered.length > page.length
            ? encodeGroupDirectoryCursor({
                onlineMemberCount: last.onlineMemberCount,
                groupId: last.group.groupId
            })
            : null
    };
}

export function matchesGroupDirectoryQuery(
    snapshot: GroupSnapshot,
    query: Pick<GroupDirectoryQuery, 'kind' | 'q' | 'includeEmpty'>
): boolean {
    return (query.kind === null || snapshot.group.kind === query.kind) &&
        (query.q === null || snapshot.group.displayName.toLowerCase().includes(query.q)) &&
        (query.includeEmpty || snapshot.onlineMemberCount > 0);
}

/**
 * Online counts change between page requests, so a room can move across the cursor and be repeated
 * or skipped. Pages are a best-effort view of a live lobby, not a consistent snapshot.
 */
export function compareGroupDirectoryOrder(left: GroupSnapshot, right: GroupSnapshot): number {
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

function toGroupDirectoryEntry(snapshot: GroupSnapshot, defaultMaxMembers: number | null): GroupDirectoryEntry {
    const group = snapshot.group;
    const maxMembers = group.maxMembers ?? defaultMaxMembers;
    return {
        groupRef: toCanonicalGroupRef(group),
        displayName: group.displayName,
        kind: group.kind,
        joinMode: group.joinMode,
        memberCount: snapshot.memberCount,
        onlineMemberCount: snapshot.onlineMemberCount,
        maxMembers,
        isFull: maxMembers !== null && group.activeMemberCount >= maxMembers,
        lifecycleState: group.lifecycleState
    };
}
