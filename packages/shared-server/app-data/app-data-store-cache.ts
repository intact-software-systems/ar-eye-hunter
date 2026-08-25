import { readAppDataEntries } from './app-data-entry-reader.ts';
import type { AppDataEntry, AppDataRepository } from './app-data-repository.ts';
import {
    assertAppDataKey,
    toAppDataPublicKey,
    toAppDataStorageKey,
    type AppDataStoreConfiguration
} from './app-data-store-definition.ts';
import { decodeCurrentAppDataValue } from './app-data-value-codec.ts';

interface CachedAppDataValue<V> {
    readonly value: V;
    readonly expireAtTimestamp: number;
}

interface DecodedAppDataEntry<V> extends CachedAppDataValue<V> {
    readonly publicKey: string;
}

export namespace AppDataStoreCache {
    export interface Dependencies<V> {
        readonly repository: AppDataRepository;
        readonly storeName: string;
        readonly configuration: AppDataStoreConfiguration<V>;
        readonly nowEpochMs: () => number;
    }
}

export class AppDataStoreCache<V> {
    private cache = new Map<string, CachedAppDataValue<V>>();
    private hydrated = false;

    private readonly repository: AppDataRepository;
    private readonly storeName: string;
    private readonly configuration: AppDataStoreConfiguration<V>;
    private readonly nowEpochMs: () => number;

    constructor(dependencies: AppDataStoreCache.Dependencies<V>) {
        this.repository = dependencies.repository;
        this.storeName = dependencies.storeName;
        this.configuration = dependencies.configuration;
        this.nowEpochMs = dependencies.nowEpochMs;
    }

    read(key: string): V | undefined {
        assertAppDataKey(key);
        const cached = this.cache.get(key);
        if (!cached) {
            return undefined;
        }
        if (this.isExpired(cached.expireAtTimestamp)) {
            this.cache.delete(key);
            return undefined;
        }
        return cached.value;
    }

    readEntries(): Array<readonly [string, V]> {
        const entries: Array<readonly [string, V]> = [];
        for (const [key, cached] of this.cache.entries()) {
            if (this.isExpired(cached.expireAtTimestamp)) {
                this.cache.delete(key);
                continue;
            }
            entries.push([key, cached.value]);
        }
        return entries;
    }

    isHydrated(): boolean {
        return this.hydrated;
    }

    async hydrate(): Promise<void> {
        await this.refreshAllEntries();
    }

    async get(key: string): Promise<V | undefined> {
        assertAppDataKey(key);
        if (this.configuration.readConsistency === 'cache-first') {
            const cached = this.read(key);
            if (cached !== undefined) {
                return cached;
            }
        }
        return await this.getFresh(key);
    }

    async getEntries(): Promise<Array<readonly [string, V]>> {
        return await this.refreshAllEntries();
    }

    async findLiveEntry(key: string): Promise<AppDataEntry | undefined> {
        const entry = await this.repository.findEntry({
            namespace: this.configuration.namespace,
            storeName: this.storeName,
            key: toAppDataStorageKey(this.configuration, key)
        });
        if (!entry) {
            this.cache.delete(key);
            return undefined;
        }
        if (!this.isExpired(entry.expireAtTimestamp)) {
            return entry;
        }

        const replacement = await this.deleteExpiredEntry(entry);
        this.cache.delete(key);
        return replacement && !this.isExpired(replacement.expireAtTimestamp)
            ? replacement
            : undefined;
    }

    cacheKnownValue(key: string, value: V, expireAtTimestamp: number): void {
        this.cache.set(key, { value, expireAtTimestamp });
    }

    cacheWrittenEntry(entry: AppDataEntry): V {
        const publicKey = toAppDataPublicKey(this.configuration, entry.key);
        const value = decodeCurrentAppDataValue(this.configuration.codec, entry);
        if (this.isExpired(entry.expireAtTimestamp)) {
            this.cache.delete(publicKey);
            return value;
        }
        this.cache.set(publicKey, {
            value,
            expireAtTimestamp: entry.expireAtTimestamp
        });
        return value;
    }

    cacheConflictEntry(key: string, entry: AppDataEntry | undefined): void {
        if (!entry || this.isExpired(entry.expireAtTimestamp)) {
            this.cache.delete(key);
            return;
        }
        const decoded = this.decodeLiveEntry(entry);
        if (decoded) {
            this.cache.set(decoded.publicKey, decoded);
        }
    }

    delete(key: string): void {
        this.cache.delete(key);
    }

    deleteExpiredValues(): void {
        for (const [key, cached] of this.cache.entries()) {
            if (this.isExpired(cached.expireAtTimestamp)) {
                this.cache.delete(key);
            }
        }
    }

    private async getFresh(key: string): Promise<V | undefined> {
        const entry = await this.findLiveEntry(key);
        if (!entry) {
            return undefined;
        }
        const decoded = this.decodeLiveEntry(entry);
        if (!decoded) {
            return undefined;
        }
        this.cache.set(key, decoded);
        return decoded.value;
    }

    private async refreshAllEntries(): Promise<Array<readonly [string, V]>> {
        const nextCache = new Map<string, CachedAppDataValue<V>>();
        const entries: Array<readonly [string, V]> = [];
        for await (
            const entry of readAppDataEntries({
                repository: this.repository,
                namespace: this.configuration.namespace,
                storeName: this.storeName,
                keyPrefix: this.configuration.keyPrefix || undefined
            })
        ) {
            const decoded = await this.decodeRepositoryEntry(entry);
            if (!decoded) {
                continue;
            }
            nextCache.set(decoded.publicKey, decoded);
            entries.push([decoded.publicKey, decoded.value]);
        }
        this.cache = nextCache;
        this.hydrated = true;
        return entries;
    }

    private async decodeRepositoryEntry(entry: AppDataEntry): Promise<DecodedAppDataEntry<V> | undefined> {
        if (!this.isExpired(entry.expireAtTimestamp)) {
            return this.decodeLiveEntry(entry);
        }
        const replacement = await this.deleteExpiredEntry(entry);
        return replacement && !this.isExpired(replacement.expireAtTimestamp)
            ? this.decodeLiveEntry(replacement)
            : undefined;
    }

    private decodeLiveEntry(entry: AppDataEntry): DecodedAppDataEntry<V> | undefined {
        if (this.isExpired(entry.expireAtTimestamp)) {
            return undefined;
        }
        return {
            publicKey: toAppDataPublicKey(this.configuration, entry.key),
            value: decodeCurrentAppDataValue(this.configuration.codec, entry),
            expireAtTimestamp: entry.expireAtTimestamp
        };
    }

    private async deleteExpiredEntry(entry: AppDataEntry): Promise<AppDataEntry | undefined> {
        const result = await this.repository.deleteIfRevision({
            namespace: entry.namespace,
            storeName: entry.storeName,
            key: entry.key,
            expectedRevision: entry.revision
        });
        return result.status === 'conflict' ? result.current : undefined;
    }

    private isExpired(expireAtTimestamp: number): boolean {
        return !Number.isFinite(expireAtTimestamp) || expireAtTimestamp <= this.nowEpochMs();
    }
}
