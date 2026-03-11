import { describe, expect, it } from 'vitest';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import {
    configureALRuntimeStoreFactories,
    resolveALInboundRuntimeStores,
    resolveALOutboundRuntimeStores,
} from '@shared/alm/ALRuntimeStoreRegistry.ts';
import {
    createInMemoryALInboundRuntimeStores,
    createInMemoryALOutboundRuntimeStores,
} from '@shared/alm/ALRuntimeStores.ts';

describe('AL runtime store registry', () => {
    it('requires explicit configuration before stores can be resolved', () => {
        const manager = new RepositoryManager();

        expect(() => resolveALInboundRuntimeStores('missing', manager)).toThrow(
            'Repository not found: shared.services.al-runtime-stores:missing',
        );
    });

    it('creates fresh store instances on each resolve instead of sharing mutable runtime state', async () => {
        const manager = new RepositoryManager();
        configureALRuntimeStoreFactories(
            'runtime-a',
            {
                createInboundStores: () => createInMemoryALInboundRuntimeStores(),
                createOutboundStores: () => createInMemoryALOutboundRuntimeStores(),
            },
            manager,
        );

        const inbound1 = resolveALInboundRuntimeStores('runtime-a', manager);
        const inbound2 = resolveALInboundRuntimeStores('runtime-a', manager);

        expect(inbound1).not.toBe(inbound2);
        expect(inbound1.admissionStore).not.toBe(inbound2.admissionStore);
    });

    it('keeps managers isolated and fails fast when a direction is not configured', () => {
        const isolatedManager = new RepositoryManager();

        configureALRuntimeStoreFactories(
            'runtime-b',
            {
                createInboundStores: () => createInMemoryALInboundRuntimeStores(),
            },
            isolatedManager,
        );

        expect(resolveALInboundRuntimeStores('runtime-b', isolatedManager).admissionStore)
            .toBeDefined();
        expect(() => resolveALOutboundRuntimeStores('runtime-b', isolatedManager))
            .toThrow('AL outbound runtime stores are not configured: runtime-b');
        expect(() => resolveALInboundRuntimeStores('runtime-b')).toThrow(
            'Repository not found: shared.services.al-runtime-stores:runtime-b',
        );
    });
});
