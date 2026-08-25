import { installBrowserRallarDataBroadcastSync } from '@shared-web/browser/data/install-browser-rallar-data-broadcast-sync.ts';
import {
    RallarDataPersistenceProvider,
    type RallarDataStorageValue
} from '@shared-web/browser/data/rallar-data-persistence-provider.ts';
import {
    broadcastRallarDataClear,
    clearManagedRallarDataRepository,
    RepositoryBackedRallarDataStore
} from '@shared-web/browser/data/repository-backed-rallar-data-store.ts';
import type {
    RallarDataScope,
    RallarDataStoreDefinition,
    RallarDataStoreOptions
} from '@shared-web/browser/rallar-data.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { RepositoryToken } from '@shared/cache/RepositoryToken.ts';
import { WriteBehindObservableLatestRepository } from '@shared/cache/WriteBehindObservableLatestRepository.ts';
import { WriteThroughObservableLatestRepository } from '@shared/cache/WriteThroughObservableLatestRepository.ts';
import { IndexedDbStringPersistenceProvider } from '@shared/persistence/IndexedDbStringPersistenceProvider.ts';

const DEFAULT_CUSTOM_DATA_DB_NAME = 'rallar-custom-data';
const DEFAULT_CUSTOM_DATA_STORE_NAME = 'entries';

export type NormalizedRallarDataOptions<V> =
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
    & Readonly<{ scopeKey: string; }>
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

export type PreparedRallarDataStore<V> = Readonly<{
    name: string;
    options: NormalizedRallarDataOptions<V>;
    optionsKey: string;
    token: RepositoryToken<RepositoryBackedRallarDataStore.Managed<V>>;
}>;

export function prepareRallarDataStore<V>(
    input: string | RallarDataStoreDefinition<V>,
    options: RallarDataStoreOptions<V> | undefined,
    resolveScopeKey: (scope: RallarDataScope) => string
): PreparedRallarDataStore<V> {
    const name = typeof input === 'string' ? input : input.name;
    assertValidRallarDataStoreName(name);
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
        () =>
            createManagedRallarDataRepository(
                name,
                normalizedOptions,
                optionsKey
            )
    );
    return { name, options: normalizedOptions, optionsKey, token };
}

export function getOrCreateManagedRallarDataRepository<V>(
    manager: RepositoryManager,
    prepared: PreparedRallarDataStore<V>
): RepositoryBackedRallarDataStore.Managed<V> {
    const existing = manager.get(prepared.token);
    if (existing) {
        assertManagedRallarDataOptionsMatch(existing, prepared);
        return existing;
    }
    const created = prepared.token.create();
    manager.set(prepared.token, created);
    return created;
}

export function createManagedRallarDataRepository<V>(
    name: string,
    options: NormalizedRallarDataOptions<V>,
    optionsKey: string
): RepositoryBackedRallarDataStore.Managed<V> {
    const rawPersistence = new IndexedDbStringPersistenceProvider<RallarDataStorageValue>({
        dbName: options.dbName,
        storeName: options.storeName,
        keyPrefix: options.keyPrefix
    });
    const persistence = new RallarDataPersistenceProvider<V>(rawPersistence, {
        schemaVersion: options.schemaVersion,
        migrate: options.migrate
    });
    const id = toRepositoryId(options);
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
        name,
        id,
        optionsKey,
        scope: options.scope,
        scopeKey: options.scopeKey,
        durability: options.durability,
        persistence,
        repository,
        instanceId: crypto.randomUUID(),
        async dispose(): Promise<void> {
            managed.broadcast?.close();
            managed.broadcast = undefined;
            await repository.dispose();
        }
    };
    installBrowserRallarDataBroadcastSync(managed, options.sync);
    return managed;
}

export async function closePreparedRallarDataStore<V>(
    manager: RepositoryManager,
    activeTokens: Map<string, RepositoryToken<RepositoryBackedRallarDataStore.Lifecycle>>,
    prepared: PreparedRallarDataStore<V>
): Promise<boolean> {
    activeTokens.delete(prepared.token.id);
    return await manager.delete(prepared.token);
}

export async function destroyPreparedRallarDataStore<V>(
    manager: RepositoryManager,
    activeTokens: Map<string, RepositoryToken<RepositoryBackedRallarDataStore.Lifecycle>>,
    prepared: PreparedRallarDataStore<V>
): Promise<boolean> {
    const existing = manager.get(prepared.token);
    const managed = existing ?? createManagedRallarDataRepository(
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

export function assertValidRallarDataStoreName(name: string): void {
    if (!name.trim()) {
        throw new Error('Rallar data store name is required.');
    }
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

export function assertManagedRallarDataOptionsMatch<V>(
    managed: RepositoryBackedRallarDataStore.Managed<V>,
    prepared: Pick<PreparedRallarDataStore<V>, 'optionsKey' | 'token'>
): void {
    if (managed.optionsKey !== prepared.optionsKey) {
        throw new Error(
            `Rallar data store already opened with different options: ${prepared.token.id}`
        );
    }
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
