import type { ControlServerSnapshot } from
    '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { AnalyzeTuneArtifactFacade } from
    '../analyze/analyze-worker-contract.ts';
import { controlSnapshotRevisionOf } from
    '../control/control-snapshot-revision.ts';
import {
    buildTuneRunCatalog,
    type TuneRunCatalog,
} from './tune-run-catalog.ts';
import {
    createTuneRunCatalogWork,
    type TuneRunCatalogWork,
} from './tune-run-catalog-work.ts';

export type TuneRunCatalogCacheInput = Readonly<{
    snapshot?: ControlServerSnapshot;
    retainedFacade?: AnalyzeTuneArtifactFacade;
    performanceRunIds: readonly string[];
}>;

export type TuneRunCatalogCacheLookupWork = Readonly<{
    cacheHit: boolean;
    catalogBuildCount: number;
    build: TuneRunCatalogWork;
}>;

export type TuneRunCatalogCacheWork = Readonly<{
    lookupCount: number;
    hitCount: number;
    missCount: number;
    catalogBuildCount: number;
    lastLookup: TuneRunCatalogCacheLookupWork;
}>;

export type TuneRunCatalogCache = Readonly<{
    get(input: TuneRunCatalogCacheInput): TuneRunCatalog;
}>;

type CacheEntry = Readonly<{
    snapshotKey: object;
    retainedFacade?: AnalyzeTuneArtifactFacade;
    performanceRunIds: readonly string[];
    catalog: TuneRunCatalog;
}>;

type MutableCacheWork = {
    lookupCount: number;
    hitCount: number;
    missCount: number;
    catalogBuildCount: number;
    lastLookup: TuneRunCatalogCacheLookupWork;
};

const EMPTY_SNAPSHOT_KEY = Object.freeze({});
const workByCache = new WeakMap<object, TuneRunCatalogCacheWork>();

/** Keeps one exact control revision and never revalidates clone-equivalent polls. */
export function createTuneRunCatalogCache(): TuneRunCatalogCache {
    let entry: CacheEntry | undefined;
    const work: MutableCacheWork = {
        lookupCount: 0,
        hitCount: 0,
        missCount: 0,
        catalogBuildCount: 0,
        lastLookup: emptyLookup(true),
    };
    const cache: TuneRunCatalogCache = Object.freeze({
        get(input: TuneRunCatalogCacheInput): TuneRunCatalog {
            work.lookupCount += 1;
            const snapshotKey = controlSnapshotRevisionOf(input.snapshot) ??
                input.snapshot ?? EMPTY_SNAPSHOT_KEY;
            const hit = entry?.snapshotKey === snapshotKey &&
                entry.retainedFacade === input.retainedFacade &&
                sameIds(entry.performanceRunIds, input.performanceRunIds);
            if (hit && entry) {
                work.hitCount += 1;
                work.lastLookup = emptyLookup(true);
                publish(cache, work);
                return entry.catalog;
            }
            const catalog = buildTuneRunCatalog({
                controlRuns: input.snapshot?.runs ?? [],
                distributedRuns: input.snapshot?.distributedRuns ?? [],
                retainedFacade: input.retainedFacade,
                performanceRunIds: input.performanceRunIds,
            });
            work.missCount += 1;
            work.catalogBuildCount += 1;
            work.lastLookup = {
                cacheHit: false,
                catalogBuildCount: 1,
                build: catalog.work,
            };
            entry = {
                snapshotKey,
                ...(input.retainedFacade === undefined
                    ? {}
                    : { retainedFacade: input.retainedFacade }),
                performanceRunIds: [...input.performanceRunIds],
                catalog,
            };
            publish(cache, work);
            return catalog;
        },
    });
    publish(cache, work);
    return cache;
}

export function tuneRunCatalogCacheWorkForTest(
    cache: TuneRunCatalogCache,
): TuneRunCatalogCacheWork | undefined {
    return workByCache.get(cache);
}

function emptyLookup(cacheHit: boolean): TuneRunCatalogCacheLookupWork {
    return {
        cacheHit,
        catalogBuildCount: 0,
        build: createTuneRunCatalogWork(),
    };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length &&
        left.every((value, index) => value === right[index]);
}

function publish(cache: object, work: MutableCacheWork): void {
    workByCache.set(cache, {
        lookupCount: work.lookupCount,
        hitCount: work.hitCount,
        missCount: work.missCount,
        catalogBuildCount: work.catalogBuildCount,
        lastLookup: work.lastLookup,
    });
}
