import { AppDataOptimisticWriter } from './app-data-optimistic-writer.ts';
import type { AppDataRepository } from './app-data-repository.ts';
import { AppDataStoreCache } from './app-data-store-cache.ts';
import { appDataStoreConfigurationsMatch, type AppDataStoreConfiguration } from './app-data-store-definition.ts';

export namespace RallarServerAppDataStore {
    export interface Dependencies<V> {
        readonly repository: AppDataRepository;
        readonly name: string;
        readonly configuration: AppDataStoreConfiguration<V>;
        readonly repositoryId: string;
        readonly nowEpochMs: () => number;
    }
}

export class RallarServerAppDataStore<V> {
    readonly name: string;
    readonly repositoryId: string;

    private readonly configuration: AppDataStoreConfiguration<V>;
    private readonly cache: AppDataStoreCache<V>;
    private readonly writer: AppDataOptimisticWriter<V>;

    constructor(dependencies: RallarServerAppDataStore.Dependencies<V>) {
        this.name = dependencies.name;
        this.repositoryId = dependencies.repositoryId;
        this.configuration = dependencies.configuration;
        this.cache = new AppDataStoreCache({
            ...dependencies,
            storeName: dependencies.name
        });
        this.writer = new AppDataOptimisticWriter({
            ...dependencies,
            storeName: dependencies.name,
            cache: this.cache
        });
    }

    get namespace(): string {
        return this.configuration.namespace;
    }

    hasConfiguration(configuration: AppDataStoreConfiguration<V>): boolean {
        return appDataStoreConfigurationsMatch(this.configuration, configuration);
    }

    read(key: string): V | undefined {
        return this.cache.read(key);
    }

    hydrate(): Promise<void> {
        return this.cache.hydrate();
    }

    isHydrated(): boolean {
        return this.cache.isHydrated();
    }

    get(key: string): Promise<V | undefined> {
        return this.cache.get(key);
    }

    getEntries(): Promise<Array<readonly [string, V]>> {
        return this.cache.getEntries();
    }

    readEntries(): Array<readonly [string, V]> {
        return this.cache.readEntries();
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
        return Object.fromEntries(await this.getEntries());
    }

    set(key: string, value: V): Promise<void> {
        return this.writer.set(key, value);
    }

    updateOrCreate(key: string, updater: (current: V | undefined) => V): Promise<V> {
        return this.writer.updateOrCreate(key, updater);
    }

    update(key: string, updater: (current: V) => V): Promise<V | undefined> {
        return this.writer.update(key, updater);
    }

    setIfAbsent(key: string, creator: () => V): Promise<V> {
        return this.writer.setIfAbsent(key, creator);
    }

    compareAndSet(key: string, expected: V | undefined, update: V): Promise<boolean> {
        return this.writer.compareAndSet(key, expected, update);
    }

    getAndSet(key: string, update: V): Promise<V | undefined> {
        return this.writer.getAndSet(key, update);
    }

    delete(key: string): Promise<boolean> {
        return this.writer.delete(key);
    }

    deleteExpired(): Promise<number> {
        return this.writer.deleteExpired();
    }
}
