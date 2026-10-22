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
 * How a surface may grow during the run, and the bound its predicate holds it to.
 * - `durable`: one row per entity; its growth may not exceed `rowsPerEntity` per entity the entity reader counts new.
 * - `declared-append-only`: a durable-by-design history R3 declares and reports; its growth is reported, never
 *   passed or failed.
 * - `unbounded`: nothing bounds it; it fails a run in which it grows, and is a follow-up when it never grew.
 */
export type V1dGrowthClassification =
    | Readonly<{ growthClass: 'count-capped'; cap: number; }>
    | Readonly<{ growthClass: 'ttl-within-run'; ttlMs: number; sweepMs: number; }>
    | Readonly<{ growthClass: 'ttl-beyond-run'; ttlMs: number; }>
    | Readonly<{ growthClass: 'durable'; entity: string; entityReader: V1dGrowthReader; rowsPerEntity: number; }>
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
