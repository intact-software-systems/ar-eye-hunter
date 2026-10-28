import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupDirectoryEntry, GroupDirectoryPage } from '@shared/api/group-directory/group-directory-types.ts';
import { readGroupRetentionState } from '@shared/api/group-retention.ts';
import {
    countGroupPlayers,
    countOnlineGroupPlayers,
    isGroupSpectator,
    readGroupSpectatorCapacity
} from '@shared/api/group-spectating.ts';
import { toCanonicalGroupRef, type GroupSnapshot } from '@shared/api/group-types.ts';

import {
    encodeGroupDirectoryCursor,
    type GroupDirectoryCursor,
    type GroupDirectoryQuery
} from './decode-group-directory-query.ts';

export interface ComputeGroupDirectoryPageInput {
    readonly query: GroupDirectoryQuery;
    /** Admission's cap for groups without their own `maxMembers`; null means uncapped. */
    readonly defaultMaxMembers: number | null;
    readonly requesterSessionId: string | null;
    /** Validated, unexpired observations from the existing RTT repository. */
    readonly rttMeasurements: readonly RttMeasurementInfo[];
    readonly nowEpochMs: number;
}

interface GroupDirectoryCandidate {
    readonly snapshot: GroupSnapshot;
    readonly position: GroupDirectoryCursor;
}

const PEER_RTT_MAX_SAMPLE_AGE_MS = 60_000;

export function computeGroupDirectoryPage(
    snapshots: readonly GroupSnapshot[],
    input: ComputeGroupDirectoryPageInput
): GroupDirectoryPage {
    const { query, defaultMaxMembers } = input;
    const peerRtt = computeRecentPeerRtt(input);
    const ordered = snapshots
        .filter((snapshot) => matchesGroupDirectoryQuery(snapshot, query))
        .map((snapshot): GroupDirectoryCandidate => ({
            snapshot,
            position: {
                order: query.order,
                groupId: snapshot.group.groupId,
                onlineMemberCount: countOnlineGroupPlayers(snapshot),
                peerRttMs: query.order === 'peer-rtt'
                    ? computeGroupPeerRtt(snapshot, peerRtt, input.nowEpochMs)
                    : null
            }
        }))
        .toSorted((left, right) => compareDirectoryPositions(left.position, right.position))
        .filter((candidate) => query.after === null || compareDirectoryPositions(candidate.position, query.after) > 0);
    const page = ordered.slice(0, query.limit);
    const last = page.at(-1);

    return {
        entries: page.map((candidate) => toGroupDirectoryEntry(candidate, defaultMaxMembers)),
        nextCursor: last && ordered.length > page.length
            ? encodeGroupDirectoryCursor(last.position)
            : null
    };
}

export function matchesGroupDirectoryQuery(
    snapshot: GroupSnapshot,
    query: Pick<GroupDirectoryQuery, 'kind' | 'q' | 'includeEmpty'>
): boolean {
    return (query.kind === null || snapshot.group.kind === query.kind) &&
        (query.q === null || snapshot.group.displayName.toLowerCase().includes(query.q)) &&
        (snapshot.onlineMemberCount > 0 ||
            (query.includeEmpty && readGroupRetentionState(snapshot.group.metadata) === null));
}

/**
 * Online counts change between page requests, so a room can move across the cursor and be repeated
 * or skipped. Pages are a best-effort view of a live lobby, not a consistent snapshot.
 */
export function compareGroupDirectoryOrder(left: GroupSnapshot, right: GroupSnapshot): number {
    if (countOnlineGroupPlayers(left) !== countOnlineGroupPlayers(right)) {
        return countOnlineGroupPlayers(right) - countOnlineGroupPlayers(left);
    }
    return left.group.groupId < right.group.groupId ? -1 : left.group.groupId > right.group.groupId ? 1 : 0;
}

function compareDirectoryPositions(left: GroupDirectoryCursor, right: GroupDirectoryCursor): number {
    if (left.onlineMemberCount !== right.onlineMemberCount) {
        return right.onlineMemberCount - left.onlineMemberCount;
    }
    if (left.order === 'peer-rtt' && left.peerRttMs !== right.peerRttMs) {
        if (left.peerRttMs === null) {
            return 1;
        }
        if (right.peerRttMs === null) {
            return -1;
        }
        return left.peerRttMs - right.peerRttMs;
    }
    return left.groupId < right.groupId ? -1 : left.groupId > right.groupId ? 1 : 0;
}

function computeRecentPeerRtt(input: ComputeGroupDirectoryPageInput): ReadonlyMap<string, number> {
    const values = new Map<string, number>();
    if (input.query.order !== 'peer-rtt' || input.requesterSessionId === null) {
        return values;
    }
    for (const measurement of input.rttMeasurements) {
        const ageMs = input.nowEpochMs - measurement.createdAtEpochMs;
        if (ageMs < 0 || ageMs >= PEER_RTT_MAX_SAMPLE_AGE_MS) {
            continue;
        }
        if (measurement.sessionIdFrom === input.requesterSessionId) {
            values.set(measurement.sessionIdTo, measurement.rttMs);
        }
        else if (measurement.sessionIdTo === input.requesterSessionId) {
            values.set(measurement.sessionIdFrom, measurement.rttMs);
        }
    }
    return values;
}

function computeGroupPeerRtt(
    snapshot: GroupSnapshot,
    peerRtt: ReadonlyMap<string, number>,
    nowEpochMs: number
): number | null {
    const sessions = snapshot.activeSessions.filter((session) =>
        session.status === 'active' && session.connectedAtEpochMs <= nowEpochMs && session.expiresAtEpochMs > nowEpochMs
    );
    if (sessions.length === 0) {
        return null;
    }
    let maximum = 0;
    for (const session of sessions) {
        const rtt = peerRtt.get(session.sessionId);
        if (rtt === undefined) {
            return null;
        }
        maximum = Math.max(maximum, rtt);
    }
    return maximum;
}

function toGroupDirectoryEntry(
    candidate: GroupDirectoryCandidate,
    defaultMaxMembers: number | null
): GroupDirectoryEntry {
    const { snapshot, position } = candidate;
    const group = snapshot.group;
    const maxMembers = group.maxMembers ?? defaultMaxMembers;
    return {
        groupRef: toCanonicalGroupRef(group),
        displayName: group.displayName,
        kind: group.kind,
        joinMode: group.joinMode,
        memberCount: snapshot.memberCount,
        playerCount: countGroupPlayers(snapshot),
        onlinePlayerCount: countOnlineGroupPlayers(snapshot),
        spectatorCount: snapshot.members.filter(isGroupSpectator).length,
        maxSpectators: readGroupSpectatorCapacity(group.metadata),
        onlineMemberCount: snapshot.onlineMemberCount,
        maxMembers,
        isFull: maxMembers !== null && countGroupPlayers(snapshot) >= maxMembers,
        lifecycleState: group.lifecycleState,
        peerRttMs: position.peerRttMs
    };
}
