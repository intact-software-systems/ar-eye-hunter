import type { ValueEqualityChecker } from '@shared/cache/ObservableLatestValue.ts';
import {
    type ObservableKeyedValueEvent,
    type ObservableKeyedValueListener
} from '@shared/cache/RepositoryInterfaces.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import type { PersistenceErrorHandler } from '@shared/cache/WriteBehindObservableLatestRepository.ts';

export {
    createRallarDataFacade,
    defineRallarDataStore
} from '@shared-web/browser/data/browser-rallar-data-facade.ts';

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
