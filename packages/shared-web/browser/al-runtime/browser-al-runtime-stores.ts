import type { RallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import type { CreateDefaultALRuntimeStoresInput } from '@shared/alm/al-runtime-stores.ts';
import {
    createDefaultIndexedDbALInboundRuntimeStores,
    createDefaultIndexedDbALOutboundRuntimeStores,
    createVolatileALInboundRuntimeStores,
    createVolatileALOutboundRuntimeStores
} from '@shared/alm/al-runtime-stores.ts';
import {
    configureALRuntimeStoreScopes,
    resolveALInboundRuntimeStores,
    resolveALOutboundRuntimeStores,
    type ALRuntimeStoreId,
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
import { ALStorageConnectOpenings } from '@shared/alm/storage/al-storage-connect-openings.ts';
import { toALStorageResetSink, type ALStorageEventSink } from '@shared/alm/storage/al-storage-event.ts';
import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
import type { ALVolatileSessionBudget } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { IndexedDbStringPersistenceProvider } from '@shared/persistence/indexed-db-string-persistence-provider.ts';

import {
    toBrowserRtcOverlayALCheckpointRuntimeStoreId,
    toBrowserWsClientALCheckpointRuntimeStoreId
} from './browser-al-checkpoint-store-ids.ts';
import {
    createBrowserALCheckpointOutboundRuntimeStores,
    resolveBrowserALCheckpointSettings,
    type BrowserALCheckpointSettings,
    type BrowserALCheckpointSettingsInput
} from './browser-al-checkpoint-stores.ts';
import {
    toBrowserALRuntimeDbName,
    toBrowserRtcOverlayALRuntimeStoreId,
    toBrowserSessionALInboundRuntimeStoreId,
    toBrowserWsClientALRuntimeStoreId
} from './browser-al-runtime-identity.ts';
import {
    BrowserALStorageAvailability,
    toBrowserStoragePersistRequest,
    toInitialALStorageAvailability
} from './browser-al-storage-availability.ts';

interface BrowserALRuntimeOptions extends Omit<CreateDefaultALRuntimeStoresInput, 'dbName' | 'namespace'> {
    readonly dbName: string;
}

export interface ConfigureBrowserALRuntimeStoresInput
    extends
        Omit<BrowserALRuntimeOptions, 'dbName' | 'observer' | 'onStorageReset' | 'storageHealth' | 'connectOpenings'>,
        BrowserALCheckpointSettingsInput {
    readonly scope: StateScope;
    readonly diagnosticsPorts: RallarDiagnosticsPorts;
}

/** Where one connect's stores report, and how its checkpoint lanes run. */
interface BrowserRuntimeStoreReporting {
    readonly storage: ALStorageEventSink;
    /** A checkpoint store's events also reach the connect's availability, which skips its lane on a lag. */
    readonly checkpointStorage: ALStorageEventSink;
    readonly checkpoint: BrowserALCheckpointSettings;
}

function toBrowserRuntimeStoreScopes(
    sessionId: string,
    options: BrowserALRuntimeOptions,
    reporting: BrowserRuntimeStoreReporting
): readonly ALRuntimeStoreScope<ALOutboundTransportMessage>[] {
    const sessionInboundId = toBrowserSessionALInboundRuntimeStoreId(sessionId);
    const inboundOptions = createBrowserStoreOptions(sessionInboundId, options, reporting.storage);

    return [
        {
            id: sessionInboundId,
            factories: {
                createInboundStores: () => createBrowserALInboundRuntimeStores(sessionInboundId, inboundOptions)
            }
        },
        toBrowserOutboundStoreScope(
            {
                id: toBrowserWsClientALRuntimeStoreId(sessionId),
                checkpointId: toBrowserWsClientALCheckpointRuntimeStoreId(sessionId)
            },
            options,
            reporting
        ),
        toBrowserOutboundStoreScope(
            {
                id: toBrowserRtcOverlayALRuntimeStoreId(sessionId),
                checkpointId: toBrowserRtcOverlayALCheckpointRuntimeStoreId(sessionId)
            },
            options,
            reporting
        )
    ];
}

interface BrowserOutboundStoreIds {
    readonly id: ALRuntimeStoreId<ALOutboundTransportMessage>;
    readonly checkpointId: ALRuntimeStoreId<ALOutboundTransportMessage>;
}

/** An outbound carrier's durable pair and its checkpoint pair, each under its own store id and health. */
function toBrowserOutboundStoreScope(
    ids: BrowserOutboundStoreIds,
    options: BrowserALRuntimeOptions,
    reporting: BrowserRuntimeStoreReporting
): ALRuntimeStoreScope<ALOutboundTransportMessage> {
    const outboundOptions = createBrowserStoreOptions(ids.id, options, reporting.storage);
    const checkpointOptions = createBrowserStoreOptions(ids.checkpointId, options, reporting.checkpointStorage);
    return {
        id: ids.id,
        factories: {
            createOutboundStores: () => createBrowserALOutboundRuntimeStores(ids.id, outboundOptions),
            createCheckpointStores: (ownership) =>
                createBrowserALCheckpointOutboundRuntimeStores(ids.checkpointId, {
                    options: checkpointOptions,
                    settings: reporting.checkpoint,
                    ownership
                })
        }
    };
}

/** One health per store and connect, shared by every resolve of it; its events and resets name the store. */
function createBrowserStoreOptions(
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
    options: BrowserALRuntimeOptions
): ALInboundRuntimeStores {
    return createDefaultIndexedDbALInboundRuntimeStores({ ...options, namespace: `browser:${name}` });
}

/** Always IndexedDB: without it the pair fails at open, and the connect's availability reads `missing`. */
export function createBrowserALOutboundRuntimeStores(
    name: string,
    options: BrowserALRuntimeOptions
): ALOutboundRuntimeStores<ALOutboundTransportMessage> {
    return createDefaultIndexedDbALOutboundRuntimeStores({
        ...options,
        namespace: `browser:${name}`,
        decodePrepared: decodeALOutboundTransportMessage
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
    const { diagnosticsPorts, scope, checkpointIntervalMs, checkpointLagBoundMs, ...options } = input;
    const scoped: BrowserALRuntimeOptions = {
        ...options,
        dbName: toBrowserALRuntimeDbName(scope),
        observer: diagnosticsPorts.indexedDbOperationObserver,
        canonicalScope: `browser-session:${sessionId}`,
        connectOpenings: new ALStorageConnectOpenings()
    };
    const { storage } = diagnosticsPorts;
    const availability = new BrowserALStorageAvailability({
        initial: toInitialALStorageAvailability(IndexedDbStringPersistenceProvider.isSupported()),
        requestPersist: toBrowserStoragePersistRequest(globalThis.navigator?.storage),
        storage
    });
    configureALRuntimeStoreScopes(toBrowserRuntimeStoreScopes(sessionId, scoped, {
        storage,
        checkpointStorage: (event) => {
            availability.recordCheckpointHealth(event);
            storage(event);
        },
        checkpoint: resolveBrowserALCheckpointSettings({ checkpointIntervalMs, checkpointLagBoundMs })
    }));
    return availability;
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
