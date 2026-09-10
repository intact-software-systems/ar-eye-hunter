import type { RallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import type { CreateDefaultALRuntimeStoresInput } from '@shared/alm/al-runtime-stores.ts';
import {
    createDefaultIndexedDbALInboundRuntimeStores,
    createDefaultIndexedDbALOutboundRuntimeStores,
    createDefaultInMemoryALInboundRuntimeStores,
    createDefaultInMemoryALOutboundRuntimeStores,
    isIndexedDbALRuntimeStoreSupported
} from '@shared/alm/al-runtime-stores.ts';
import {
    configureALRuntimeStoreScopes,
    resolveALInboundRuntimeStores,
    resolveALOutboundRuntimeStores,
    type ALRuntimeStoreFactories,
    type ALRuntimeStoreScope
} from '@shared/alm/ALRuntimeStoreRegistry.ts';
import type { ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '@shared/alm/outbound/al-outbound-transport-message.ts';

import {
    BROWSER_AL_RUNTIME_DB_NAME,
    toBrowserRtcOverlayALRuntimeStoreId,
    toBrowserRtcRxALRuntimeStoreId,
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
    const wsClientId = toBrowserWsClientALRuntimeStoreId(sessionId);
    const rtcRxId = toBrowserRtcRxALRuntimeStoreId(sessionId);
    const rtcOverlayId = toBrowserRtcOverlayALRuntimeStoreId(sessionId);

    return [
        {
            id: wsClientId,
            factories: createBrowserRuntimeStoreFactories(
                wsClientId,
                { inbound: true, outbound: true },
                options
            )
        },
        {
            id: rtcRxId,
            factories: createBrowserRuntimeStoreFactories(
                rtcRxId,
                { inbound: true },
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

export function configureBrowserALRuntimeStores(
    sessionId: string,
    input: ConfigureBrowserALRuntimeStoresInput
): void {
    const { diagnosticsPorts, ...options } = input;
    const scoped: BrowserALRuntimeOptions = {
        ...options,
        observer: diagnosticsPorts.indexedDbOperationObserver,
        onStorageReset: diagnosticsPorts.onStorageReset,
        canonicalScope: `browser-session:${sessionId}`,
        outboundBackend: !isIndexedDbALRuntimeStoreSupported()
            ? new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now)
            : options.outboundBackend
    };
    configureALRuntimeStoreScopes(toBrowserRuntimeStoreScopes(sessionId, scoped));
}

export function resolveBrowserWsClientALInboundRuntimeStores(
    sessionId: string
): ALInboundRuntimeStores {
    return resolveALInboundRuntimeStores(toBrowserWsClientALRuntimeStoreId(sessionId));
}

export function resolveBrowserWsClientALOutboundRuntimeStores(
    sessionId: string
): ALOutboundRuntimeStores<ALOutboundTransportMessage> {
    return resolveALOutboundRuntimeStores(toBrowserWsClientALRuntimeStoreId(sessionId));
}

export function resolveBrowserRtcRxALInboundRuntimeStores(
    sessionId: string
): ALInboundRuntimeStores {
    return resolveALInboundRuntimeStores(toBrowserRtcRxALRuntimeStoreId(sessionId));
}

export function resolveBrowserRtcOverlayALOutboundRuntimeStores(
    sessionId: string
): ALOutboundRuntimeStores<ALOutboundTransportMessage> {
    return resolveALOutboundRuntimeStores(toBrowserRtcOverlayALRuntimeStoreId(sessionId));
}
