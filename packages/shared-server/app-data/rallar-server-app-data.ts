import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import type { AppDataRepository } from './app-data-repository.ts';
import {
    defineAppDataStore,
    prepareAppDataStore,
    resolveAppDataStoreDefinition,
    type RallarServerAppDataStoreDefinition,
    type RallarServerAppDataStoreOptions
} from './app-data-store-definition.ts';
import { RallarServerAppDataStore } from './rallar-server-app-data-store.ts';

export namespace RallarServerAppData {
    export interface Dependencies {
        readonly repositories: RepositoryManager;
        readonly repository: AppDataRepository;
        readonly nowEpochMs: () => number;
    }
}

export class RallarServerAppData {
    private readonly repositories: RepositoryManager;
    private readonly repository: AppDataRepository;
    private readonly nowEpochMs: () => number;

    constructor(dependencies: RallarServerAppData.Dependencies) {
        this.repositories = dependencies.repositories;
        this.repository = dependencies.repository;
        this.nowEpochMs = dependencies.nowEpochMs;
    }

    define<V>(
        name: string,
        options: RallarServerAppDataStoreOptions<V>
    ): RallarServerAppDataStoreDefinition<V> {
        return defineAppDataStore(name, options);
    }

    open<V>(definition: RallarServerAppDataStoreDefinition<V>): Promise<RallarServerAppDataStore<V>>;
    open<V>(name: string, options: RallarServerAppDataStoreOptions<V>): Promise<RallarServerAppDataStore<V>>;
    async open<V>(
        input: string | RallarServerAppDataStoreDefinition<V>,
        options?: RallarServerAppDataStoreOptions<V>
    ): Promise<RallarServerAppDataStore<V>> {
        const prepared = prepareAppDataStore(resolveAppDataStoreDefinition(input, options));
        const existing = this.repositories.get(prepared.token);
        if (existing) {
            this.assertConfigurationMatches(existing, prepared.name, prepared.configuration);
            return existing;
        }

        const created = new RallarServerAppDataStore<V>({
            repository: this.repository,
            name: prepared.name,
            configuration: prepared.configuration,
            repositoryId: prepared.token.id,
            nowEpochMs: this.nowEpochMs
        });
        this.repositories.set(prepared.token, created);
        return created;
    }

    lookup<V>(definition: RallarServerAppDataStoreDefinition<V>): RallarServerAppDataStore<V> | undefined;
    lookup<V>(name: string, options: RallarServerAppDataStoreOptions<V>): RallarServerAppDataStore<V> | undefined;
    lookup<V>(
        input: string | RallarServerAppDataStoreDefinition<V>,
        options?: RallarServerAppDataStoreOptions<V>
    ): RallarServerAppDataStore<V> | undefined {
        const prepared = prepareAppDataStore(resolveAppDataStoreDefinition(input, options));
        const existing = this.repositories.get(prepared.token);
        if (existing) {
            this.assertConfigurationMatches(existing, prepared.name, prepared.configuration);
        }
        return existing;
    }

    close<V>(definition: RallarServerAppDataStoreDefinition<V>): Promise<boolean>;
    close<V>(name: string, options: RallarServerAppDataStoreOptions<V>): Promise<boolean>;
    async close<V>(
        input: string | RallarServerAppDataStoreDefinition<V>,
        options?: RallarServerAppDataStoreOptions<V>
    ): Promise<boolean> {
        const prepared = prepareAppDataStore(resolveAppDataStoreDefinition(input, options));
        const existing = this.repositories.get(prepared.token);
        if (existing) {
            this.assertConfigurationMatches(existing, prepared.name, prepared.configuration);
        }
        return await this.repositories.delete(prepared.token);
    }

    private assertConfigurationMatches<V>(
        existing: RallarServerAppDataStore<V>,
        name: string,
        configuration: Parameters<RallarServerAppDataStore<V>['hasConfiguration']>[0]
    ): void {
        if (existing.hasConfiguration(configuration)) {
            return;
        }
        throw new Error(
            `Rallar server app data store already opened with different options: ${name}`
        );
    }
}
