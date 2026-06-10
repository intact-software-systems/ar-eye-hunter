import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { RepositoryToken } from '@shared/cache/RepositoryToken.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type { AppDataConditionalRepositoryLike, AppDataEntry, AppDataRepositoryLike, } from './AppDataRepository.ts';
import { isAppDataConditionalRepository } from './AppDataRepository.ts';

export type RallarServerAppDataMigrationContext = Readonly<{
    key: string;
    fromVersion: number;
    toVersion: number;
    updatedAtEpochMs?: number;
}>;

export type RallarServerAppDataMigration<V> = (
    persistedValue: unknown,
    context: RallarServerAppDataMigrationContext,
) => V | Promise<V>;

export type RallarServerAppDataReadConsistency = 'fresh' | 'cache-first';

export type RallarServerAppDataStoreOptions<V = unknown> = Readonly<{
    namespace?: string;
    keyPrefix?: string;
    ttlMs?: number;
    schemaVersion?: number;
    readConsistency?: RallarServerAppDataReadConsistency;
    maxConflictRetries?: number;
    migrate?: RallarServerAppDataMigration<V>;
    expireAtFor?: (value: V) => number;
}>;

export type RallarServerAppDataStoreDefinition<V = unknown> = Readonly<{
    name: string;
    options?: RallarServerAppDataStoreOptions<V>;
}>;

export type RallarServerAppDataOptions = Readonly<{
    repository?: AppDataRepositoryLike;
}>;

type NormalizedAppDataStoreOptions<V> = Readonly<{
    namespace: string;
    keyPrefix: string;
    schemaVersion: number;
    readConsistency: RallarServerAppDataReadConsistency;
    maxConflictRetries: number;
    ttlMs?: number;
    migrate?: RallarServerAppDataMigration<V>;
    expireAtFor?: (value: V) => number;
}>;

type CachedAppDataValue<V> = Readonly<{
    value: V;
    expireAtTimestamp: number;
}>;

type PreparedAppDataStore<V> = Readonly<{
    token: RepositoryToken<RallarServerAppDataStore<V>>;
    name: string;
    options: NormalizedAppDataStoreOptions<V>;
    optionsKey: string;
}>;

type OptimisticAttemptResult<T> =
    | Readonly<{
    done: true;
    value: T;
}>
    | Readonly<{
    done: false;
}>;

const DEFAULT_NAMESPACE = 'app';
const DEFAULT_MAX_CONFLICT_RETRIES = 5;

export class RallarServerAppDataConflictError extends Error {
    constructor(
        readonly operation: string,
        readonly key: string,
        readonly maxAttempts: number,
    ) {
        super(
            `Rallar server app data ${operation} conflicted for key ${key} after ${maxAttempts} attempts.`,
        );
        this.name = 'RallarServerAppDataConflictError';
    }
}

export function isRallarServerAppDataConflictError(
    error: unknown,
): error is RallarServerAppDataConflictError {
    return error instanceof RallarServerAppDataConflictError;
}

export class RallarServerAppDataFacade {
    constructor(
        private readonly manager: RepositoryManager,
        private readonly repository?: AppDataRepositoryLike,
    ) {
    }

    define<V>(
        name: string,
        options?: RallarServerAppDataStoreOptions<V>,
    ): RallarServerAppDataStoreDefinition<V> {
        assertStoreName(name);
        return {
            name,
            options,
        };
    }

    async open<V>(
        input: string | RallarServerAppDataStoreDefinition<V>,
        options?: RallarServerAppDataStoreOptions<V>,
    ): Promise<RallarServerAppDataStore<V>> {
        const repository = this.requireRepository();
        const prepared = prepareAppDataStore(input, options);
        const existing = this.manager.get(prepared.token);
        if (existing) {
            assertOptionsMatch(existing, prepared);
            return existing;
        }

        const created = new RallarServerAppDataStore<V>(
            repository,
            prepared.name,
            prepared.options,
            prepared.optionsKey,
            prepared.token.id,
        );
        this.manager.set(prepared.token, created);
        return created;
    }

    lookup<V>(
        input: string | RallarServerAppDataStoreDefinition<V>,
        options?: RallarServerAppDataStoreOptions<V>,
    ): RallarServerAppDataStore<V> | undefined {
        const prepared = prepareAppDataStore(input, options);
        const existing = this.manager.get(prepared.token);
        if (existing) {
            assertOptionsMatch(existing, prepared);
        }

        return existing;
    }

    async close<V>(
        input: string | RallarServerAppDataStoreDefinition<V>,
        options?: RallarServerAppDataStoreOptions<V>,
    ): Promise<boolean> {
        const prepared = prepareAppDataStore(input, options);
        return await this.manager.delete(prepared.token);
    }

    private requireRepository(): AppDataRepositoryLike {
        if (!this.repository) {
            throw new Error('Rallar server app data repository is not configured.');
        }

        return this.repository;
    }
}

export class RallarServerAppDataStore<V> {
    private readonly cache = new Map<string, CachedAppDataValue<V>>();
    private hydrated = false;

    constructor(
        private readonly repository: AppDataRepositoryLike,
        public readonly name: string,
        private readonly options: NormalizedAppDataStoreOptions<V>,
        public readonly optionsKey: string,
        public readonly repositoryId: string,
    ) {
    }

    get namespace(): string {
        return this.options.namespace;
    }

    read(key: string): V | undefined {
        assertDataKey(key);
        const cached = this.cache.get(key);
        if (!cached) {
            return undefined;
        }

        if (isExpired(cached.expireAtTimestamp)) {
            this.cache.delete(key);
            return undefined;
        }

        return cached.value;
    }

    async hydrate(): Promise<void> {
        const entries = await this.repository.findEntries(
            this.options.namespace,
            this.name,
            this.options.keyPrefix || undefined,
        );
        this.cache.clear();

        for (const entry of entries) {
            await this.cacheLiveEntry(entry);
        }

        this.hydrated = true;
    }

    isHydrated(): boolean {
        return this.hydrated;
    }

    async get(key: string): Promise<V | undefined> {
        assertDataKey(key);
        if (this.options.readConsistency === 'cache-first') {
            const cached = this.read(key);
            if (cached !== undefined) {
                return cached;
            }
        }

        return await this.getFresh(key);
    }

    private async getFresh(key: string): Promise<V | undefined> {
        const storageKey = this.toStorageKey(key);
        const entry = await this.repository.findEntry(
            this.options.namespace,
            this.name,
            storageKey,
        );

        if (!entry) {
            this.cache.delete(key);
            return undefined;
        }

        return await this.cacheLiveEntry(entry);
    }

    async getEntries(): Promise<Array<readonly [string, V]>> {
        const entries = await this.repository.findEntries(
            this.options.namespace,
            this.name,
            this.options.keyPrefix || undefined,
        );
        const values: Array<readonly [string, V]> = [];
        this.cache.clear();

        for (const entry of entries) {
            const value = await this.cacheLiveEntry(entry);
            if (value !== undefined) {
                values.push([this.toPublicKey(entry.key), value]);
            }
        }

        this.hydrated = true;
        return values;
    }

    readEntries(): Array<readonly [string, V]> {
        const entries: Array<readonly [string, V]> = [];
        for (const [key, cached] of this.cache.entries()) {
            if (isExpired(cached.expireAtTimestamp)) {
                this.cache.delete(key);
                continue;
            }

            entries.push([key, cached.value]);
        }

        return entries;
    }

    readAllValues(): V[] {
        return this.readEntries().map(([, value]) => value);
    }

    async getAll(): Promise<V[]> {
        return (await this.getEntries()).map(([, value]) => value);
    }

    async listKeys(): Promise<string[]> {
        return (await this.getEntries()).map(([key]) => key);
    }

    keys(): string[] {
        return this.readEntries().map(([key]) => key);
    }

    async exportData(): Promise<Record<string, V>> {
        return Object.fromEntries(await this.getEntries()) as Record<string, V>;
    }

    async set(key: string, value: V): Promise<void> {
        assertDataKey(key);
        const input = this.toUpsertInput(key, value);
        await this.repository.upsert(input);
        this.cache.set(key, {
            value,
            expireAtTimestamp: input.expireAtTimestamp,
        });
    }

    async updateOrCreate(
        key: string,
        updater: (current: V | undefined) => V,
    ): Promise<V> {
        const conditional = this.conditionalRepository();
        if (conditional) {
            return await this.withOptimisticRetry<V>('updateOrCreate', key, async () => {
                const currentEntry = await this.findLiveEntry(key);
                const current = currentEntry
                    ? (await this.toValue(this.toPublicKey(currentEntry.key), currentEntry)).value
                    : undefined;
                const next = updater(current);
                const input = this.toUpsertInput(key, next);

                if (!currentEntry) {
                    const result = await conditional.insertIfAbsent(input);
                    if (result.status === 'inserted') {
                        return {
                            done: true,
                            value: await this.cacheWrittenEntry(result.entry, next),
                        };
                    }

                    await this.cacheConflictEntry(result.current);
                    return { done: false };
                }

                const result = await conditional.upsertIfRevision({
                    ...input,
                    expectedRevision: currentEntry.revision,
                });
                if (result.status === 'written') {
                    return {
                        done: true,
                        value: await this.cacheWrittenEntry(result.entry, next),
                    };
                }

                await this.cacheConflictEntry(result.current);
                return { done: false };
            });
        }

        const next = updater(await this.get(key));
        await this.set(key, next);
        return next;
    }

    async update(key: string, updater: (current: V) => V): Promise<V | undefined> {
        const conditional = this.conditionalRepository();
        if (conditional) {
            return await this.withOptimisticRetry<V | undefined>('update', key, async () => {
                const currentEntry = await this.findLiveEntry(key);
                if (!currentEntry) {
                    return {
                        done: true,
                        value: undefined,
                    };
                }

                const current = (await this.toValue(
                    this.toPublicKey(currentEntry.key),
                    currentEntry,
                )).value;
                const next = updater(current);
                const result = await conditional.upsertIfRevision({
                    ...this.toUpsertInput(key, next),
                    expectedRevision: currentEntry.revision,
                });
                if (result.status === 'written') {
                    return {
                        done: true,
                        value: await this.cacheWrittenEntry(result.entry, next),
                    };
                }

                await this.cacheConflictEntry(result.current);
                return { done: false };
            });
        }

        const current = await this.get(key);
        if (current === undefined) {
            return undefined;
        }

        const next = updater(current);
        await this.set(key, next);
        return next;
    }

    async setIfAbsent(key: string, creator: () => V): Promise<V> {
        const conditional = this.conditionalRepository();
        if (conditional) {
            return await this.withOptimisticRetry<V>('setIfAbsent', key, async () => {
                const currentEntry = await this.findLiveEntry(key);
                if (currentEntry) {
                    return {
                        done: true,
                        value: await this.cacheLiveEntry(currentEntry) as V,
                    };
                }

                const created = creator();
                const result = await conditional.insertIfAbsent(
                    this.toUpsertInput(key, created),
                );
                if (result.status === 'inserted') {
                    return {
                        done: true,
                        value: await this.cacheWrittenEntry(result.entry, created),
                    };
                }

                if (result.current && !isExpired(result.current.expireAtTimestamp)) {
                    return {
                        done: true,
                        value: await this.cacheLiveEntry(result.current) as V,
                    };
                }

                await this.cacheConflictEntry(result.current);
                return { done: false };
            });
        }

        const current = await this.get(key);
        if (current !== undefined) {
            return current;
        }

        const created = creator();
        await this.set(key, created);
        return created;
    }

    async compareAndSet(
        key: string,
        expected: V | undefined,
        update: V,
    ): Promise<boolean> {
        const conditional = this.conditionalRepository();
        if (conditional) {
            return await this.withOptimisticRetry<boolean>('compareAndSet', key, async () => {
                const currentEntry = await this.findLiveEntry(key);
                if (!currentEntry) {
                    if (expected !== undefined) {
                        return {
                            done: true,
                            value: false,
                        };
                    }

                    const result = await conditional.insertIfAbsent(
                        this.toUpsertInput(key, update),
                    );
                    if (result.status === 'inserted') {
                        await this.cacheWrittenEntry(result.entry, update);
                        return {
                            done: true,
                            value: true,
                        };
                    }

                    await this.cacheConflictEntry(result.current);
                    return { done: false };
                }

                const current = (await this.toValue(
                    this.toPublicKey(currentEntry.key),
                    currentEntry,
                )).value;
                if (!appDataValuesEqual(current, expected)) {
                    await this.cacheLiveEntry(currentEntry);
                    return {
                        done: true,
                        value: false,
                    };
                }

                const result = await conditional.upsertIfRevision({
                    ...this.toUpsertInput(key, update),
                    expectedRevision: currentEntry.revision,
                });
                if (result.status === 'written') {
                    await this.cacheWrittenEntry(result.entry, update);
                    return {
                        done: true,
                        value: true,
                    };
                }

                await this.cacheConflictEntry(result.current);
                return { done: false };
            });
        }

        const current = await this.get(key);
        if (!appDataValuesEqual(current, expected)) {
            return false;
        }

        await this.set(key, update);
        return true;
    }

    async getAndSet(key: string, update: V): Promise<V | undefined> {
        const conditional = this.conditionalRepository();
        if (conditional) {
            return await this.withOptimisticRetry<V | undefined>('getAndSet', key, async () => {
                const currentEntry = await this.findLiveEntry(key);
                if (!currentEntry) {
                    const result = await conditional.insertIfAbsent(
                        this.toUpsertInput(key, update),
                    );
                    if (result.status === 'inserted') {
                        await this.cacheWrittenEntry(result.entry, update);
                        return {
                            done: true,
                            value: undefined,
                        };
                    }

                    await this.cacheConflictEntry(result.current);
                    return { done: false };
                }

                const current = (await this.toValue(
                    this.toPublicKey(currentEntry.key),
                    currentEntry,
                )).value;
                const result = await conditional.upsertIfRevision({
                    ...this.toUpsertInput(key, update),
                    expectedRevision: currentEntry.revision,
                });
                if (result.status === 'written') {
                    await this.cacheWrittenEntry(result.entry, update);
                    return {
                        done: true,
                        value: current,
                    };
                }

                await this.cacheConflictEntry(result.current);
                return { done: false };
            });
        }

        const current = await this.get(key);
        await this.set(key, update);
        return current;
    }

    async delete(key: string): Promise<boolean> {
        assertDataKey(key);
        this.cache.delete(key);
        return await this.repository.deleteByKey(
            this.options.namespace,
            this.name,
            this.toStorageKey(key),
        );
    }

    async deleteExpired(): Promise<number> {
        for (const [key, cached] of this.cache.entries()) {
            if (isExpired(cached.expireAtTimestamp)) {
                this.cache.delete(key);
            }
        }

        return await this.repository.deleteExpired(this.options.namespace, this.name);
    }

    private conditionalRepository(): AppDataConditionalRepositoryLike | undefined {
        return isAppDataConditionalRepository(this.repository)
            ? this.repository
            : undefined;
    }

    private async withOptimisticRetry<T>(
        operation: string,
        key: string,
        attempt: () => Promise<OptimisticAttemptResult<T>>,
    ): Promise<T> {
        const maxAttempts = this.options.maxConflictRetries + 1;
        for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
            const result = await attempt();
            if (result.done) {
                return result.value;
            }
        }

        throw new RallarServerAppDataConflictError(operation, key, maxAttempts);
    }

    private async findLiveEntry(key: string): Promise<AppDataEntry | undefined> {
        const storageKey = this.toStorageKey(key);
        const entry = await this.repository.findEntry(
            this.options.namespace,
            this.name,
            storageKey,
        );
        if (!entry) {
            this.cache.delete(key);
            return undefined;
        }

        if (!isExpired(entry.expireAtTimestamp)) {
            return entry;
        }

        await this.deleteExpiredEntry(entry);
        this.cache.delete(key);
        return undefined;
    }

    private async deleteExpiredEntry(entry: AppDataEntry): Promise<void> {
        const conditional = this.conditionalRepository();
        if (conditional) {
            const result = await conditional.deleteIfRevision(
                entry.namespace,
                entry.storeName,
                entry.key,
                entry.revision,
            );
            if (result.status === 'conflict') {
                await this.cacheConflictEntry(result.current);
            }
            return;
        }

        await this.repository.deleteByKey(
            this.options.namespace,
            this.name,
            entry.key,
        );
    }

    private async cacheConflictEntry(entry: AppDataEntry | undefined): Promise<void> {
        if (!entry) {
            return;
        }

        const publicKey = this.toPublicKey(entry.key);
        if (isExpired(entry.expireAtTimestamp)) {
            this.cache.delete(publicKey);
            return;
        }

        await this.cacheLiveEntry(entry);
    }

    private async cacheWrittenEntry(
        entry: AppDataEntry,
        fallbackValue: V,
    ): Promise<V> {
        return await this.cacheLiveEntry(entry) ?? fallbackValue;
    }

    private toUpsertInput(key: string, value: V) {
        return {
            namespace: this.options.namespace,
            storeName: this.name,
            key: this.toStorageKey(key),
            value,
            schemaVersion: this.options.schemaVersion,
            expireAtTimestamp: this.toExpireAtTimestamp(value),
        };
    }

    private async cacheLiveEntry(entry: AppDataEntry): Promise<V | undefined> {
        if (isExpired(entry.expireAtTimestamp)) {
            await this.deleteExpiredEntry(entry);
            this.cache.delete(this.toPublicKey(entry.key));
            return undefined;
        }

        const publicKey = this.toPublicKey(entry.key);
        const migrated = await this.toValue(publicKey, entry);
        if (migrated.schemaVersion !== entry.schemaVersion) {
            const migratedEntry = await this.persistMigratedEntry(
                entry,
                migrated.value,
                migrated.schemaVersion,
            );
            if (migratedEntry) {
                return await this.cacheLiveEntry(migratedEntry);
            }
        }

        this.cache.set(publicKey, {
            value: migrated.value,
            expireAtTimestamp: entry.expireAtTimestamp,
        });
        return migrated.value;
    }

    private async persistMigratedEntry(
        entry: AppDataEntry,
        value: V,
        schemaVersion: number,
    ): Promise<AppDataEntry | undefined> {
        const conditional = this.conditionalRepository();
        if (conditional) {
            const result = await conditional.upsertIfRevision({
                namespace: this.options.namespace,
                storeName: this.name,
                key: entry.key,
                value,
                schemaVersion,
                expireAtTimestamp: entry.expireAtTimestamp,
                expectedRevision: entry.revision,
            });
            if (result.status === 'written') {
                return result.entry;
            }

            await this.cacheConflictEntry(result.current);
            return result.current;
        }

        await this.repository.upsert({
            namespace: this.options.namespace,
            storeName: this.name,
            key: entry.key,
            value,
            schemaVersion,
            expireAtTimestamp: entry.expireAtTimestamp,
        });
        return undefined;
    }

    private async toValue(
        key: string,
        entry: AppDataEntry,
    ): Promise<Readonly<{ value: V; schemaVersion: number }>> {
        if (entry.schemaVersion === this.options.schemaVersion) {
            return {
                value: entry.value as V,
                schemaVersion: entry.schemaVersion,
            };
        }

        if (!this.options.migrate) {
            return {
                value: entry.value as V,
                schemaVersion: entry.schemaVersion,
            };
        }

        return {
            value: await this.options.migrate(entry.value, {
                key,
                fromVersion: entry.schemaVersion,
                toVersion: this.options.schemaVersion,
                updatedAtEpochMs: Date.parse(entry.updatedTimestamp),
            }),
            schemaVersion: this.options.schemaVersion,
        };
    }

    private toExpireAtTimestamp(value: V): number {
        const expireAtTimestamp = this.options.expireAtFor?.(value) ??
            (
                this.options.ttlMs === undefined
                    ? NEVER_EXPIRE_AT_TIMESTAMP
                    : Date.now() + this.options.ttlMs
            );
        if (!Number.isFinite(expireAtTimestamp)) {
            throw new Error('Rallar server app data expire timestamp must be finite.');
        }

        return expireAtTimestamp;
    }

    private toStorageKey(key: string): string {
        assertDataKey(key);
        return `${this.options.keyPrefix}${key}`;
    }

    private toPublicKey(storageKey: string): string {
        return this.options.keyPrefix && storageKey.startsWith(this.options.keyPrefix)
            ? storageKey.slice(this.options.keyPrefix.length)
            : storageKey;
    }
}

function prepareAppDataStore<V>(
    input: string | RallarServerAppDataStoreDefinition<V>,
    options?: RallarServerAppDataStoreOptions<V>,
): PreparedAppDataStore<V> {
    const name = typeof input === 'string' ? input : input.name;
    assertStoreName(name);
    const normalized = normalizeOptions(
        typeof input === 'string'
            ? options
            : {
                ...input.options,
                ...options,
            },
    );
    const id = toRepositoryId(name, normalized);
    const optionsKey = JSON.stringify({
        repositoryId: id,
        namespace: normalized.namespace,
        keyPrefix: normalized.keyPrefix,
        schemaVersion: normalized.schemaVersion,
        readConsistency: normalized.readConsistency,
        maxConflictRetries: normalized.maxConflictRetries,
        ttlMs: normalized.ttlMs,
        hasMigrate: normalized.migrate !== undefined,
        hasExpireAtFor: normalized.expireAtFor !== undefined,
    });

    return {
        token: new RepositoryToken(id, () => {
            throw new Error('Rallar server app data stores are created by the facade.');
        }),
        name,
        options: normalized,
        optionsKey,
    };
}

function normalizeOptions<V>(
    options: RallarServerAppDataStoreOptions<V> = {},
): NormalizedAppDataStoreOptions<V> {
    const schemaVersion = options.schemaVersion ?? 1;
    if (!Number.isInteger(schemaVersion) || schemaVersion < 0) {
        throw new Error('Rallar server app data schemaVersion must be a non-negative integer.');
    }

    if (
        options.ttlMs !== undefined &&
        (!Number.isFinite(options.ttlMs) || options.ttlMs < 0)
    ) {
        throw new Error('Rallar server app data ttlMs must be a non-negative finite number.');
    }

    const readConsistency = options.readConsistency ?? 'fresh';
    if (
        readConsistency !== 'fresh' &&
        readConsistency !== 'cache-first'
    ) {
        throw new Error(
            'Rallar server app data readConsistency must be "fresh" or "cache-first".',
        );
    }

    const maxConflictRetries =
        options.maxConflictRetries ?? DEFAULT_MAX_CONFLICT_RETRIES;
    if (
        !Number.isInteger(maxConflictRetries) ||
        maxConflictRetries < 0
    ) {
        throw new Error(
            'Rallar server app data maxConflictRetries must be a non-negative integer.',
        );
    }

    const namespace = options.namespace ?? DEFAULT_NAMESPACE;
    assertNamespace(namespace);

    return {
        namespace,
        keyPrefix: options.keyPrefix ?? '',
        schemaVersion,
        readConsistency,
        maxConflictRetries,
        ttlMs: options.ttlMs,
        migrate: options.migrate,
        expireAtFor: options.expireAtFor,
    };
}

function assertOptionsMatch<V>(
    existing: RallarServerAppDataStore<V>,
    prepared: Pick<PreparedAppDataStore<V>, 'optionsKey' | 'name'>,
): void {
    if (existing.optionsKey === prepared.optionsKey) {
        return;
    }

    throw new Error(
        `Rallar server app data store already opened with different options: ${prepared.name}`,
    );
}

function toRepositoryId(
    name: string,
    options: Pick<
        NormalizedAppDataStoreOptions<unknown>,
        'namespace' | 'keyPrefix'
    >,
): string {
    return [
        'rallar-server-app-data',
        encodeURIComponent(options.namespace),
        encodeURIComponent(name),
        encodeURIComponent(options.keyPrefix),
    ].join(':');
}

function assertStoreName(name: string): void {
    if (!name.trim()) {
        throw new Error('Rallar server app data store name is required.');
    }
}

function assertDataKey(key: string): void {
    if (!key.trim()) {
        throw new Error('Rallar server app data key is required.');
    }
}

function assertNamespace(namespace: string): void {
    if (!namespace.trim()) {
        throw new Error('Rallar server app data namespace is required.');
    }
}

function isExpired(expireAtTimestamp: number): boolean {
    return !Number.isFinite(expireAtTimestamp) || expireAtTimestamp <= Date.now();
}

function appDataValuesEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) {
        return true;
    }

    try {
        return JSON.stringify(left) === JSON.stringify(right);
    } catch {
        return false;
    }
}
