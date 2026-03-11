import { RepositoryManager } from '../cache/RepositoryManager.ts';
import { RepositoryToken } from '../cache/RepositoryToken.ts';
import { defaultRepositoryManager } from '../cache/defaultRepositoryManager.ts';
import type { ALInboundRuntimeStores } from './ALInboundMessageRuntime.ts';
import type { ALOutboundRuntimeStores } from './ALOutboundMessageRuntime.ts';

export type ALRuntimeStoreFactories = Readonly<{
    createInboundStores?: () => ALInboundRuntimeStores;
    createOutboundStores?: () => ALOutboundRuntimeStores;
}>;

export type ALRuntimeStoreScope = Readonly<{
    id: string;
    factories: ALRuntimeStoreFactories;
}>;

export function configureALRuntimeStoreFactories(
    id: string,
    factories: ALRuntimeStoreFactories,
    manager: RepositoryManager = defaultRepositoryManager,
): ALRuntimeStoreFactories {
    manager.set(toALRuntimeStoreFactoryToken(id), factories);
    return factories;
}

export function configureALRuntimeStoreScopes(
    scopes: readonly ALRuntimeStoreScope[],
    manager: RepositoryManager = defaultRepositoryManager,
): void {
    for (const scope of scopes) {
        configureALRuntimeStoreFactories(scope.id, scope.factories, manager);
    }
}

export function resolveALRuntimeStoreFactories(
    id: string,
    manager: RepositoryManager = defaultRepositoryManager,
): ALRuntimeStoreFactories {
    return manager.require(toALRuntimeStoreFactoryToken(id));
}

export function resolveALInboundRuntimeStores(
    id: string,
    manager: RepositoryManager = defaultRepositoryManager,
): ALInboundRuntimeStores {
    const factories = resolveALRuntimeStoreFactories(id, manager);

    if (!factories.createInboundStores) {
        throw new Error(`AL inbound runtime stores are not configured: ${id}`);
    }

    return factories.createInboundStores();
}

export function resolveALOutboundRuntimeStores(
    id: string,
    manager: RepositoryManager = defaultRepositoryManager,
): ALOutboundRuntimeStores {
    const factories = resolveALRuntimeStoreFactories(id, manager);

    if (!factories.createOutboundStores) {
        throw new Error(`AL outbound runtime stores are not configured: ${id}`);
    }

    return factories.createOutboundStores();
}

function toALRuntimeStoreFactoryToken(
    id: string,
): RepositoryToken<ALRuntimeStoreFactories> {
    return new RepositoryToken(
        `shared.services.al-runtime-stores:${id}`,
        () => {
            throw new Error(`AL runtime stores are not configured: ${id}`);
        },
    );
}
