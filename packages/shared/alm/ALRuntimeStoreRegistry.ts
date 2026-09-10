import { defaultRepositoryManager } from '../cache/defaultRepositoryManager.ts';
import { RepositoryManager } from '../cache/RepositoryManager.ts';
import { RepositoryToken } from '../cache/RepositoryToken.ts';
import type { ALInboundRuntimeStores } from './inbound/al-inbound-message-runtime.ts';
import type { ALOutboundRuntimeStores } from './outbound/al-outbound-message-runtime.ts';

export type ALRuntimeStoreFactories<TPrepared> = Readonly<{
    createInboundStores?: () => ALInboundRuntimeStores;
    createOutboundStores?: () => ALOutboundRuntimeStores<TPrepared>;
}>;

export type ALRuntimeStoreScope<TPrepared> = Readonly<{
    id: string;
    factories: ALRuntimeStoreFactories<TPrepared>;
}>;

export function configureALRuntimeStoreFactories<TPrepared>(
    id: string,
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
    id: string,
    manager: RepositoryManager = defaultRepositoryManager
): ALRuntimeStoreFactories<TPrepared> {
    return manager.require(toALRuntimeStoreFactoryToken(id));
}

export function resolveALInboundRuntimeStores(
    id: string,
    manager: RepositoryManager = defaultRepositoryManager
): ALInboundRuntimeStores {
    const factories = resolveALRuntimeStoreFactories<never>(id, manager);

    if (!factories.createInboundStores) {
        throw new Error(`AL inbound runtime stores are not configured: ${id}`);
    }

    return factories.createInboundStores();
}

export function resolveALOutboundRuntimeStores<TPrepared>(
    id: string,
    manager: RepositoryManager = defaultRepositoryManager
): ALOutboundRuntimeStores<TPrepared> {
    const factories = resolveALRuntimeStoreFactories<TPrepared>(id, manager);

    if (!factories.createOutboundStores) {
        throw new Error(`AL outbound runtime stores are not configured: ${id}`);
    }

    return factories.createOutboundStores();
}

function toALRuntimeStoreFactoryToken<TPrepared>(
    id: string
): RepositoryToken<ALRuntimeStoreFactories<TPrepared>> {
    return new RepositoryToken(
        `shared.services.al-runtime-stores:${id}`,
        () => {
            throw new Error(`AL runtime stores are not configured: ${id}`);
        }
    );
}
