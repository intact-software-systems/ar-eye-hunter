import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { serializeCanonicalMutationCommand } from '../rallar-system/protocol/json-wire-identity.ts';
import type { AppDataEntry, AppDataRepository, AppDataUpsertInput } from './app-data-repository.ts';
import { AppDataStoreCache } from './app-data-store-cache.ts';
import type { AppDataStoreConfiguration } from './app-data-store-definition.ts';
import { assertAppDataKey, toAppDataStorageKey } from './app-data-store-definition.ts';
import { decodeCurrentAppDataValue, encodeAppDataValue } from './app-data-value-codec.ts';
import { RallarServerAppDataConflictError } from './rallar-server-app-data-conflict-error.ts';

interface OptimisticAttemptDone<T> {
    readonly done: true;
    readonly value: T;
}

interface OptimisticAttemptConflict {
    readonly done: false;
}

type OptimisticAttemptResult<T> = OptimisticAttemptDone<T> | OptimisticAttemptConflict;

export namespace AppDataOptimisticWriter {
    export interface Dependencies<V> {
        readonly repository: AppDataRepository;
        readonly storeName: string;
        readonly configuration: AppDataStoreConfiguration<V>;
        readonly cache: AppDataStoreCache<V>;
        readonly nowEpochMs: () => number;
    }
}

export class AppDataOptimisticWriter<V> {
    private readonly repository: AppDataRepository;
    private readonly storeName: string;
    private readonly configuration: AppDataStoreConfiguration<V>;
    private readonly cache: AppDataStoreCache<V>;
    private readonly nowEpochMs: () => number;

    constructor(dependencies: AppDataOptimisticWriter.Dependencies<V>) {
        this.repository = dependencies.repository;
        this.storeName = dependencies.storeName;
        this.configuration = dependencies.configuration;
        this.cache = dependencies.cache;
        this.nowEpochMs = dependencies.nowEpochMs;
    }

    async set(key: string, value: V): Promise<void> {
        assertAppDataKey(key);
        const input = this.toUpsertInput(key, value);
        await this.repository.upsert(input);
        if (input.expireAtTimestamp <= this.nowEpochMs()) {
            this.cache.delete(key);
            return;
        }
        this.cache.cacheKnownValue(key, value, input.expireAtTimestamp);
    }

    async updateOrCreate(key: string, updater: (current: V | undefined) => V): Promise<V> {
        return await this.withOptimisticRetry('updateOrCreate', key, async () => {
            const currentEntry = await this.cache.findLiveEntry(key);
            const next = updater(this.decodeEntry(currentEntry));
            const input = this.toUpsertInput(key, next);
            if (!currentEntry) {
                const result = await this.repository.insertIfAbsent(input);
                if (result.status === 'inserted') {
                    return this.completed(this.cache.cacheWrittenEntry(result.entry));
                }
                this.cache.cacheConflictEntry(key, result.current);
                return { done: false };
            }

            const result = await this.repository.upsertIfRevision({
                ...input,
                expectedRevision: currentEntry.revision
            });
            if (result.status === 'written') {
                return this.completed(this.cache.cacheWrittenEntry(result.entry));
            }
            this.cache.cacheConflictEntry(key, result.current);
            return { done: false };
        });
    }

    async update(key: string, updater: (current: V) => V): Promise<V | undefined> {
        return await this.withOptimisticRetry('update', key, async () => {
            const currentEntry = await this.cache.findLiveEntry(key);
            if (!currentEntry) {
                return this.completed(undefined);
            }
            const next = updater(decodeCurrentAppDataValue(this.configuration.codec, currentEntry));
            const result = await this.repository.upsertIfRevision({
                ...this.toUpsertInput(key, next),
                expectedRevision: currentEntry.revision
            });
            if (result.status === 'written') {
                return this.completed(this.cache.cacheWrittenEntry(result.entry));
            }
            this.cache.cacheConflictEntry(key, result.current);
            return { done: false };
        });
    }

    async setIfAbsent(key: string, creator: () => V): Promise<V> {
        return await this.withOptimisticRetry('setIfAbsent', key, async () => {
            const currentEntry = await this.cache.findLiveEntry(key);
            if (currentEntry) {
                return this.completed(this.cache.cacheWrittenEntry(currentEntry));
            }

            const result = await this.repository.insertIfAbsent(
                this.toUpsertInput(key, creator())
            );
            if (result.status === 'inserted') {
                return this.completed(this.cache.cacheWrittenEntry(result.entry));
            }
            if (result.current && result.current.expireAtTimestamp > this.nowEpochMs()) {
                return this.completed(this.cache.cacheWrittenEntry(result.current));
            }
            this.cache.cacheConflictEntry(key, result.current);
            return { done: false };
        });
    }

    async compareAndSet(key: string, expected: V | undefined, update: V): Promise<boolean> {
        return await this.withOptimisticRetry('compareAndSet', key, async () => {
            const currentEntry = await this.cache.findLiveEntry(key);
            if (!currentEntry) {
                if (expected !== undefined) {
                    return this.completed(false);
                }
                const result = await this.repository.insertIfAbsent(
                    this.toUpsertInput(key, update)
                );
                if (result.status === 'inserted') {
                    this.cache.cacheWrittenEntry(result.entry);
                    return this.completed(true);
                }
                this.cache.cacheConflictEntry(key, result.current);
                return { done: false };
            }

            const current = decodeCurrentAppDataValue(this.configuration.codec, currentEntry);
            if (!this.valuesEqual(current, expected)) {
                this.cache.cacheWrittenEntry(currentEntry);
                return this.completed(false);
            }
            const result = await this.repository.upsertIfRevision({
                ...this.toUpsertInput(key, update),
                expectedRevision: currentEntry.revision
            });
            if (result.status === 'written') {
                this.cache.cacheWrittenEntry(result.entry);
                return this.completed(true);
            }
            this.cache.cacheConflictEntry(key, result.current);
            return { done: false };
        });
    }

    async getAndSet(key: string, update: V): Promise<V | undefined> {
        return await this.withOptimisticRetry('getAndSet', key, async () => {
            const currentEntry = await this.cache.findLiveEntry(key);
            if (!currentEntry) {
                const result = await this.repository.insertIfAbsent(
                    this.toUpsertInput(key, update)
                );
                if (result.status === 'inserted') {
                    this.cache.cacheWrittenEntry(result.entry);
                    return this.completed(undefined);
                }
                this.cache.cacheConflictEntry(key, result.current);
                return { done: false };
            }

            const current = decodeCurrentAppDataValue(this.configuration.codec, currentEntry);
            const result = await this.repository.upsertIfRevision({
                ...this.toUpsertInput(key, update),
                expectedRevision: currentEntry.revision
            });
            if (result.status === 'written') {
                this.cache.cacheWrittenEntry(result.entry);
                return this.completed(current);
            }
            this.cache.cacheConflictEntry(key, result.current);
            return { done: false };
        });
    }

    async delete(key: string): Promise<boolean> {
        assertAppDataKey(key);
        this.cache.delete(key);
        return await this.repository.deleteByKey({
            namespace: this.configuration.namespace,
            storeName: this.storeName,
            key: toAppDataStorageKey(this.configuration, key)
        });
    }

    async deleteExpired(): Promise<number> {
        const nowEpochMs = this.nowEpochMs();
        this.cache.deleteExpiredValues();
        return await this.repository.deleteExpired({
            namespace: this.configuration.namespace,
            storeName: this.storeName,
            expireAtOrBeforeTimestamp: nowEpochMs
        });
    }

    private async withOptimisticRetry<T>(
        operation: string,
        key: string,
        attempt: () => Promise<OptimisticAttemptResult<T>>
    ): Promise<T> {
        assertAppDataKey(key);
        const maxAttempts = this.configuration.maxConflictRetries + 1;
        for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
            const result = await attempt();
            if (result.done) {
                return result.value;
            }
        }
        throw new RallarServerAppDataConflictError({ operation, key, maxAttempts });
    }

    private toUpsertInput(key: string, value: V): AppDataUpsertInput {
        return {
            namespace: this.configuration.namespace,
            storeName: this.storeName,
            key: toAppDataStorageKey(this.configuration, key),
            value: encodeAppDataValue(this.configuration.codec, value),
            schemaVersion: this.configuration.codec.schemaVersion,
            expireAtTimestamp: this.toExpireAtTimestamp(value)
        };
    }

    private toExpireAtTimestamp(value: V): number {
        const expireAtTimestamp = this.configuration.expireAtFor?.(value) ?? (
            this.configuration.ttlMs === undefined
                ? NEVER_EXPIRE_AT_TIMESTAMP
                : this.nowEpochMs() + this.configuration.ttlMs
        );
        if (!Number.isFinite(expireAtTimestamp)) {
            throw new Error('Rallar server app data expire timestamp must be finite.');
        }
        return expireAtTimestamp;
    }

    private decodeEntry(entry: AppDataEntry | undefined): V | undefined {
        return entry
            ? decodeCurrentAppDataValue(this.configuration.codec, entry)
            : undefined;
    }

    private valuesEqual(left: V | undefined, right: V | undefined): boolean {
        if (left === undefined || right === undefined) {
            return left === right;
        }
        return serializeCanonicalMutationCommand(encodeAppDataValue(this.configuration.codec, left)) ===
            serializeCanonicalMutationCommand(encodeAppDataValue(this.configuration.codec, right));
    }

    private completed<T>(value: T): OptimisticAttemptDone<T> {
        return { done: true, value };
    }
}
