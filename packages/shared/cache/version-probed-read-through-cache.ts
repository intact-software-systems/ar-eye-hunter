import { LatestRepository } from './LatestRepository.ts';

/** What the cheap probe tells about the stored value without reading it. */
export interface VersionProbe {
    readonly version: string;
    /** Null when only a write can change the value; otherwise the first instant it may read differently. */
    readonly validUntilEpochMs: number | null;
}

/** A full read of the value and the instant it stays valid until, null when only a write can change it. */
export interface VersionProbedRead<V> {
    readonly value: V;
    readonly validUntilEpochMs: number | null;
}

export interface VersionProbedReadThroughCacheDependencies<K, V> {
    /** Undefined when nothing is stored for the key. */
    readonly readVersion: (key: K) => Promise<VersionProbe | undefined>;
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
 * A read-through cache whose every read asks the store for the current version first: an
 * unchanged version is served from memory, any other version reads the value again. A full read
 * is kept only when a second probe after it finds the first probe's version, so a write landing
 * around the read is never served under a version it does not belong to.
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
        const probed = await this.dependencies.readVersion(key);
        const nowEpochMs = this.dependencies.nowEpochMs();
        const cached = this.entries.readAt(cacheKey, nowEpochMs);
        if (probed !== undefined && cached?.version === probed.version) {
            return cached.value;
        }
        const read = await this.dependencies.readValue(key);
        const confirmed = read === undefined ? undefined : await this.dependencies.readVersion(key);
        if (read === undefined || probed === undefined || confirmed?.version !== probed.version) {
            this.entries.take(cacheKey);
            return read?.value;
        }
        const validUntilEpochMs = toEarliestInstant(read.validUntilEpochMs, confirmed.validUntilEpochMs);
        this.entries.acceptAt({
            key: cacheKey,
            value: { version: probed.version, value: read.value },
            nowEpochMs,
            ...(validUntilEpochMs === null ? {} : { expireAtEpochMs: validUntilEpochMs })
        });
        return read.value;
    }
}

function toEarliestInstant(left: number | null, right: number | null): number | null {
    if (left === null) {
        return right;
    }
    return right === null ? left : Math.min(left, right);
}
