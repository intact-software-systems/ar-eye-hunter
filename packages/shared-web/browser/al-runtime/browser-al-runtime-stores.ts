import type { RallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import type { CreateDefaultALRuntimeStoresInput } from '@shared/alm/al-runtime-stores.ts';
import {
    createDefaultIndexedDbALInboundRuntimeStores,
    createDefaultIndexedDbALOutboundRuntimeStores,
    createVolatileALInboundRuntimeStores,
    createVolatileALOutboundRuntimeStores,
    isIndexedDbALRuntimeStoreSupported
} from '@shared/alm/al-runtime-stores.ts';
import {
    configureALRuntimeStoreScopes,
    resolveALInboundRuntimeStores,
    resolveALOutboundRuntimeStores,
    type ALRuntimeStoreFactories,
    type ALRuntimeStoreScope
} from '@shared/alm/ALRuntimeStoreRegistry.ts';
import type {
    ALInboundRuntimeStores,
    ALVolatileInboundRuntimeStores
} from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type {
    ALOutboundRuntimeStores,
    ALVolatileOutboundRuntimeStores
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { toALStorageResetSink, type ALStorageEventSink } from '@shared/alm/storage/al-storage-event.ts';
import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
import type { ALVolatileSessionBudget } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import {
    BROWSER_AL_RUNTIME_DB_NAME,
    toBrowserRtcOverlayALRuntimeStoreId,
    toBrowserSessionALInboundRuntimeStoreId,
    toBrowserWsClientALRuntimeStoreId
} from './browser-al-runtime-identity.ts';
import {
    BrowserALStorageAvailability,
    toBrowserStoragePersistRequest,
    toInitialALStorageAvailability
} from './browser-al-storage-availability.ts';

type BrowserALRuntimeOptions = Omit<CreateDefaultALRuntimeStoresInput, 'dbName' | 'namespace'>;

export interface ConfigureBrowserALRuntimeStoresInput
    extends Omit<BrowserALRuntimeOptions, 'observer' | 'onStorageReset' | 'storageHealth'> {
    readonly diagnosticsPorts: RallarDiagnosticsPorts;
}

function createBrowserRuntimeStoreFactories(
    name: string,
    directions: Readonly<{
        inbound?: boolean;
        outbound?: boolean;
    }>,
    options: BrowserALRuntimeOptions
): ALRuntimeStoreFactories<ALOutboundTransportMessage> {
    return {
        createInboundStores: directions.inbound
            ? () => createBrowserALInboundRuntimeStores(name, options)
            : undefined,
        createOutboundStores: directions.outbound
            ? () => createBrowserALOutboundRuntimeStores(name, options)
            : undefined
    };
}

function toBrowserRuntimeStoreScopes(
    sessionId: string,
    options: BrowserALRuntimeOptions,
    storage: ALStorageEventSink
): readonly ALRuntimeStoreScope<ALOutboundTransportMessage>[] {
    const sessionInboundId = toBrowserSessionALInboundRuntimeStoreId(sessionId);
    const wsClientId = toBrowserWsClientALRuntimeStoreId(sessionId);
    const rtcOverlayId = toBrowserRtcOverlayALRuntimeStoreId(sessionId);

    return [
        {
            id: sessionInboundId,
            factories: createBrowserRuntimeStoreFactories(
                sessionInboundId,
                { inbound: true },
                toBrowserStoreOptions(sessionInboundId, options, storage)
            )
        },
        {
            id: wsClientId,
            factories: createBrowserRuntimeStoreFactories(
                wsClientId,
                { outbound: true },
                toBrowserStoreOptions(wsClientId, options, storage)
            )
        },
        {
            id: rtcOverlayId,
            factories: createBrowserRuntimeStoreFactories(
                rtcOverlayId,
                { outbound: true },
                toBrowserStoreOptions(rtcOverlayId, options, storage)
            )
        }
    ];
}

/** One health per store and connect, shared by every resolve of it; its events and resets name the store. */
function toBrowserStoreOptions(
    storeId: string,
    options: BrowserALRuntimeOptions,
    storage: ALStorageEventSink
): BrowserALRuntimeOptions {
    return {
        ...options,
        onStorageReset: toALStorageResetSink(storage, storeId),
        storageHealth: new ALStorageHealth({ storeId, storage })
    };
}

/** Always IndexedDB: without it the pair fails at open, and the connect's availability reads `missing`. */
export function createBrowserALInboundRuntimeStores(
    name: string,
    options: BrowserALRuntimeOptions = {}
): ALInboundRuntimeStores {
    return createDefaultIndexedDbALInboundRuntimeStores({
        ...options,
        dbName: BROWSER_AL_RUNTIME_DB_NAME,
        namespace: `browser:${name}`
    });
}

/** Always IndexedDB: without it the pair fails at open, and the connect's availability reads `missing`. */
export function createBrowserALOutboundRuntimeStores(
    name: string,
    options: BrowserALRuntimeOptions = {}
): ALOutboundRuntimeStores<ALOutboundTransportMessage> {
    return createDefaultIndexedDbALOutboundRuntimeStores({
        ...options,
        namespace: `browser:${name}`,
        decodePrepared: decodeALOutboundTransportMessage,
        dbName: BROWSER_AL_RUNTIME_DB_NAME
    });
}

/** Always memory, whatever the browser supports: the pair a carrier routes volatile admissions to. */
export function createBrowserALVolatileOutboundRuntimeStores(
    name: string,
    budget: ALVolatileSessionBudget
): ALVolatileOutboundRuntimeStores<ALOutboundTransportMessage> {
    return createVolatileALOutboundRuntimeStores(
        { namespace: `browser:${name}:volatile`, decodePrepared: decodeALOutboundTransportMessage },
        budget
    );
}

/**
 * Always memory: the session's inbound pair for volatile messages, created once per middleware and
 * shared by both carriers (D20). Session cleanup and a storage reset never reach it; it dies with the
 * middleware.
 */
export function createBrowserALVolatileInboundRuntimeStores(
    name: string,
    budget: ALVolatileSessionBudget
): ALVolatileInboundRuntimeStores {
    return createVolatileALInboundRuntimeStores({ namespace: `browser:${name}:volatile` }, budget);
}

export function configureBrowserALRuntimeStores(
    sessionId: string,
    input: ConfigureBrowserALRuntimeStoresInput
): BrowserALStorageAvailability {
    const { diagnosticsPorts, ...options } = input;
    const scoped: BrowserALRuntimeOptions = {
        ...options,
        observer: diagnosticsPorts.indexedDbOperationObserver,
        canonicalScope: `browser-session:${sessionId}`
    };
    configureALRuntimeStoreScopes(toBrowserRuntimeStoreScopes(sessionId, scoped, diagnosticsPorts.storage));
    return new BrowserALStorageAvailability({
        initial: toInitialALStorageAvailability(isIndexedDbALRuntimeStoreSupported()),
        requestPersist: toBrowserStoragePersistRequest(globalThis.navigator?.storage),
        storage: diagnosticsPorts.storage
    });
}

export function resolveBrowserSessionALInboundRuntimeStores(
    sessionId: string
): ALInboundRuntimeStores {
    return resolveALInboundRuntimeStores(toBrowserSessionALInboundRuntimeStoreId(sessionId));
}

export function resolveBrowserWsClientALOutboundRuntimeStores(
    sessionId: string
): ALOutboundRuntimeStores<ALOutboundTransportMessage> {
    return resolveALOutboundRuntimeStores(toBrowserWsClientALRuntimeStoreId(sessionId));
}

export function resolveBrowserRtcOverlayALOutboundRuntimeStores(
    sessionId: string
): ALOutboundRuntimeStores<ALOutboundTransportMessage> {
    return resolveALOutboundRuntimeStores(toBrowserRtcOverlayALRuntimeStoreId(sessionId));
}
