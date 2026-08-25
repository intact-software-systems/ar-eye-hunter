import {
    broadcastRallarDataClear,
    clearManagedRallarDataRepository,
    estimateBrowserStorage,
    RepositoryBackedRallarDataStore
} from '@shared-web/browser/data/repository-backed-rallar-data-store.ts';
import type { ValueEqualityChecker } from '@shared/cache/ObservableLatestValue.ts';
import {
    type ObservableKeyedValueEvent,
    type ObservableKeyedValueListener
} from '@shared/cache/RepositoryInterfaces.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { RepositoryToken } from '@shared/cache/RepositoryToken.ts';
import {
    WriteBehindObservableLatestRepository,
    type PersistenceErrorHandler
} from '@shared/cache/WriteBehindObservableLatestRepository.ts';
import { WriteThroughObservableLatestRepository } from '@shared/cache/WriteThroughObservableLatestRepository.ts';
import { IndexedDbStringPersistenceProvider } from '@shared/persistence/IndexedDbStringPersistenceProvider.ts';
import type { PersistenceProvider, PersistenceSetItemOptions } from '@shared/persistence/PersistenceProvider.ts';

export type RallarDataScope = 'app' | 'principal' | 'session' | string;

export type RallarDataDurability = 'write-through' | 'write-behind';

export type RallarDataHydration = 'eager' | 'lazy';

export type RallarDataChangeEvent<V> = ObservableKeyedValueEvent<string, V>;

export type RallarDataChangeListener<V> = ObservableKeyedValueListener<string, V>;

export type RallarDataMigrationContext = Readonly<{
    key: string;
    fromVersion: number;
    toVersion: number;
    updatedAtEpochMs?: number;
}>;

export type RallarDataMigration<V> = (
    persistedValue: unknown,
    context: RallarDataMigrationContext
) => V | Promise<V>;

export type RallarDataStorageEstimate = Readonly<{
    usage?: number;
    quota?: number;
}>;

export type RallarDataStoreOptions<V> = Readonly<{
    scope?: RallarDataScope;
    dbName?: string;
    storeName?: string;
    keyPrefix?: string;
    ttlMs?: number;
    durability?: RallarDataDurability;
    hydrate?: RallarDataHydration;
    schemaVersion?: number;
    migrate?: RallarDataMigration<V>;
    sync?: boolean;
    isValid?: (value: V) => boolean;
    equals?: ValueEqualityChecker<V>;
    expireAtFor?: (value: V) => number;
    onPersistenceError?: PersistenceErrorHandler<string, V>;
}>;

export type RallarDataStoreDefinition<V> = Readonly<{
    name: string;
    options?: RallarDataStoreOptions<V>;
}>;

export type RallarDataStore<V> = Readonly<{
    name: string;
    repositoryId: string;
    hydrate(): Promise<void>;
    whenHydrated(): Promise<void>;
    isHydrated(): boolean;
    whenIdle(): Promise<void>;
    flush(): Promise<void>;
    read(key: string): V | undefined;
    get(key: string): Promise<V | undefined>;
    readEntries(): Array<readonly [string, V]>;
    readAllValues(): V[];
    getEntries(): Promise<Array<readonly [string, V]>>;
    getAll(): Promise<V[]>;
    listKeys(): Promise<string[]>;
    keys(): string[];
    exportData(): Promise<Record<string, V>>;
    set(key: string, value: V): Promise<void>;
    update(key: string, updater: (current: V) => V): Promise<V | undefined>;
    updateOrCreate(
        key: string,
        updater: (current: V | undefined) => V
    ): Promise<V>;
    setIfAbsent(key: string, creator: () => V): Promise<V>;
    compareAndSet(
        key: string,
        expect: V | undefined,
        update: V
    ): Promise<boolean>;
    getAndSet(key: string, update: V): Promise<V | undefined>;
    delete(key: string): Promise<boolean>;
    deleteExpired(): Promise<number>;
    clear(): Promise<void>;
    clearAll(): Promise<void>;
    close(): Promise<boolean>;
    destroy(): Promise<void>;
    estimateUsage(): Promise<RallarDataStorageEstimate>;
    onChange(listener: RallarDataChangeListener<V>): RallarUnsubscribe;
}>;

export type RallarUnsubscribe = () => void;

export type RallarDataFacade = Readonly<{
    define<V>(
        name: string,
        options?: RallarDataStoreOptions<V>
    ): RallarDataStoreDefinition<V>;
    open<V>(
        input: string | RallarDataStoreDefinition<V>,
        options?: RallarDataStoreOptions<V>
    ): Promise<RallarDataStore<V>>;
    lookup<V>(
        input: string | RallarDataStoreDefinition<V>,
        options?: RallarDataStoreOptions<V>
    ): RallarDataStore<V> | undefined;
    close<V>(
        input: string | RallarDataStoreDefinition<V>,
        options?: RallarDataStoreOptions<V>
    ): Promise<boolean>;
    closeScope(scope: RallarDataScope): Promise<number>;
    clearScope(scope: RallarDataScope): Promise<number>;
    destroy<V>(
        input: string | RallarDataStoreDefinition<V>,
        options?: RallarDataStoreOptions<V>
    ): Promise<boolean>;
    destroyScope(scope: RallarDataScope): Promise<number>;
    estimateUsage(): Promise<RallarDataStorageEstimate>;
}>;

export type CreateRallarDataFacadeInput = Readonly<{
    manager: RepositoryManager;
    resolveScopeKey(scope: RallarDataScope): string;
}>;

type NormalizedRallarDataOptions<V> =
    & Required<
        Pick<
            RallarDataStoreOptions<V>,
            | 'scope'
            | 'dbName'
            | 'storeName'
            | 'keyPrefix'
            | 'durability'
            | 'hydrate'
            | 'schemaVersion'
            | 'sync'
        >
    >
    & Readonly<{
        scopeKey: string;
    }>
    & Omit<
        RallarDataStoreOptions<V>,
        | 'scope'
        | 'dbName'
        | 'storeName'
        | 'keyPrefix'
        | 'durability'
        | 'hydrate'
        | 'schemaVersion'
        | 'sync'
    >;

type PreparedRallarDataStore<V> = Readonly<{
    name: string;
    options: NormalizedRallarDataOptions<V>;
    optionsKey: string;
    token: RepositoryToken<RepositoryBackedRallarDataStore.Managed<V>>;
}>;

type RallarDataPersistedEnvelope = Readonly<{
    kind: 'rallar.custom-data';
    schemaVersion: number;
    updatedAtEpochMs: number;
    value: unknown;
}>;

const DEFAULT_CUSTOM_DATA_DB_NAME = 'rallar-custom-data';
const DEFAULT_CUSTOM_DATA_STORE_NAME = 'entries';
const RALLAR_DATA_ENVELOPE_KIND = 'rallar.custom-data';

export function createRallarDataFacade(
    input: CreateRallarDataFacadeInput
): RallarDataFacade {
    const stores = new RallarDataStoreLifecycle(input);
    return {
        define: defineRallarDataStore,
        open: stores.open,
        lookup: stores.lookup,
        close: stores.close,
        closeScope: stores.closeScope,
        clearScope: stores.clearScope,
        destroy: stores.destroy,
        destroyScope: stores.destroyScope,
        estimateUsage: estimateBrowserStorage
    };
}

class RallarDataStoreLifecycle {
    private readonly manager: RepositoryManager;
    private readonly resolveScopeKey: (scope: RallarDataScope) => string;
    private readonly activeTokens = new Map<string, RepositoryToken<unknown>>();

    public constructor(input: CreateRallarDataFacadeInput) {
        this.manager = input.manager;
        this.resolveScopeKey = input.resolveScopeKey;
    }

    public readonly open = async <V>(
        input: string | RallarDataStoreDefinition<V>,
        openOptions?: RallarDataStoreOptions<V>
    ): Promise<RallarDataStore<V>> => {
        const prepared = prepareRallarDataStore(
            input,
            openOptions,
            this.resolveScopeKey
        );
        const managed = getOrCreateManagedRepository(this.manager, prepared);
        this.activeTokens.set(prepared.token.id, prepared.token);
        const store = new RepositoryBackedRallarDataStore<V>(
            prepared.name,
            managed,
            () => closePreparedStore(this.manager, this.activeTokens, prepared)
        );

        if (prepared.options.hydrate === 'eager') {
            await store.hydrate();
        }

        return store;
    };

    public readonly lookup = <V>(
        input: string | RallarDataStoreDefinition<V>,
        lookupOptions?: RallarDataStoreOptions<V>
    ): RallarDataStore<V> | undefined => {
        const prepared = prepareRallarDataStore(
            input,
            lookupOptions,
            this.resolveScopeKey
        );
        const managed = this.manager.get(prepared.token);
        if (!managed) {
            return undefined;
        }

        assertOptionsMatch(managed, prepared);
        this.activeTokens.set(prepared.token.id, prepared.token);
        return new RepositoryBackedRallarDataStore<V>(
            prepared.name,
            managed,
            () => closePreparedStore(this.manager, this.activeTokens, prepared)
        );
    };

    public readonly close = async <V>(
        input: string | RallarDataStoreDefinition<V>,
        closeOptions?: RallarDataStoreOptions<V>
    ): Promise<boolean> => {
        const prepared = prepareRallarDataStore(
            input,
            closeOptions,
            this.resolveScopeKey
        );
        return await closePreparedStore(this.manager, this.activeTokens, prepared);
    };

    public readonly closeScope = async (
        scope: RallarDataScope
    ): Promise<number> => {
        return await this.forEachActiveScopeRepository(
            this.resolveScopeKey(scope),
            async (token) => await this.manager.delete(token)
        );
    };

    public readonly clearScope = async (
        scope: RallarDataScope
    ): Promise<number> => {
        return await this.forEachActiveScopeRepository(
            this.resolveScopeKey(scope),
            async (_token, managed) => {
                await clearManagedRallarDataRepository(managed);
                broadcastRallarDataClear(managed);
                return true;
            },
            false
        );
    };

    public readonly destroy = async <V>(
        input: string | RallarDataStoreDefinition<V>,
        destroyOptions?: RallarDataStoreOptions<V>
    ): Promise<boolean> => {
        const prepared = prepareRallarDataStore(
            input,
            destroyOptions,
            this.resolveScopeKey
        );
        return await destroyPreparedStore(
            this.manager,
            this.activeTokens,
            prepared
        );
    };

    public readonly destroyScope = async (
        scope: RallarDataScope
    ): Promise<number> => {
        return await this.forEachActiveScopeRepository(
            this.resolveScopeKey(scope),
            async (_token, managed) => {
                await clearManagedRallarDataRepository(managed);
                broadcastRallarDataClear(managed);
                return await this.manager.delete(_token);
            }
        );
    };

    private async forEachActiveScopeRepository(
        scopeKey: string,
        operation: (
            token: RepositoryToken<unknown>,
            managed: RepositoryBackedRallarDataStore.Managed<unknown>
        ) => Promise<boolean>,
        removeFromActive = true
    ): Promise<number> {
        let count = 0;

        for (const [id, token] of this.activeTokens) {
            const managed = this.manager.get(
                token as RepositoryToken<RepositoryBackedRallarDataStore.Managed<unknown>>
            );
            if (!managed || managed.scopeKey !== scopeKey) {
                continue;
            }

            if (await operation(token, managed)) {
                count += 1;
            }

            if (removeFromActive) {
                this.activeTokens.delete(id);
            }
        }

        return count;
    }
}

export function defineRallarDataStore<V>(
    name: string,
    options?: RallarDataStoreOptions<V>
): RallarDataStoreDefinition<V> {
    assertValidStoreName(name);
    return {
        name,
        options
    };
}

class RallarDataPersistenceProvider<V> implements PersistenceProvider<string, V> {
    private readonly inner: PersistenceProvider<string, unknown>;
    private readonly options: Pick<NormalizedRallarDataOptions<V>, 'schemaVersion' | 'migrate'>;

    public constructor(
        inner: PersistenceProvider<string, unknown>,
        options: Pick<NormalizedRallarDataOptions<V>, 'schemaVersion' | 'migrate'>
    ) {
        this.inner = inner;
        this.options = options;
    }

    public async getItem(key: string): Promise<V | undefined> {
        const persisted = await this.inner.getItem(key);
        if (persisted === undefined) {
            return undefined;
        }

        return await this.toValue(key, persisted);
    }

    public async setItem(
        key: string,
        value: V,
        options: PersistenceSetItemOptions
    ): Promise<void> {
        await this.inner.setItem(
            key,
            {
                kind: RALLAR_DATA_ENVELOPE_KIND,
                schemaVersion: this.options.schemaVersion,
                updatedAtEpochMs: Date.now(),
                value
            } satisfies RallarDataPersistedEnvelope,
            options
        );
    }

    public async removeItem(key: string): Promise<void> {
        await this.inner.removeItem(key);
    }

    public async getAllKeys(): Promise<string[]> {
        return await this.inner.getAllKeys();
    }

    public async deleteExpired(): Promise<number> {
        return await this.inner.deleteExpired();
    }

    private async toValue(key: string, persisted: unknown): Promise<V> {
        if (!isRallarDataEnvelope(persisted)) {
            return await this.migrateValue(key, persisted, 0, undefined);
        }

        if (persisted.schemaVersion === this.options.schemaVersion) {
            return persisted.value as V;
        }

        return await this.migrateValue(
            key,
            persisted.value,
            persisted.schemaVersion,
            persisted.updatedAtEpochMs
        );
    }

    private async migrateValue(
        key: string,
        persistedValue: unknown,
        fromVersion: number,
        updatedAtEpochMs: number | undefined
    ): Promise<V> {
        if (!this.options.migrate) {
            return persistedValue as V;
        }

        return await this.options.migrate(persistedValue, {
            key,
            fromVersion,
            toVersion: this.options.schemaVersion,
            updatedAtEpochMs
        });
    }
}

function prepareRallarDataStore<V>(
    input: string | RallarDataStoreDefinition<V>,
    options: RallarDataStoreOptions<V> | undefined,
    resolveScopeKey: (scope: RallarDataScope) => string
): PreparedRallarDataStore<V> {
    const name = typeof input === 'string' ? input : input.name;
    assertValidStoreName(name);

    const mergedOptions = {
        ...(typeof input === 'string' ? undefined : input.options),
        ...options
    };
    const normalizedOptions = normalizeRallarDataStoreOptions(
        name,
        mergedOptions,
        resolveScopeKey
    );
    const optionsKey = toOptionsKey(normalizedOptions);
    const token = new RepositoryToken<RepositoryBackedRallarDataStore.Managed<V>>(
        toRepositoryId(normalizedOptions),
        () => createManagedRepository(name, normalizedOptions, optionsKey)
    );

    return {
        name,
        options: normalizedOptions,
        optionsKey,
        token
    };
}

function normalizeRallarDataStoreOptions<V>(
    name: string,
    options: RallarDataStoreOptions<V>,
    resolveScopeKey: (scope: RallarDataScope) => string
): NormalizedRallarDataOptions<V> {
    const scope = options.scope ?? 'app';
    const scopeKey = resolveScopeKey(scope);
    const keyPrefix = options.keyPrefix ??
        `custom:${encodeURIComponent(scopeKey)}:${encodeURIComponent(name)}`;
    const schemaVersion = options.schemaVersion ?? 1;

    if (!Number.isInteger(schemaVersion) || schemaVersion < 0) {
        throw new Error(
            'Rallar data schemaVersion must be a non-negative integer.'
        );
    }

    return {
        ...options,
        scope,
        scopeKey,
        dbName: options.dbName ?? DEFAULT_CUSTOM_DATA_DB_NAME,
        storeName: options.storeName ?? DEFAULT_CUSTOM_DATA_STORE_NAME,
        keyPrefix,
        durability: options.durability ?? 'write-through',
        hydrate: options.hydrate ?? 'eager',
        schemaVersion,
        sync: options.sync ?? true
    };
}

function getOrCreateManagedRepository<V>(
    manager: RepositoryManager,
    prepared: PreparedRallarDataStore<V>
): RepositoryBackedRallarDataStore.Managed<V> {
    const existing = manager.get(prepared.token);
    if (existing) {
        assertOptionsMatch(existing, prepared);
        return existing;
    }

    const created = prepared.token.create();
    manager.set(prepared.token, created);
    return created;
}

function assertOptionsMatch<V>(
    managed: RepositoryBackedRallarDataStore.Managed<V>,
    prepared: Pick<PreparedRallarDataStore<V>, 'optionsKey' | 'token'>
): void {
    if (managed.optionsKey === prepared.optionsKey) {
        return;
    }

    throw new Error(
        `Rallar data store already opened with different options: ${prepared.token.id}`
    );
}

function createManagedRepository<V>(
    name: string,
    options: NormalizedRallarDataOptions<V>,
    optionsKey: string
): RepositoryBackedRallarDataStore.Managed<V> {
    const rawPersistence = new IndexedDbStringPersistenceProvider<unknown>({
        dbName: options.dbName,
        storeName: options.storeName,
        keyPrefix: options.keyPrefix
    });
    const persistence = new RallarDataPersistenceProvider<V>(rawPersistence, {
        schemaVersion: options.schemaVersion,
        migrate: options.migrate
    });
    const id = toRepositoryId(options);
    const base = {
        name,
        id,
        optionsKey,
        scope: options.scope,
        scopeKey: options.scopeKey,
        durability: options.durability,
        persistence,
        instanceId: crypto.randomUUID()
    };

    const repository = options.durability === 'write-behind'
        ? new WriteBehindObservableLatestRepository<string, V>({
            persistence,
            ttlMs: options.ttlMs,
            isValid: options.isValid,
            equals: options.equals,
            expireAtFor: options.expireAtFor,
            onPersistenceError: options.onPersistenceError
        })
        : new WriteThroughObservableLatestRepository<string, V>({
            persistence,
            ttlMs: options.ttlMs,
            isValid: options.isValid,
            equals: options.equals,
            expireAtFor: options.expireAtFor
        });

    const managed: RepositoryBackedRallarDataStore.Managed<V> = {
        ...base,
        repository,
        async dispose(): Promise<void> {
            managed.broadcast?.close();
            managed.broadcast = undefined;
            await repository.dispose();
        }
    };

    installBroadcastChannel(managed, options.sync);
    return managed;
}

function installBroadcastChannel<V>(
    managed: RepositoryBackedRallarDataStore.Managed<V>,
    sync: boolean
): void {
    if (!sync || typeof BroadcastChannel === 'undefined') {
        return;
    }

    const channel = new BroadcastChannel(`rallar-data:${managed.id}`);
    channel.onmessage = (event: MessageEvent) => {
        const message = event.data as Partial<RepositoryBackedRallarDataStore.BroadcastMessage<V>>;
        if (
            message.version !== 1 ||
            message.repositoryId !== managed.id ||
            message.instanceId === managed.instanceId
        ) {
            return;
        }

        void applyRemoteChange(managed, message).catch((error) => {
            console.error('Error applying remote Rallar data change', error);
        });
    };
    managed.broadcast = channel;
}

async function applyRemoteChange<V>(
    managed: RepositoryBackedRallarDataStore.Managed<V>,
    message: Partial<RepositoryBackedRallarDataStore.BroadcastMessage<V>>
): Promise<void> {
    if (message.type === 'set') {
        if (message.key === undefined || message.value === undefined) {
            return;
        }

        await Promise.resolve(managed.repository.set(message.key, message.value));
        return;
    }

    if (message.type === 'delete') {
        if (message.key === undefined) {
            return;
        }

        await Promise.resolve(managed.repository.delete(message.key));
        return;
    }

    if (message.type === 'clear') {
        await Promise.resolve(managed.repository.clearAll());
    }
}

async function closePreparedStore<V>(
    manager: RepositoryManager,
    activeTokens: Map<string, RepositoryToken<unknown>>,
    prepared: PreparedRallarDataStore<V>
): Promise<boolean> {
    activeTokens.delete(prepared.token.id);
    return await manager.delete(prepared.token);
}

async function destroyPreparedStore<V>(
    manager: RepositoryManager,
    activeTokens: Map<string, RepositoryToken<unknown>>,
    prepared: PreparedRallarDataStore<V>
): Promise<boolean> {
    const existing = manager.get(prepared.token);
    const managed = existing ??
        createManagedRepository(
            prepared.name,
            prepared.options,
            prepared.optionsKey
        );
    const keys = await managed.persistence.getAllKeys();

    await clearManagedRallarDataRepository(managed);
    broadcastRallarDataClear(managed);
    activeTokens.delete(prepared.token.id);

    if (existing) {
        await manager.delete(prepared.token);
    }
    else {
        await managed.dispose();
    }

    return existing !== undefined || keys.length > 0;
}

function toRepositoryId<V>(options: NormalizedRallarDataOptions<V>): string {
    return [
        'rallar',
        'data',
        encodeURIComponent(options.dbName),
        encodeURIComponent(options.storeName),
        encodeURIComponent(options.keyPrefix)
    ].join(':');
}

function toOptionsKey<V>(options: NormalizedRallarDataOptions<V>): string {
    return JSON.stringify({
        repositoryId: toRepositoryId(options),
        durability: options.durability,
        ttlMs: options.ttlMs ?? null,
        schemaVersion: options.schemaVersion,
        sync: options.sync,
        hasMigrate: options.migrate !== undefined,
        hasIsValid: options.isValid !== undefined,
        hasEquals: options.equals !== undefined,
        hasExpireAtFor: options.expireAtFor !== undefined,
        hasPersistenceError: options.onPersistenceError !== undefined
    });
}

function isRallarDataEnvelope(
    value: unknown
): value is RallarDataPersistedEnvelope {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const candidate = value as Partial<RallarDataPersistedEnvelope>;
    return (
        candidate.kind === RALLAR_DATA_ENVELOPE_KIND &&
        typeof candidate.schemaVersion === 'number' &&
        typeof candidate.updatedAtEpochMs === 'number' &&
        'value' in candidate
    );
}

function assertValidStoreName(name: string): void {
    if (!name.trim()) {
        throw new Error('Rallar data store name is required.');
    }
}
