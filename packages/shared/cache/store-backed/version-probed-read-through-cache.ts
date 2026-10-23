import { LatestRepository } from '../LatestRepository.ts';

/** A full read of the value with the version of exactly what it read, from the same read. */
export interface VersionProbedRead<V> {
    readonly value: V;
    /** Null when the read could not name its version; such a value is returned but never kept. */
    readonly version: string | null;
    /** Null when only a write can change the value; otherwise the first instant it may read differently. */
    readonly validUntilEpochMs: number | null;
}

export interface VersionProbedReadThroughCacheDependencies<K, V> {
    /** The cheap probe, in one store read: each key's current version in key order, or undefined when nothing is stored. */
    readonly readVersions: (keys: readonly K[]) => Promise<readonly (string | undefined)[]>;
    readonly readValue: (key: K) => Promise<VersionProbedRead<V> | undefined>;
    readonly toCacheKey: (key: K) => string;
    readonly nowEpochMs: () => number;
    readonly maxEntries: number;
}

/** The values in key order, with the store reads the call issued: the one probe, if any, and each full read. */
export interface VersionProbedReads<V> {
    readonly values: readonly (V | undefined)[];
    readonly probes: number;
    readonly reads: number;
}

interface VersionedEntry<V> {
    readonly version: string;
    readonly value: V;
}

/**
 * A read-through cache that serves a kept value only while the store still reports the version that value was read
 * at: the keys with a kept value cost one probe together when unchanged, a changed key adds a read, and a key with
 * none costs one read. A value is kept under the version its own read reported, never a probe's, so a write that lands
 * before or during the read cannot be served under an older version.
 */
export class VersionProbedReadThroughCache<K, V> {
    private readonly dependencies: VersionProbedReadThroughCacheDependencies<K, V>;
    private readonly entries: LatestRepository<string, VersionedEntry<V>>;

    public constructor(dependencies: VersionProbedReadThroughCacheDependencies<K, V>) {
        this.dependencies = dependencies;
        this.entries = new LatestRepository<string, VersionedEntry<V>>({ maxEntries: dependencies.maxEntries });
    }

    public async read(key: K): Promise<V | undefined> {
        const [value] = (await this.readMany([key])).values;
        return value;
    }

    /** The values kept, including any past their valid instant that no read or eviction sweep has removed yet. */
    public size(): number {
        return this.entries.size();
    }

    /** The values in key order; every kept key is probed by one store read, and changed or unkept keys are read in order. */
    public async readMany(keys: readonly K[]): Promise<VersionProbedReads<V>> {
        const nowEpochMs = this.dependencies.nowEpochMs();
        const cacheKeys = keys.map((key) => this.dependencies.toCacheKey(key));
        const kept = cacheKeys.map((cacheKey) => this.entries.readAt(cacheKey, nowEpochMs));
        const currentVersions = await this.readKeptVersions(keys, kept);
        const values: (V | undefined)[] = [];
        let reads = 0;
        for (const [index, key] of keys.entries()) {
            const entry = kept[index];
            if (entry !== undefined && currentVersions[index] === entry.version) {
                values.push(entry.value);
                continue;
            }
            reads += 1;
            values.push(await this.readThrough(key, cacheKeys[index]!, nowEpochMs));
        }
        return { values, probes: kept.some((entry) => entry !== undefined) ? 1 : 0, reads };
    }

    private async readKeptVersions(
        keys: readonly K[],
        kept: readonly (VersionedEntry<V> | undefined)[]
    ): Promise<readonly (string | undefined)[]> {
        const probedKeys = keys.filter((_, index) => kept[index] !== undefined);
        if (probedKeys.length === 0) {
            return [];
        }
        const versions = await this.dependencies.readVersions(probedKeys);
        if (versions.length !== probedKeys.length) {
            throw new TypeError(`Version probe returned ${versions.length} versions for ${probedKeys.length} keys`);
        }
        let probed = 0;
        return kept.map((entry) => entry === undefined ? undefined : versions[probed++]);
    }

    private async readThrough(key: K, cacheKey: string, nowEpochMs: number): Promise<V | undefined> {
        const read = await this.dependencies.readValue(key);
        if (read === undefined || read.version === null) {
            this.entries.take(cacheKey);
            return read?.value;
        }
        this.entries.acceptAt({
            key: cacheKey,
            value: { version: read.version, value: read.value },
            nowEpochMs,
            ...(read.validUntilEpochMs === null ? {} : { expireAtEpochMs: read.validUntilEpochMs })
        });
        return read.value;
    }
}
