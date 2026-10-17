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
    /** The cheap probe: the current version of the value, or undefined when nothing is stored. */
    readonly readVersion: (key: K) => Promise<string | undefined>;
    readonly readValue: (key: K) => Promise<VersionProbedRead<V> | undefined>;
    readonly toCacheKey: (key: K) => string;
    readonly nowEpochMs: () => number;
    readonly maxEntries: number;
}

interface VersionedEntry<V> {
    readonly version: string;
    readonly value: V;
}

/**
 * A read-through cache that serves a kept value only while the store still reports the version that value was read
 * at: a key with a kept value costs one probe when unchanged and a probe plus a read when changed, and a key with none
 * costs one read. A value is kept under the version its own read reported, never a probe's, so a write that lands
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
        const cacheKey = this.dependencies.toCacheKey(key);
        const nowEpochMs = this.dependencies.nowEpochMs();
        const cached = this.entries.readAt(cacheKey, nowEpochMs);
        if (cached !== undefined && await this.dependencies.readVersion(key) === cached.version) {
            return cached.value;
        }
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
