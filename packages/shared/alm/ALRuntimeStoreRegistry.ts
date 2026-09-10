import { defaultRepositoryManager } from '../cache/defaultRepositoryManager.ts';
import { RepositoryManager } from '../cache/RepositoryManager.ts';
import { RepositoryToken } from '../cache/RepositoryToken.ts';
import type { ALInboundRuntimeStores } from './inbound/al-inbound-message-runtime.ts';
import type { ALOutboundRuntimeStores } from './outbound/al-outbound-message-runtime.ts';

declare const alRuntimeStorePrepared: unique symbol;

/**
 * A store-scope id that also states the prepared contract its outbound stores produce. The phantom
 * member is type-only: `toALRuntimeStoreId` is its single producer and returns the id itself, so a
 * resolve infers `TPrepared` from the id instead of the caller asserting it.
 */
export type ALRuntimeStoreId<TPrepared> = string & {
    readonly [alRuntimeStorePrepared]: TPrepared;
};

export function toALRuntimeStoreId<TPrepared>(id: string): ALRuntimeStoreId<TPrepared> {
    return id as ALRuntimeStoreId<TPrepared>;
}

export type ALRuntimeStoreFactories<TPrepared> = Readonly<{
    createInboundStores?: () => ALInboundRuntimeStores;
    createOutboundStores?: () => ALOutboundRuntimeStores<TPrepared>;
}>;

export type ALRuntimeStoreScope<TPrepared> = Readonly<{
    id: ALRuntimeStoreId<TPrepared>;
    factories: ALRuntimeStoreFactories<TPrepared>;
}>;

export function configureALRuntimeStoreFactories<TPrepared>(
    id: ALRuntimeStoreId<TPrepared>,
    factories: ALRuntimeStoreFactories<TPrepared>,
    manager: RepositoryManager = defaultRepositoryManager
): ALRuntimeStoreFactories<TPrepared> {
    manager.set(toALRuntimeStoreFactoryToken<TPrepared>(id), factories);
    return factories;
}

export function configureALRuntimeStoreScopes<TPrepared>(
    scopes: readonly ALRuntimeStoreScope<TPrepared>[],
    manager: RepositoryManager = defaultRepositoryManager
): void {
    for (const scope of scopes) {
        configureALRuntimeStoreFactories(scope.id, scope.factories, manager);
    }
}

export function resolveALRuntimeStoreFactories<TPrepared>(
    id: ALRuntimeStoreId<TPrepared>,
    manager: RepositoryManager = defaultRepositoryManager
): ALRuntimeStoreFactories<TPrepared> {
    return manager.require(toALRuntimeStoreFactoryToken<TPrepared>(id));
}

export function resolveALInboundRuntimeStores<TPrepared>(
    id: ALRuntimeStoreId<TPrepared>,
    manager: RepositoryManager = defaultRepositoryManager
): ALInboundRuntimeStores {
    const factories = resolveALRuntimeStoreFactories(id, manager);

    if (!factories.createInboundStores) {
        throw new Error(`AL inbound runtime stores are not configured: ${id}`);
    }

    return factories.createInboundStores();
}

export function resolveALOutboundRuntimeStores<TPrepared>(
    id: ALRuntimeStoreId<TPrepared>,
    manager: RepositoryManager = defaultRepositoryManager
): ALOutboundRuntimeStores<TPrepared> {
    const factories = resolveALRuntimeStoreFactories<TPrepared>(id, manager);

    if (!factories.createOutboundStores) {
        throw new Error(`AL outbound runtime stores are not configured: ${id}`);
    }

    return factories.createOutboundStores();
}

function toALRuntimeStoreFactoryToken<TPrepared>(
    id: ALRuntimeStoreId<TPrepared>
): RepositoryToken<ALRuntimeStoreFactories<TPrepared>> {
    return new RepositoryToken(
        `shared.services.al-runtime-stores:${id}`,
        () => {
            throw new Error(`AL runtime stores are not configured: ${id}`);
        }
    );
}
