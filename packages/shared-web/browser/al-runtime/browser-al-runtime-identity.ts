import { IndexedDbStringPersistenceProvider } from '@shared/persistence/indexed-db-string-persistence-provider.ts';

export const BROWSER_AL_RUNTIME_DB_NAME = 'ar-eye-hunter-al-runtime';
export const BROWSER_AL_RUNTIME_STORE_NAME = IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME;
export const BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX = 'browser:';

export function toBrowserWsClientALRuntimeStoreId(sessionId: string): string {
    return `browser-ws-client:${sessionId}`;
}

export function toBrowserRtcRxALRuntimeStoreId(sessionId: string): string {
    return `browser-rtc-rx:${sessionId}`;
}

export function toBrowserRtcOverlayALRuntimeStoreId(sessionId: string): string {
    return `browser-rtc-overlay:${sessionId}`;
}

export function toBrowserALRuntimeEntryKeyPrefix(name: string): string {
    return `${BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX}${name}:`;
}

export function toBrowserSessionALRuntimeEntryKeyPrefixes(
    sessionId: string
): readonly string[] {
    return [
        toBrowserALRuntimeEntryKeyPrefix(toBrowserWsClientALRuntimeStoreId(sessionId)),
        toBrowserALRuntimeEntryKeyPrefix(toBrowserRtcRxALRuntimeStoreId(sessionId)),
        toBrowserALRuntimeEntryKeyPrefix(toBrowserRtcOverlayALRuntimeStoreId(sessionId))
    ];
}

/** The namespace an admission store built from this store id actually enqueues work under. */
export function toBrowserALRuntimeNamespace(name: string): string {
    return `${BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX}${name}`;
}

/**
 * Every AL_INBOUND/AL_OUTBOUND work namespace one browser session can own, inbound and outbound
 * alike — a store that only owns one direction simply never has rows under its other namespace.
 */
export function toBrowserSessionALRuntimeWorkNamespaces(
    sessionId: string
): readonly string[] {
    return [
        toBrowserWsClientALRuntimeStoreId(sessionId),
        toBrowserRtcRxALRuntimeStoreId(sessionId),
        toBrowserRtcOverlayALRuntimeStoreId(sessionId)
    ].flatMap((storeId) => {
        const namespace = toBrowserALRuntimeNamespace(storeId);
        return [`${namespace}:inbound:admission`, `${namespace}:outbound:admission`];
    });
}
