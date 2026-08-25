import {
    assertManagedRallarDataOptionsMatch,
    assertValidRallarDataStoreName,
    closePreparedRallarDataStore,
    destroyPreparedRallarDataStore,
    getOrCreateManagedRallarDataRepository,
    prepareRallarDataStore
} from '@shared-web/browser/data/browser-rallar-data-repository.ts';
import {
    broadcastRallarDataClear,
    clearManagedRallarDataRepository,
    estimateBrowserStorage,
    RepositoryBackedRallarDataStore
} from '@shared-web/browser/data/repository-backed-rallar-data-store.ts';
import type {
    CreateRallarDataFacadeInput,
    RallarDataFacade,
    RallarDataScope,
    RallarDataStore,
    RallarDataStoreDefinition,
    RallarDataStoreOptions
} from '@shared-web/browser/rallar-data.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { RepositoryToken } from '@shared/cache/RepositoryToken.ts';

export function createRallarDataFacade(
    input: CreateRallarDataFacadeInput
): RallarDataFacade {
    const stores = new BrowserRallarDataStoreLifecycle(input);
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

export function defineRallarDataStore<V>(
    name: string,
    options?: RallarDataStoreOptions<V>
): RallarDataStoreDefinition<V> {
    assertValidRallarDataStoreName(name);
    return { name, options };
}

class BrowserRallarDataStoreLifecycle {
    private readonly manager: RepositoryManager;
    private readonly resolveScopeKey: (scope: RallarDataScope) => string;
    private readonly activeTokens = new Map<string, RepositoryToken<RepositoryBackedRallarDataStore.Lifecycle>>();

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
        const managed = getOrCreateManagedRallarDataRepository(
            this.manager,
            prepared
        );
        this.activeTokens.set(prepared.token.id, prepared.token);
        const store = new RepositoryBackedRallarDataStore<V>(
            prepared.name,
            managed,
            () =>
                closePreparedRallarDataStore(
                    this.manager,
                    this.activeTokens,
                    prepared
                )
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
        assertManagedRallarDataOptionsMatch(managed, prepared);
        this.activeTokens.set(prepared.token.id, prepared.token);
        return new RepositoryBackedRallarDataStore<V>(
            prepared.name,
            managed,
            () =>
                closePreparedRallarDataStore(
                    this.manager,
                    this.activeTokens,
                    prepared
                )
        );
    };

    public readonly close = async <V>(
        input: string | RallarDataStoreDefinition<V>,
        closeOptions?: RallarDataStoreOptions<V>
    ): Promise<boolean> => {
        return await closePreparedRallarDataStore(
            this.manager,
            this.activeTokens,
            prepareRallarDataStore(input, closeOptions, this.resolveScopeKey)
        );
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
        return await destroyPreparedRallarDataStore(
            this.manager,
            this.activeTokens,
            prepareRallarDataStore(input, destroyOptions, this.resolveScopeKey)
        );
    };

    public readonly destroyScope = async (
        scope: RallarDataScope
    ): Promise<number> => {
        return await this.forEachActiveScopeRepository(
            this.resolveScopeKey(scope),
            async (token, managed) => {
                await clearManagedRallarDataRepository(managed);
                broadcastRallarDataClear(managed);
                return await this.manager.delete(token);
            }
        );
    };

    private async forEachActiveScopeRepository(
        scopeKey: string,
        operation: (
            token: RepositoryToken<RepositoryBackedRallarDataStore.Lifecycle>,
            managed: RepositoryBackedRallarDataStore.Lifecycle
        ) => Promise<boolean>,
        removeFromActive = true
    ): Promise<number> {
        let count = 0;
        for (const [id, token] of this.activeTokens) {
            const managed = this.manager.get(token);
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
