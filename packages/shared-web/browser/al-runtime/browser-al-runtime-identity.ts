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
