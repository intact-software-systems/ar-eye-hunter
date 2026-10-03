import {
    toALRuntimeStoreId,
    type ALRuntimeStoreId
} from '@shared/alm/ALRuntimeStoreRegistry.ts';
import type { ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { IndexedDbStringPersistenceProvider } from '@shared/persistence/indexed-db-string-persistence-provider.ts';

import {
    toBrowserRtcOverlayALCheckpointRuntimeStoreId,
    toBrowserWsClientALCheckpointRuntimeStoreId
} from './browser-al-checkpoint-store-ids.ts';

export const BROWSER_AL_RUNTIME_DB_NAME_PREFIX = 'rallar-al-runtime:';
export const BROWSER_AL_RUNTIME_STORE_NAME = IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME;
export const BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX = 'browser:';

/** Each part is URI-encoded, as `toStateScopeHttpPath` does, so an id with a colon cannot alias another scope. */
export function toBrowserALRuntimeDbName(scope: StateScope): string {
    const applicationId = encodeURIComponent(scope.applicationId);
    return `${BROWSER_AL_RUNTIME_DB_NAME_PREFIX}${applicationId}:${encodeURIComponent(scope.workspaceId)}`;
}

/** One inbound admission store per browser session, whichever carrier delivered the message (S2b). */
export function toBrowserSessionALInboundRuntimeStoreId(
    sessionId: string
): ALRuntimeStoreId<ALOutboundTransportMessage> {
    return toALRuntimeStoreId(`browser-session-inbound:${sessionId}`);
}

/** WS outbound only since S2b. */
export function toBrowserWsClientALRuntimeStoreId(
    sessionId: string
): ALRuntimeStoreId<ALOutboundTransportMessage> {
    return toALRuntimeStoreId(`browser-ws-client:${sessionId}`);
}

export function toBrowserRtcOverlayALRuntimeStoreId(
    sessionId: string
): ALRuntimeStoreId<ALOutboundTransportMessage> {
    return toALRuntimeStoreId(`browser-rtc-overlay:${sessionId}`);
}

export function toBrowserALRuntimeEntryKeyPrefix(name: string): string {
    return `${BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX}${name}:`;
}

export function toBrowserSessionALRuntimeStoreIds(
    sessionId: string
): readonly ALRuntimeStoreId<ALOutboundTransportMessage>[] {
    return [toBrowserSessionALInboundRuntimeStoreId(sessionId), ...toBrowserSessionALOutboundStoreIds(sessionId)];
}

export function toBrowserSessionALRuntimeEntryKeyPrefixes(
    sessionId: string
): readonly string[] {
    return toBrowserSessionALRuntimeStoreIds(sessionId).map(toBrowserALRuntimeEntryKeyPrefix);
}

/** The namespace an admission store built from this store id actually enqueues work under. */
function toBrowserALRuntimeNamespace(name: string): string {
    return `${BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX}${name}`;
}

/** Every AL_INBOUND/AL_OUTBOUND work namespace one browser session owns: one inbound, four outbound. */
export function toBrowserSessionALRuntimeWorkNamespaces(
    sessionId: string
): readonly string[] {
    return [
        `${toBrowserALRuntimeNamespace(toBrowserSessionALInboundRuntimeStoreId(sessionId))}:inbound:admission`,
        ...toBrowserSessionALOutboundStoreIds(sessionId).map((storeId) =>
            `${toBrowserALRuntimeNamespace(storeId)}:outbound:admission`
        )
    ];
}

/** Both carriers' durable and checkpoint stores. */
function toBrowserSessionALOutboundStoreIds(
    sessionId: string
): readonly ALRuntimeStoreId<ALOutboundTransportMessage>[] {
    return [
        toBrowserWsClientALRuntimeStoreId(sessionId),
        toBrowserRtcOverlayALRuntimeStoreId(sessionId),
        toBrowserWsClientALCheckpointRuntimeStoreId(sessionId),
        toBrowserRtcOverlayALCheckpointRuntimeStoreId(sessionId)
    ];
}
