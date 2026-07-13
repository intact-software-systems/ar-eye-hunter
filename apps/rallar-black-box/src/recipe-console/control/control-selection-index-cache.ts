import {
    controlSnapshotSelectionIndexWorkForTest,
    createControlSnapshotSelectionIndex,
    type ControlSnapshotSelectionIndex,
    type ControlSnapshotSelectionIndexWork,
} from '@shared-test/rallar-bb-test/control-snapshot-selection-index.ts';
import type { ControlServerSnapshot } from
    '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    controlSnapshotRevisionOf,
    type ControlSnapshotRevision,
} from './control-snapshot-revision.ts';

export type ControlSelectionIndexCache = Readonly<{
    get(snapshot: ControlServerSnapshot): ControlSnapshotSelectionIndex;
}>;

export type ControlSelectionIndexCacheLookupWork = Readonly<{
    cacheHit: boolean;
    indexBuildCount: number;
    controlRunVisitCount: number;
    distributedRunVisitCount: number;
    selectionIndexLoopVisitCount: number;
}>;

export type ControlSelectionIndexCacheWork = Readonly<{
    lookupCount: number;
    hitCount: number;
    missCount: number;
    indexBuildCount: number;
    lastLookup: ControlSelectionIndexCacheLookupWork;
}>;

type CacheEntry =
    | Readonly<{
        kind: 'revision';
        revision: ControlSnapshotRevision;
        index: ControlSnapshotSelectionIndex;
    }>
    | Readonly<{
        kind: 'identity';
        snapshot: WeakRef<ControlServerSnapshot>;
        index: ControlSnapshotSelectionIndex;
    }>;

type MutableCacheWork = {
    lookupCount: number;
    hitCount: number;
    missCount: number;
    indexBuildCount: number;
    lastLookup: ControlSelectionIndexCacheLookupWork;
};

const workByCache = new WeakMap<object, ControlSelectionIndexCacheWork>();

/** A revision-aware, one-entry cache. It never strongly retains a snapshot. */
export function createControlSelectionIndexCache(): ControlSelectionIndexCache {
    let entry: CacheEntry | undefined;
    const work: MutableCacheWork = {
        lookupCount: 0,
        hitCount: 0,
        missCount: 0,
        indexBuildCount: 0,
        lastLookup: emptyLookupWork(false),
    };
    const cache: ControlSelectionIndexCache = Object.freeze({
        get(snapshot: ControlServerSnapshot): ControlSnapshotSelectionIndex {
            work.lookupCount += 1;
            const revision = controlSnapshotRevisionOf(snapshot);
            const hit = revision
                ? entry?.kind === 'revision' && entry.revision === revision
                : entry?.kind === 'identity' && entry.snapshot.deref() === snapshot;
            if (hit && entry) {
                work.hitCount += 1;
                work.lastLookup = emptyLookupWork(true);
                publishWork(cache, work);
                return entry.index;
            }

            const index = createControlSnapshotSelectionIndex(snapshot);
            const indexWork = controlSnapshotSelectionIndexWorkForTest(index);
            work.missCount += 1;
            work.indexBuildCount += 1;
            work.lastLookup = {
                cacheHit: false,
                indexBuildCount: 1,
                controlRunVisitCount: indexWork?.controlRunVisitCount ?? 0,
                distributedRunVisitCount: indexWork?.distributedRunVisitCount ?? 0,
                selectionIndexLoopVisitCount: indexWork
                    ? selectionIndexLoopVisitCount(indexWork)
                    : 0,
            };
            entry = revision
                ? { kind: 'revision', revision, index }
                : { kind: 'identity', snapshot: new WeakRef(snapshot), index };
            publishWork(cache, work);
            return index;
        },
    });
    publishWork(cache, work);
    return cache;
}

export function controlSelectionIndexCacheWorkForTest(
    cache: ControlSelectionIndexCache,
): ControlSelectionIndexCacheWork | undefined {
    return workByCache.get(cache);
}

function selectionIndexLoopVisitCount(
    work: ControlSnapshotSelectionIndexWork,
): number {
    return work.controlRunVisitCount +
        work.controlAgentVisitCount +
        work.controlAgentSortedOrdinalProjectionVisitCount +
        work.controlCommandVisitCount +
        work.controlRunUpdatedOrderProjectionVisitCount +
        work.distributedRunVisitCount +
        work.activeDistributedRunProjectionVisitCount +
        work.distributedTargetAgentVisitCount +
        work.distributedCommandLinkVisitCount +
        work.manifestRoleAssignmentVisitCount +
        work.targetResolutionRoleAssignmentVisitCount +
        work.distributedUpdatedOrderProjectionVisitCount +
        work.boardWinnerVisitCount +
        work.boardTargetAgentVisitCount;
}

function emptyLookupWork(cacheHit: boolean): ControlSelectionIndexCacheLookupWork {
    return Object.freeze({
        cacheHit,
        indexBuildCount: 0,
        controlRunVisitCount: 0,
        distributedRunVisitCount: 0,
        selectionIndexLoopVisitCount: 0,
    });
}

function publishWork(
    cache: ControlSelectionIndexCache,
    work: MutableCacheWork,
): void {
    workByCache.set(cache, Object.freeze({
        lookupCount: work.lookupCount,
        hitCount: work.hitCount,
        missCount: work.missCount,
        indexBuildCount: work.indexBuildCount,
        lastLookup: Object.freeze({ ...work.lastLookup }),
    }));
}
