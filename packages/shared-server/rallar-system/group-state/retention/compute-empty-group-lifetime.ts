import { readRoomClocks } from '@shared/api/group-deadlines/room-clock.ts';
import type { RoomTimeline } from '@shared/api/group-deadlines/room-timeline.ts';
import {
    DEFAULT_PAUSED_TIMELINE_RETENTION_MS,
    readGroupRetentionState,
    type GroupRetentionState
} from '@shared/api/group-retention.ts';
import { readGroupSessionSchedule, toGroupSessionTiming } from '@shared/api/group-sessions/group-session-schedule.ts';
import type { Group } from '@shared/api/group-types.ts';

import { computeMutationCommandDigest, encodeJsonWireValue } from '../../protocol/json-wire-identity.ts';
import { isExactlyAdmitted } from '../mutation/aggregate/group-aggregate-mutation-policy.ts';
import { computeGroupPresenceSummaryContent } from '../presence/compute-group-presence-summary.ts';
import type { GroupPresenceSummaryStoredRead } from '../persistence/group-state-repository-reads.ts';

export function readPausedTimelineRetention(group: Group): GroupRetentionState | null {
    if (group.status !== 'active') return null;
    const policy = readGroupRetentionState(group.metadata);
    return policy && readRoomClocks(group.metadata).some((clock) => 'phase' in clock && clock.status === 'paused')
        ? policy : null;
}

export interface GroupRetentionObservation {
    readonly atEpochMs: number | null;
    readonly fingerprint: string | null;
}

/** One decision for both archival and a player's arrival while the archival worker is delayed. */
export function computeEmptyGroupLifetime(
    authority: GroupPresenceSummaryStoredRead, policy: GroupRetentionState, nowEpochMs: number
): GroupRetentionObservation | 'expired' {
    const stored = authority.group;
    if (!stored) throw new TypeError('Temporary room lifetime requires the room predecessor');
    const group = stored.value;
    const live = computeGroupPresenceSummaryContent({
        ...authority,
        group: stored,
        current: authority.current ?? null
    }, nowEpochMs).activeSessionCount > 0;
    const schedule = readGroupSessionSchedule(group.metadata);
    const timing = schedule === null ? null : toGroupSessionTiming(schedule, nowEpochMs);
    const holdReleasedAtEpochMs = schedule === null || timing === null
        ? null
        : schedule.cancelledAtEpochMs ?? timing.reservationsExpireAtEpochMs;
    const heldForSession = timing !== null && timing.phase !== 'cancelled' &&
        nowEpochMs < timing.reservationsExpireAtEpochMs;
    if (live || heldForSession) {
        return { atEpochMs: null, fingerprint: null };
    }
    const fingerprint = computePresenceFingerprint(authority);
    const timelines = readRoomClocks(group.metadata).filter((clock): clock is RoomTimeline => 'phase' in clock);
    const paused = timelines.filter((timeline) => timeline.status === 'paused');
    const changedObservation = group.emptySinceEpochMs === null || policy.emptyPresenceFingerprint !== fingerprint ||
        (holdReleasedAtEpochMs !== null && group.emptySinceEpochMs < holdReleasedAtEpochMs);
    let emptySinceEpochMs = group.emptySinceEpochMs ?? nowEpochMs;
    if (paused.length > 0) {
        emptySinceEpochMs = Math.max(lastPresenceEnd(authority, group, nowEpochMs), holdReleasedAtEpochMs ?? 0);
    }
    else if (changedObservation) {
        emptySinceEpochMs = Math.max(nowEpochMs, emptySinceEpochMs);
    }
    const pausedRetentionMs = policy.pausedTimelineRetentionMs ?? DEFAULT_PAUSED_TIMELINE_RETENTION_MS;
    const withinGrace = paused.length > 0
        ? paused.some((timeline) => nowEpochMs - Math.max(timeline.pausedAtEpochMs ?? emptySinceEpochMs, emptySinceEpochMs) < pausedRetentionMs)
        : nowEpochMs - emptySinceEpochMs < policy.reconnectGraceMs;
    // A delayed worker must still be able to commit its successor after the original deadline.
    const waitingForSuccessor = timelines.some((timeline) => timeline.status === 'running' &&
        (timeline.successor || (timeline.startedBy === 'automatic' && nowEpochMs < timeline.endsAtEpochMs)));
    return withinGrace || waitingForSuccessor ? { atEpochMs: emptySinceEpochMs, fingerprint } : 'expired';
}

/** Use a recorded disconnect or its admission fence, bounded by the original lease.
 * Presence rows outlive the maximum paused window, so a purged row can no longer hold the room. */
function lastPresenceEnd(authority: GroupPresenceSummaryStoredRead, group: Group, nowEpochMs: number): number {
    const admissions = new Map(authority.admissions.map(({ value }) => [value.principalId, value]));
    return authority.presenceSessions.reduce((last, { value: session }) => {
        const admission = admissions.get(session.principalId);
        const revokedAt = isExactlyAdmitted(admission, session) ? null : admission?.updatedAtEpochMs;
        const departedAt = session.disconnectedAtEpochMs ?? revokedAt ?? session.expiresAtEpochMs;
        return Math.max(last, Math.min(session.expiresAtEpochMs, departedAt, nowEpochMs));
    }, group.created.atEpochMs);
}

function computePresenceFingerprint(authority: GroupPresenceSummaryStoredRead): string {
    const observations = [authority.members, authority.admissions, authority.presenceSessions].map((rows) =>
        rows.map(({ entry }) => ({ key: entry.key, revision: entry.revision }))
            .toSorted((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
    );
    return computeMutationCommandDigest(encodeJsonWireValue(observations));
}
