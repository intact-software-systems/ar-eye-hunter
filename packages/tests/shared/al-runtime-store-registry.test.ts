import { createDefaultInMemoryALInboundRuntimeStores, createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import {
    configureALRuntimeStoreFactories,
    resolveALInboundRuntimeStores,
    resolveALOutboundRuntimeStores,
    toALRuntimeStoreId
} from '@shared/alm/ALRuntimeStoreRegistry.ts';
import {
    decodeALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import {
    describe,
    expect,
    it
} from 'vitest';

describe('AL runtime store registry', () => {
    it('requires explicit configuration before stores can be resolved', () => {
        const manager = new RepositoryManager();

        expect(() => resolveALInboundRuntimeStores(scopeId('missing'), manager)).toThrow(
            'Repository not found: shared.services.al-runtime-stores:missing'
        );
    });

    it('creates fresh store instances on each resolve instead of sharing mutable runtime state', async () => {
        const manager = new RepositoryManager();
        configureALRuntimeStoreFactories(
            scopeId('runtime-a'),
            {
                createInboundStores: () => createDefaultInMemoryALInboundRuntimeStores(),
                createOutboundStores: () =>
                    createDefaultInMemoryALOutboundRuntimeStores({
                        decodePrepared: decodeALOutboundTransportMessage
                    })
            },
            manager
        );

        const inbound1 = resolveALInboundRuntimeStores(scopeId('runtime-a'), manager);
        const inbound2 = resolveALInboundRuntimeStores(scopeId('runtime-a'), manager);

        expect(inbound1).not.toBe(inbound2);
        expect(inbound1.admissionStore).not.toBe(inbound2.admissionStore);
    });

    it('keeps managers isolated and fails fast when a direction is not configured', () => {
        const isolatedManager = new RepositoryManager();

        configureALRuntimeStoreFactories(
            scopeId('runtime-b'),
            {
                createInboundStores: () => createDefaultInMemoryALInboundRuntimeStores()
            },
            isolatedManager
        );

        expect(resolveALInboundRuntimeStores(scopeId('runtime-b'), isolatedManager).admissionStore)
            .toBeDefined();
        expect(() => resolveALOutboundRuntimeStores(scopeId('runtime-b'), isolatedManager))
            .toThrow('AL outbound runtime stores are not configured: runtime-b');
        expect(() => resolveALInboundRuntimeStores(scopeId('runtime-b'))).toThrow(
            'Repository not found: shared.services.al-runtime-stores:runtime-b'
        );
    });
});

/** The typed scope id every registry entry is keyed by; the prepared contract rides on the id. */
function scopeId(id: string) {
    return toALRuntimeStoreId<ALOutboundTransportMessage>(id);
}
