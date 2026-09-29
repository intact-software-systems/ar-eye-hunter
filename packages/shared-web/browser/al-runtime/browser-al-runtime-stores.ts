import type { RallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import type { CreateDefaultALRuntimeStoresInput } from '@shared/alm/al-runtime-stores.ts';
import {
    createDefaultIndexedDbALInboundRuntimeStores,
    createDefaultIndexedDbALOutboundRuntimeStores,
    createDefaultInMemoryALInboundRuntimeStores,
    createDefaultInMemoryALOutboundRuntimeStores,
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
import type { ALVolatileSessionBudget } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import {
    BROWSER_AL_RUNTIME_DB_NAME,
    toBrowserRtcOverlayALRuntimeStoreId,
    toBrowserSessionALInboundRuntimeStoreId,
    toBrowserWsClientALRuntimeStoreId
} from './browser-al-runtime-identity.ts';

type BrowserALRuntimeOptions = Omit<CreateDefaultALRuntimeStoresInput, 'dbName' | 'namespace'>;

export interface ConfigureBrowserALRuntimeStoresInput
    extends Omit<BrowserALRuntimeOptions, 'observer' | 'onStorageReset'> {
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
    options: BrowserALRuntimeOptions
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
                options
            )
        },
        {
            id: wsClientId,
            factories: createBrowserRuntimeStoreFactories(
                wsClientId,
                { outbound: true },
                options
            )
        },
        {
            id: rtcOverlayId,
            factories: createBrowserRuntimeStoreFactories(
                rtcOverlayId,
                { outbound: true },
                options
            )
        }
    ];
}

export function createBrowserALInboundRuntimeStores(
    name: string,
    options: BrowserALRuntimeOptions = {}
): ALInboundRuntimeStores {
    const namespace = `browser:${name}`;
    return isIndexedDbALRuntimeStoreSupported()
        ? createDefaultIndexedDbALInboundRuntimeStores({
            ...options,
            dbName: BROWSER_AL_RUNTIME_DB_NAME,
            namespace
        })
        : createDefaultInMemoryALInboundRuntimeStores({ ...options, namespace });
}

export function createBrowserALOutboundRuntimeStores(
    name: string,
    options: BrowserALRuntimeOptions = {}
): ALOutboundRuntimeStores<ALOutboundTransportMessage> {
    const namespace = `browser:${name}`;
    const outbound = { ...options, namespace, decodePrepared: decodeALOutboundTransportMessage };
    return isIndexedDbALRuntimeStoreSupported()
        ? createDefaultIndexedDbALOutboundRuntimeStores({ ...outbound, dbName: BROWSER_AL_RUNTIME_DB_NAME })
        : createDefaultInMemoryALOutboundRuntimeStores(outbound);
}

/** Always memory, whatever the browser supports: the pair a carrier routes volatile admissions to. */
export function createBrowserALVolatileOutboundRuntimeStores(
    name: string,
    budget: ALVolatileSessionBudget | undefined
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
    budget: ALVolatileSessionBudget | undefined
): ALVolatileInboundRuntimeStores {
    return createVolatileALInboundRuntimeStores({ namespace: `browser:${name}:volatile` }, budget);
}

export function configureBrowserALRuntimeStores(
    sessionId: string,
    input: ConfigureBrowserALRuntimeStoresInput
): void {
    const { diagnosticsPorts, ...options } = input;
    const inMemory = !isIndexedDbALRuntimeStoreSupported();
    const scoped: BrowserALRuntimeOptions = {
        ...options,
        observer: diagnosticsPorts.indexedDbOperationObserver,
        onStorageReset: diagnosticsPorts.onStorageReset,
        canonicalScope: `browser-session:${sessionId}`,
        inboundBackend: inMemory
            ? new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now)
            : options.inboundBackend,
        outboundBackend: inMemory
            ? new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now)
            : options.outboundBackend
    };
    configureALRuntimeStoreScopes(toBrowserRuntimeStoreScopes(sessionId, scoped));
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
