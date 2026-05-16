import {
    type ALRuntimeStoreFactories,
    type ALRuntimeStoreScope,
    configureALRuntimeStoreScopes,
    resolveALInboundRuntimeStores,
    resolveALOutboundRuntimeStores,
} from '@shared/alm/ALRuntimeStoreRegistry.ts';
import type { ALInboundRuntimeStores } from '@shared/alm/ALInboundMessageRuntime.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/ALOutboundMessageRuntime.ts';
import type { ALRuntimeStoreFactoryOptions } from '@shared/alm/ALRuntimeStores.ts';
import {
    createIndexedDbALInboundRuntimeStores,
    createIndexedDbALOutboundRuntimeStores,
    createInMemoryALInboundRuntimeStores,
    createInMemoryALOutboundRuntimeStores,
    isIndexedDbALRuntimeStoreSupported,
} from '@shared/alm/ALRuntimeStores.ts';
import { IndexedDbStringPersistenceProvider } from '@shared/persistence/IndexedDbStringPersistenceProvider.ts';
import { openIndexedDbWithStore } from '@shared/persistence/openIndexedDb.ts';

export const BROWSER_AL_RUNTIME_DB_NAME = 'ar-eye-hunter-al-runtime';
export const BROWSER_AL_RUNTIME_STORE_NAME =
    IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME;
export const BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX = 'browser:';

type BrowserALRuntimeOptions =
    Omit<ALRuntimeStoreFactoryOptions, 'dbName' | 'namespace'>;

type RuntimeStoreDirection = 'inbound' | 'outbound';

type BrowserALRuntimeStoredEntry = Readonly<{
    key: string;
    expireAtTimestamp: number;
}>;

export type BrowserALRuntimeCleanupResult = Readonly<{
    dbName: string;
    storeName: string;
    keyPrefixes: readonly string[];
    scanned: number;
    deleted: number;
}>;

export type DeleteExpiredBrowserALRuntimeEntriesOptions = Readonly<{
    nowMs?: number;
    keyPrefixes?: readonly string[];
}>;

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
    sessionId: string,
): readonly string[] {
    return [
        toBrowserALRuntimeEntryKeyPrefix(toBrowserWsClientALRuntimeStoreId(sessionId)),
        toBrowserALRuntimeEntryKeyPrefix(toBrowserRtcRxALRuntimeStoreId(sessionId)),
        toBrowserALRuntimeEntryKeyPrefix(toBrowserRtcOverlayALRuntimeStoreId(sessionId)),
    ];
}

function createBrowserALRuntimeStores(
    direction: 'inbound',
    name: string,
    options?: BrowserALRuntimeOptions,
): ALInboundRuntimeStores;
function createBrowserALRuntimeStores(
    direction: 'outbound',
    name: string,
    options?: BrowserALRuntimeOptions,
): ALOutboundRuntimeStores;
function createBrowserALRuntimeStores(
    direction: RuntimeStoreDirection,
    name: string,
    options: BrowserALRuntimeOptions = {},
): ALInboundRuntimeStores | ALOutboundRuntimeStores {
    if (!isIndexedDbALRuntimeStoreSupported()) {
        return direction === 'inbound'
            ? createInMemoryALInboundRuntimeStores(options)
            : createInMemoryALOutboundRuntimeStores(options);
    }

    const persistentOptions = {
        ...options,
        dbName: BROWSER_AL_RUNTIME_DB_NAME,
        namespace: `browser:${name}`,
    };

    return direction === 'inbound'
        ? createIndexedDbALInboundRuntimeStores(persistentOptions)
        : createIndexedDbALOutboundRuntimeStores(persistentOptions);
}

function createBrowserRuntimeStoreFactories(
    name: string,
    directions: Readonly<{
        inbound?: boolean;
        outbound?: boolean;
    }>,
    options: BrowserALRuntimeOptions,
): ALRuntimeStoreFactories {
    return {
        createInboundStores: directions.inbound
            ? () => createBrowserALInboundRuntimeStores(name, options)
            : undefined,
        createOutboundStores: directions.outbound
            ? () => createBrowserALOutboundRuntimeStores(name, options)
            : undefined,
    };
}

function toBrowserRuntimeStoreScopes(
    sessionId: string,
    options: BrowserALRuntimeOptions,
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
                options,
            ),
        },
        {
            id: rtcRxId,
            factories: createBrowserRuntimeStoreFactories(
                rtcRxId,
                { inbound: true },
                options,
            ),
        },
        {
            id: rtcOverlayId,
            factories: createBrowserRuntimeStoreFactories(
                rtcOverlayId,
                { outbound: true },
                options,
            ),
        },
    ];
}

function resolveBrowserALRuntimeStores(
    direction: 'inbound',
    sessionId: string,
    toRuntimeStoreId: (sessionId: string) => string,
): ALInboundRuntimeStores;
function resolveBrowserALRuntimeStores(
    direction: 'outbound',
    sessionId: string,
    toRuntimeStoreId: (sessionId: string) => string,
): ALOutboundRuntimeStores;
function resolveBrowserALRuntimeStores(
    direction: RuntimeStoreDirection,
    sessionId: string,
    toRuntimeStoreId: (sessionId: string) => string,
): ALInboundRuntimeStores | ALOutboundRuntimeStores {
    const runtimeStoreId = toRuntimeStoreId(sessionId);

    return direction === 'inbound'
        ? resolveALInboundRuntimeStores(runtimeStoreId)
        : resolveALOutboundRuntimeStores(runtimeStoreId);
}

export function createBrowserALInboundRuntimeStores(
    name: string,
    options: BrowserALRuntimeOptions = {},
): ALInboundRuntimeStores {
    return createBrowserALRuntimeStores('inbound', name, options);
}

export function createBrowserALOutboundRuntimeStores(
    name: string,
    options: BrowserALRuntimeOptions = {},
): ALOutboundRuntimeStores {
    return createBrowserALRuntimeStores('outbound', name, options);
}

export function configureBrowserALRuntimeStores(
    sessionId: string,
    options: BrowserALRuntimeOptions = {},
): void {
    configureALRuntimeStoreScopes(toBrowserRuntimeStoreScopes(sessionId, options));
}

export async function deleteExpiredBrowserALRuntimeEntries(
    options: DeleteExpiredBrowserALRuntimeEntriesOptions = {},
): Promise<BrowserALRuntimeCleanupResult> {
    const nowMs = options.nowMs ?? Date.now();

    return await deleteBrowserALRuntimeEntriesMatching({
        keyPrefixes: options.keyPrefixes ?? [BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX],
        shouldDelete: (entry) => isExpiredBrowserALRuntimeEntry(entry, nowMs),
    });
}

export async function deleteExpiredBrowserALRuntimeEntriesForSession(
    sessionId: string,
    options: Omit<DeleteExpiredBrowserALRuntimeEntriesOptions, 'keyPrefixes'> = {},
): Promise<BrowserALRuntimeCleanupResult> {
    return await deleteExpiredBrowserALRuntimeEntries({
        ...options,
        keyPrefixes: toBrowserSessionALRuntimeEntryKeyPrefixes(sessionId),
    });
}

export async function deleteBrowserALRuntimeEntriesForSession(
    sessionId: string,
): Promise<BrowserALRuntimeCleanupResult> {
    return await deleteBrowserALRuntimeEntriesMatching({
        keyPrefixes: toBrowserSessionALRuntimeEntryKeyPrefixes(sessionId),
        shouldDelete: () => true,
    });
}

export function resolveBrowserWsClientALInboundRuntimeStores(
    sessionId: string,
): ALInboundRuntimeStores {
    return resolveBrowserALRuntimeStores(
        'inbound',
        sessionId,
        toBrowserWsClientALRuntimeStoreId,
    );
}

export function resolveBrowserWsClientALOutboundRuntimeStores(
    sessionId: string,
): ALOutboundRuntimeStores {
    return resolveBrowserALRuntimeStores(
        'outbound',
        sessionId,
        toBrowserWsClientALRuntimeStoreId,
    );
}

export function resolveBrowserRtcRxALInboundRuntimeStores(
    sessionId: string,
): ALInboundRuntimeStores {
    return resolveBrowserALRuntimeStores(
        'inbound',
        sessionId,
        toBrowserRtcRxALRuntimeStoreId,
    );
}

export function resolveBrowserRtcOverlayALOutboundRuntimeStores(
    sessionId: string,
): ALOutboundRuntimeStores {
    return resolveBrowserALRuntimeStores(
        'outbound',
        sessionId,
        toBrowserRtcOverlayALRuntimeStoreId,
    );
}

async function deleteBrowserALRuntimeEntriesMatching(
    options: Readonly<{
        keyPrefixes: readonly string[];
        shouldDelete: (entry: BrowserALRuntimeStoredEntry) => boolean;
    }>,
): Promise<BrowserALRuntimeCleanupResult> {
    const keyPrefixes = [...new Set(options.keyPrefixes)].filter(prefix => prefix.length > 0);
    const emptyResult = toBrowserALRuntimeCleanupResult(keyPrefixes, 0, 0);

    if (keyPrefixes.length === 0 || !isIndexedDbALRuntimeStoreSupported()) {
        return emptyResult;
    }

    const db = await openIndexedDbWithStore(
        BROWSER_AL_RUNTIME_DB_NAME,
        {
            name: BROWSER_AL_RUNTIME_STORE_NAME,
            keyPath: 'key',
        },
    );

    try {
        return await new Promise<BrowserALRuntimeCleanupResult>((resolve, reject) => {
            const tx = db.transaction(BROWSER_AL_RUNTIME_STORE_NAME, 'readwrite');
            const store = tx.objectStore(BROWSER_AL_RUNTIME_STORE_NAME);
            const request = store.openCursor();
            let scanned = 0;
            let deleted = 0;

            tx.oncomplete = () => resolve(
                toBrowserALRuntimeCleanupResult(keyPrefixes, scanned, deleted),
            );
            tx.onabort = () => reject(tx.error ?? new Error('Browser AL runtime cleanup aborted'));
            tx.onerror = () => reject(tx.error ?? new Error('Browser AL runtime cleanup failed'));
            request.onerror = () => reject(
                request.error ?? new Error('Browser AL runtime cleanup cursor failed'),
            );
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    return;
                }

                const entry = cursor.value as BrowserALRuntimeStoredEntry;
                if (!matchesAnyBrowserALRuntimePrefix(entry.key, keyPrefixes)) {
                    cursor.continue();
                    return;
                }

                scanned += 1;
                if (!options.shouldDelete(entry)) {
                    cursor.continue();
                    return;
                }

                deleted += 1;
                const deleteRequest = cursor.delete();
                deleteRequest.onerror = () => reject(
                    deleteRequest.error
                    ?? new Error('Browser AL runtime cleanup delete failed'),
                );
                deleteRequest.onsuccess = () => cursor.continue();
            };
        });
    } finally {
        db.close();
    }
}

function toBrowserALRuntimeCleanupResult(
    keyPrefixes: readonly string[],
    scanned: number,
    deleted: number,
): BrowserALRuntimeCleanupResult {
    return {
        dbName: BROWSER_AL_RUNTIME_DB_NAME,
        storeName: BROWSER_AL_RUNTIME_STORE_NAME,
        keyPrefixes,
        scanned,
        deleted,
    };
}

function matchesAnyBrowserALRuntimePrefix(
    key: string,
    keyPrefixes: readonly string[],
): boolean {
    return keyPrefixes.some(prefix => key.startsWith(prefix));
}

function isExpiredBrowserALRuntimeEntry(
    entry: BrowserALRuntimeStoredEntry,
    nowMs: number,
): boolean {
    return !Number.isFinite(entry.expireAtTimestamp)
        || entry.expireAtTimestamp <= nowMs;
}
