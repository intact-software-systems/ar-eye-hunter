/** Where a growth reading comes from: one sample file of the growth proof's run directory each. */
export type V1dGrowthSampleSource =
    | 'postgres'
    | 'admin-system'
    | 'admin-queues'
    | 'admin-realtime'
    | 'api-heap'
    | 'process-rss'
    | 'browser-stats';

/** One numeric reading: the value at `path` inside each sample of `source`. A `length` step reads an array's length. */
export interface V1dGrowthReader {
    readonly source: V1dGrowthSampleSource;
    readonly path: readonly string[];
    /**
     * `zero` where the reading is a key of a count map that omits a key with no rows: a missing key whose map is
     * present reads as zero. `no-reading` where a missing value means the sample did not carry the reading.
     */
    readonly absent: 'zero' | 'no-reading';
    /**
     * Where the same sample counts this reading's rows stamped never to expire; null where the store stamps none. A
     * time-to-live class fails when that count rises, so a store that writes rows without expiry cannot pass on a TTL.
     */
    readonly neverExpiringPath: readonly string[] | null;
}

/**
 * What a durable surface's entities are.
 * - `samples`: a count the same samples carry, read by `reader`; the surface grows with the entities counted new.
 * - `registrations`: the accounts the run registered, from its workload: `principalsPerChurnIteration` for each churn
 *   iteration started and one for each manifest agent. No reading may exceed the `ceiling` reading of its sample.
 */
export type V1dGrowthEntityCount =
    | Readonly<{ source: 'samples'; reader: V1dGrowthReader; }>
    | Readonly<{ source: 'registrations'; principalsPerChurnIteration: number; ceiling: V1dGrowthReader; }>;

/**
 * How a surface may grow during the run, and the bound its predicate holds it to.
 * - `durable`: one row per entity; its growth may not exceed `rowsPerEntity` per entity.
 * - `declared-append-only`: a durable-by-design history R3 declares and reports; its growth is reported, never
 *   passed or failed.
 * - `heap`: flat after a warm-up. A browser page heap is judged on 5-minute bucket medians, since no forced
 *   collection settles its GC sawtooth; a forced-GC process heap and a resident set on their raw readings.
 * - `unbounded`: nothing bounds it; it fails a run in which it grows, and is a follow-up when it never grew.
 */
export type V1dGrowthClassification =
    | Readonly<{ growthClass: 'count-capped'; cap: number; }>
    | Readonly<{ growthClass: 'ttl-within-run'; ttlMs: number; sweepMs: number; }>
    | Readonly<{ growthClass: 'ttl-beyond-run'; ttlMs: number; }>
    | Readonly<{ growthClass: 'durable'; entity: string; entityCount: V1dGrowthEntityCount; rowsPerEntity: number; }>
    | Readonly<{ growthClass: 'declared-append-only'; history: string; }>
    | Readonly<{ growthClass: 'heap'; }>
    | Readonly<{ growthClass: 'unbounded'; missingBound: string; }>;

export type V1dGrowthClass = V1dGrowthClassification['growthClass'];

/** One growth surface: the survey's row number, what grows, who owns it, its class and every reading of it. */
export interface V1dGrowthSurface {
    readonly id: number;
    readonly name: string;
    readonly owner: string;
    readonly classification: V1dGrowthClassification;
    readonly readers: readonly V1dGrowthReader[];
}
