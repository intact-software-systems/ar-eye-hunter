import type { ValueEqualityChecker } from '@shared/cache/observable/observable-latest-value.ts';
import {
    type ObservableKeyedValueListener
} from '@shared/cache/RepositoryInterfaces.ts';
import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import type { PersistenceErrorHandler } from '@shared/cache/store-backed/write-behind-observable-latest-repository.ts';

export {
    createRallarDataFacade,
    defineRallarDataStore
} from '@shared-web/browser/data/browser-rallar-data-facade.ts';

export type RallarDataScope = 'app' | 'principal' | 'session' | string;

export type RallarDataDurability = 'write-through' | 'write-behind';

export type RallarDataHydration = 'eager' | 'lazy';

export interface RallarDataStorageEstimate {
    readonly usage?: number;
    readonly quota?: number;
}

export interface RallarDataStoreOptions<V> {
    readonly scope?: RallarDataScope;
    readonly dbName?: string;
    readonly storeName?: string;
    readonly keyPrefix?: string;
    readonly ttlMs?: number;
    readonly durability?: RallarDataDurability;
    readonly hydrate?: RallarDataHydration;
    readonly sync?: boolean;
    readonly isValid?: (value: V) => boolean;
    readonly equals?: ValueEqualityChecker<V>;
    readonly expireAtFor?: (value: V) => number;
    readonly onPersistenceError?: PersistenceErrorHandler<string, V>;
}

export interface RallarDataStoreDefinition<V> {
    readonly name: string;
    readonly options?: RallarDataStoreOptions<V>;
}

export interface RallarDataStore<V> {
    readonly name: string;
    readonly repositoryId: string;
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
    onChange(listener: ObservableKeyedValueListener<string, V>): RallarUnsubscribe;
}

export type RallarUnsubscribe = () => void;

export interface RallarDataFacade {
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
}

export interface CreateRallarDataFacadeInput {
    readonly manager: RepositoryManager;
    resolveScopeKey(scope: RallarDataScope): string;
}
