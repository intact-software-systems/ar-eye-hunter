import { toCanonicalGroupRef, type GroupRef, type GroupSnapshot } from '@shared/api/group-types.ts';
import { ObservableValueEventType } from '@shared/cache/RepositoryInterfaces.ts';
import type { GroupStateSnapshotChange } from './group-state-snapshots-repository.ts';

/** Which revision of which group a runtime's group cache now holds, or the revision it no longer holds. */
export interface GroupStateAppliedRevision {
    readonly group: GroupRef;
    readonly groupRevision: number;
    readonly presenceRevision: number;
    readonly rosterVersion: number;
    readonly activeSessionCount: number;
    readonly change: 'held' | 'removed';
}

export type GroupStateAppliedRevisionSink = (revision: GroupStateAppliedRevision) => void;

export function createPassThroughGroupStateAppliedRevisionSink(): GroupStateAppliedRevisionSink {
    return () => {};
}

/** Undefined for a lease refresh and for a replacement that changes neither the causal revision nor the session count. */
export function toGroupStateAppliedRevision(change: GroupStateSnapshotChange): GroupStateAppliedRevision | undefined {
    if (change.kind === ObservableValueEventType.Refreshed) {
        return undefined;
    }
    if (change.kind === ObservableValueEventType.Deleted) {
        return change.previous ? toAppliedRevision(change.previous, 'removed') : undefined;
    }
    if (!change.snapshot) {
        return undefined;
    }
    const held = toAppliedRevision(change.snapshot, 'held');
    if (change.previous && isSameAppliedRevision(toAppliedRevision(change.previous, 'held'), held)) {
        return undefined;
    }
    return held;
}

function toAppliedRevision(
    snapshot: GroupSnapshot,
    change: GroupStateAppliedRevision['change']
): GroupStateAppliedRevision {
    return {
        group: toCanonicalGroupRef(snapshot.group),
        groupRevision: snapshot.causalRevision.groupRevision,
        presenceRevision: snapshot.causalRevision.presenceRevision,
        rosterVersion: snapshot.group.rosterVersion,
        activeSessionCount: snapshot.activeSessions.length,
        change
    };
}

function isSameAppliedRevision(left: GroupStateAppliedRevision, right: GroupStateAppliedRevision): boolean {
    return left.groupRevision === right.groupRevision &&
        left.presenceRevision === right.presenceRevision &&
        left.activeSessionCount === right.activeSessionCount;
}
