import { isIndexedDbALRuntimeStoreSupported } from '@shared/alm/al-runtime-stores.ts';
import {
    decodeALAdmissionStoredValue,
    type ALAdmissionStoredValue
} from '@shared/alm/al-admission-backend.ts';
import { decodeALAdmissionValue } from '@shared/alm/al-admission-decoder.ts';
import { openIndexedDbWithStore } from '@shared/persistence/openIndexedDb.ts';
import { tryRunInIntervals } from '@shared/resilience/TryWith.ts';

import {
    BROWSER_AL_RUNTIME_DB_NAME,
    BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX,
    BROWSER_AL_RUNTIME_STORE_NAME,
    toBrowserSessionALRuntimeEntryKeyPrefixes
} from './browser-al-runtime-identity.ts';

export const BROWSER_AL_RUNTIME_EXPIRY_EVICTION_INTERVAL_MS = 60_000;

interface BrowserALRuntimeCleanupScan {
    readonly db: IDBDatabase;
    readonly keyPrefixes: readonly string[];
    readonly shouldDelete: (entry: ALAdmissionStoredValue) => boolean;
}

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

let browserALRuntimeExpiryEvictionPromise: Promise<void> | undefined;

export async function deleteExpiredBrowserALRuntimeEntries(
    options: DeleteExpiredBrowserALRuntimeEntriesOptions = {}
): Promise<BrowserALRuntimeCleanupResult> {
    const nowMs = options.nowMs ?? Date.now();

    return await deleteBrowserALRuntimeEntriesMatching({
        keyPrefixes: options.keyPrefixes ?? [BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX],
        shouldDelete: (entry) => isExpiredBrowserALRuntimeEntry(entry, nowMs)
    });
}

export async function deleteExpiredBrowserALRuntimeEntriesForSession(
    sessionId: string,
    options: Omit<DeleteExpiredBrowserALRuntimeEntriesOptions, 'keyPrefixes'> = {}
): Promise<BrowserALRuntimeCleanupResult> {
    return await deleteExpiredBrowserALRuntimeEntries({
        ...options,
        keyPrefixes: toBrowserSessionALRuntimeEntryKeyPrefixes(sessionId)
    });
}

export async function deleteBrowserALRuntimeEntriesForSession(
    sessionId: string
): Promise<BrowserALRuntimeCleanupResult> {
    return await deleteBrowserALRuntimeEntriesMatching({
        keyPrefixes: toBrowserSessionALRuntimeEntryKeyPrefixes(sessionId),
        shouldDelete: () => true
    });
}

export async function evictExpiredBrowserALRuntimeEntries(
    options: DeleteExpiredBrowserALRuntimeEntriesOptions = {}
): Promise<BrowserALRuntimeCleanupResult> {
    const result = await deleteExpiredBrowserALRuntimeEntries(options);
    if (result.deleted > 0) {
        console.log(`Evicted expired browser AL runtime rows: ${result.deleted}`);
    }

    return result;
}

export async function initBrowserALRuntimeExpiryEviction(
    intervalMs: number = BROWSER_AL_RUNTIME_EXPIRY_EVICTION_INTERVAL_MS
): Promise<void> {
    if (!browserALRuntimeExpiryEvictionPromise) {
        const promise = tryRunInIntervals(
            async () => {
                await evictExpiredBrowserALRuntimeEntries();
            },
            intervalMs
        )
            .then(() => undefined)
            .catch((error) => {
                if (browserALRuntimeExpiryEvictionPromise === promise) {
                    browserALRuntimeExpiryEvictionPromise = undefined;
                }
                throw error;
            });
        browserALRuntimeExpiryEvictionPromise = promise;
    }

    return await browserALRuntimeExpiryEvictionPromise;
}

async function deleteBrowserALRuntimeEntriesMatching(
    options: Readonly<{
        keyPrefixes: readonly string[];
        shouldDelete: (entry: ALAdmissionStoredValue) => boolean;
    }>
): Promise<BrowserALRuntimeCleanupResult> {
    const keyPrefixes = [...new Set(options.keyPrefixes)].filter((prefix) => prefix.length > 0);
    const emptyResult = toBrowserALRuntimeCleanupResult(keyPrefixes, 0, 0);

    if (keyPrefixes.length === 0 || !isIndexedDbALRuntimeStoreSupported()) {
        return emptyResult;
    }

    const db = await openIndexedDbWithStore(
        BROWSER_AL_RUNTIME_DB_NAME,
        {
            name: BROWSER_AL_RUNTIME_STORE_NAME,
            keyPath: 'key'
        }
    );

    try {
        return await scanBrowserALRuntimeEntries({
            db,
            keyPrefixes,
            shouldDelete: options.shouldDelete
        });
    }
    finally {
        db.close();
    }
}

function scanBrowserALRuntimeEntries(
    input: BrowserALRuntimeCleanupScan
): Promise<BrowserALRuntimeCleanupResult> {
    return new Promise<BrowserALRuntimeCleanupResult>((resolve, reject) => {
        const tx = input.db.transaction(BROWSER_AL_RUNTIME_STORE_NAME, 'readwrite');
        const store = tx.objectStore(BROWSER_AL_RUNTIME_STORE_NAME);
        const request = store.openCursor();
        let scanned = 0;
        let deleted = 0;

        tx.oncomplete = () =>
            resolve(
                toBrowserALRuntimeCleanupResult(input.keyPrefixes, scanned, deleted)
            );
        tx.onabort = () => reject(tx.error ?? new Error('Browser AL runtime cleanup aborted'));
        tx.onerror = () => reject(tx.error ?? new Error('Browser AL runtime cleanup failed'));
        request.onerror = () =>
            reject(
                request.error ?? new Error('Browser AL runtime cleanup cursor failed')
            );
        request.onsuccess = () => {
            try {
                const cursor = request.result;
                if (!cursor) {
                    return;
                }
                const key = cursor.primaryKey;
                if (typeof key !== 'string') {
                    throw new TypeError('Browser AL runtime cleanup row key must be a string');
                }
                if (!matchesAnyBrowserALRuntimePrefix(key, input.keyPrefixes)) {
                    cursor.continue();
                    return;
                }

                const entry = decodeALAdmissionValue(cursor.value, key, decodeALAdmissionStoredValue);
                scanned += 1;
                if (!input.shouldDelete(entry)) {
                    cursor.continue();
                    return;
                }

                deleted += 1;
                const deleteRequest = cursor.delete();
                deleteRequest.onerror = () =>
                    reject(
                        deleteRequest.error ??
                            new Error('Browser AL runtime cleanup delete failed')
                    );
                deleteRequest.onsuccess = () => cursor.continue();
            }
            catch (error) {
                reject(error);
                tx.abort();
            }
        };
    });
}

function toBrowserALRuntimeCleanupResult(
    keyPrefixes: readonly string[],
    scanned: number,
    deleted: number
): BrowserALRuntimeCleanupResult {
    return {
        dbName: BROWSER_AL_RUNTIME_DB_NAME,
        storeName: BROWSER_AL_RUNTIME_STORE_NAME,
        keyPrefixes,
        scanned,
        deleted
    };
}

function matchesAnyBrowserALRuntimePrefix(
    key: string,
    keyPrefixes: readonly string[]
): boolean {
    return keyPrefixes.some((prefix) => key.startsWith(prefix));
}

function isExpiredBrowserALRuntimeEntry(
    entry: ALAdmissionStoredValue,
    nowMs: number
): boolean {
    return entry.expireAtTimestamp <= nowMs;
}
