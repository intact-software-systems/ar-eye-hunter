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
    BROWSER_AL_RUNTIME_DB_NAME,
    toBrowserRtcOverlayALRuntimeStoreId,
    toBrowserRtcRxALRuntimeStoreId,
    toBrowserWsClientALRuntimeStoreId
} from './browser-al-runtime-identity.ts';

type BrowserALRuntimeOptions = Omit<CreateDefaultALRuntimeStoresInput, 'dbName' | 'namespace'>;

type RuntimeStoreDirection = 'inbound' | 'outbound';

function createBrowserALRuntimeStores(
    direction: 'inbound',
    name: string,
    options?: BrowserALRuntimeOptions
): ALInboundRuntimeStores;
function createBrowserALRuntimeStores(
    direction: 'outbound',
    name: string,
    options?: BrowserALRuntimeOptions
): ALOutboundRuntimeStores;
function createBrowserALRuntimeStores(
    direction: RuntimeStoreDirection,
    name: string,
    options: BrowserALRuntimeOptions = {}
): ALInboundRuntimeStores | ALOutboundRuntimeStores {
    if (!isIndexedDbALRuntimeStoreSupported()) {
        return direction === 'inbound'
            ? createDefaultInMemoryALInboundRuntimeStores(options)
            : createDefaultInMemoryALOutboundRuntimeStores(options);
    }

    const persistentOptions = {
        ...options,
        dbName: BROWSER_AL_RUNTIME_DB_NAME,
        namespace: `browser:${name}`
    };

    return direction === 'inbound'
        ? createDefaultIndexedDbALInboundRuntimeStores(persistentOptions)
        : createDefaultIndexedDbALOutboundRuntimeStores(persistentOptions);
}

function createBrowserRuntimeStoreFactories(
    name: string,
    directions: Readonly<{
        inbound?: boolean;
        outbound?: boolean;
    }>,
    options: BrowserALRuntimeOptions
): ALRuntimeStoreFactories {
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
): readonly ALRuntimeStoreScope[] {
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

function resolveBrowserALRuntimeStores(
    direction: 'inbound',
    sessionId: string,
    toRuntimeStoreId: (sessionId: string) => string
): ALInboundRuntimeStores;
function resolveBrowserALRuntimeStores(
    direction: 'outbound',
    sessionId: string,
    toRuntimeStoreId: (sessionId: string) => string
): ALOutboundRuntimeStores;
function resolveBrowserALRuntimeStores(
    direction: RuntimeStoreDirection,
    sessionId: string,
    toRuntimeStoreId: (sessionId: string) => string
): ALInboundRuntimeStores | ALOutboundRuntimeStores {
    const runtimeStoreId = toRuntimeStoreId(sessionId);

    return direction === 'inbound'
        ? resolveALInboundRuntimeStores(runtimeStoreId)
        : resolveALOutboundRuntimeStores(runtimeStoreId);
}

export function createBrowserALInboundRuntimeStores(
    name: string,
    options: BrowserALRuntimeOptions = {}
): ALInboundRuntimeStores {
    return createBrowserALRuntimeStores('inbound', name, options);
}

export function createBrowserALOutboundRuntimeStores(
    name: string,
    options: BrowserALRuntimeOptions = {}
): ALOutboundRuntimeStores {
    return createBrowserALRuntimeStores('outbound', name, options);
}

export function configureBrowserALRuntimeStores(
    sessionId: string,
    options: BrowserALRuntimeOptions = {}
): void {
    configureALRuntimeStoreScopes(toBrowserRuntimeStoreScopes(sessionId, options));
}

export function resolveBrowserWsClientALInboundRuntimeStores(
    sessionId: string
): ALInboundRuntimeStores {
    return resolveBrowserALRuntimeStores(
        'inbound',
        sessionId,
        toBrowserWsClientALRuntimeStoreId
    );
}

export function resolveBrowserWsClientALOutboundRuntimeStores(
    sessionId: string
): ALOutboundRuntimeStores {
    return resolveBrowserALRuntimeStores(
        'outbound',
        sessionId,
        toBrowserWsClientALRuntimeStoreId
    );
}

export function resolveBrowserRtcRxALInboundRuntimeStores(
    sessionId: string
): ALInboundRuntimeStores {
    return resolveBrowserALRuntimeStores(
        'inbound',
        sessionId,
        toBrowserRtcRxALRuntimeStoreId
    );
}

export function resolveBrowserRtcOverlayALOutboundRuntimeStores(
    sessionId: string
): ALOutboundRuntimeStores {
    return resolveBrowserALRuntimeStores(
        'outbound',
        sessionId,
        toBrowserRtcOverlayALRuntimeStoreId
    );
}
