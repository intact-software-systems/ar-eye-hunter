import { BROWSER_AL_RUNTIME_DB_NAME } from './browser-al-runtime-stores.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/IndexedDbQueueBox.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { QueueBoxResourceEntryRepository } from '@shared/queuebox/QueueBoxTypes.ts';
import { tryRunInIntervals } from '@shared/resilience/TryWith.ts';

export const BROWSER_QUEUEBOX_EXPIRY_EVICTION_INTERVAL_MS = 15_000;
export const BROWSER_QUEUEBOX_STORE_NAME_PREFIX = 'queuebox:';

export type BrowserQueueBoxCleanupStoreResult = Readonly<{
    storeName: string;
    deleted: number;
}>;

export type BrowserQueueBoxCleanupResult = Readonly<{
    dbName: string;
    sessionId?: string;
    stores: readonly BrowserQueueBoxCleanupStoreResult[];
    deleted: number;
}>;

export type DeleteExpiredBrowserQueueBoxEntriesOptions = Readonly<{
    storeNames?: readonly string[];
}>;

let browserQueueBoxExpiryEvictionPromise: Promise<void> | undefined;

export function createBrowserQueueBox(name: string): QueueBoxResourceEntryRepository {
    if (IndexedDbQueueBox.isSupported()) {
        return new IndexedDbQueueBox({
            dbName: BROWSER_AL_RUNTIME_DB_NAME,
            storeName: toBrowserQueueBoxStoreName(name),
        });
    }

    return new InMemoryQueueBox();
}

export function toBrowserQueueBoxStoreName(name: string): string {
    return `${BROWSER_QUEUEBOX_STORE_NAME_PREFIX}${name}`;
}

export function toBrowserSessionQueueBoxStoreNames(
    sessionId: string,
): readonly string[] {
    return [
        toBrowserQueueBoxStoreName(`ws-inbox-${sessionId}`),
        toBrowserQueueBoxStoreName(`ws-outbox-${sessionId}`),
        toBrowserQueueBoxStoreName(`rtc-inbox-${sessionId}`),
        toBrowserQueueBoxStoreName(`rtc-overlay-outbox-${sessionId}`),
    ];
}

export async function deleteExpiredBrowserQueueBoxEntriesForSession(
    sessionId: string,
): Promise<BrowserQueueBoxCleanupResult> {
    return await deleteExpiredBrowserQueueBoxEntriesMatching(
        toBrowserSessionQueueBoxStoreNames(sessionId),
        sessionId,
    );
}

export async function deleteExpiredBrowserQueueBoxEntries(
    options: DeleteExpiredBrowserQueueBoxEntriesOptions = {},
): Promise<BrowserQueueBoxCleanupResult> {
    return await deleteExpiredBrowserQueueBoxEntriesMatching(options.storeNames);
}

async function deleteExpiredBrowserQueueBoxEntriesMatching(
    inputStoreNames?: readonly string[],
    sessionId?: string,
): Promise<BrowserQueueBoxCleanupResult> {
    if (!IndexedDbQueueBox.isSupported()) {
        return toBrowserQueueBoxCleanupResult(
            inputStoreNames?.map(storeName => ({
                storeName,
                deleted: 0,
            })) ?? [],
            sessionId,
        );
    }

    const storeNames = inputStoreNames
        ? [...new Set(inputStoreNames)]
        : await readBrowserQueueBoxStoreNames();
    const stores: BrowserQueueBoxCleanupStoreResult[] = [];
    for (const storeName of storeNames) {
        const queueBox = new IndexedDbQueueBox({
            dbName: BROWSER_AL_RUNTIME_DB_NAME,
            storeName,
        });
        stores.push({
            storeName,
            deleted: await queueBox.deleteExpired(),
        });
    }

    return toBrowserQueueBoxCleanupResult(stores, sessionId);
}

export async function evictExpiredBrowserQueueBoxEntriesForSession(
    sessionId: string,
): Promise<BrowserQueueBoxCleanupResult> {
    const result = await deleteExpiredBrowserQueueBoxEntriesForSession(sessionId);
    if (result.deleted > 0) {
        console.log(
            `Evicted expired browser queuebox rows for session ${sessionId}: ${result.deleted}`,
        );
    }

    return result;
}

export async function evictExpiredBrowserQueueBoxEntries(): Promise<BrowserQueueBoxCleanupResult> {
    const result = await deleteExpiredBrowserQueueBoxEntries();
    if (result.deleted > 0) {
        console.log(`Evicted expired browser queuebox rows: ${result.deleted}`);
    }

    return result;
}

export async function initBrowserQueueBoxExpiryEviction(
    intervalMs: number = BROWSER_QUEUEBOX_EXPIRY_EVICTION_INTERVAL_MS,
): Promise<void> {
    if (!browserQueueBoxExpiryEvictionPromise) {
        const promise = tryRunInIntervals(
            async () => {
                await evictExpiredBrowserQueueBoxEntries();
            },
            intervalMs,
        )
            .then(() => undefined)
            .catch((error) => {
                if (browserQueueBoxExpiryEvictionPromise === promise) {
                    browserQueueBoxExpiryEvictionPromise = undefined;
                }
                throw error;
            });
        browserQueueBoxExpiryEvictionPromise = promise;
    }

    return await browserQueueBoxExpiryEvictionPromise;
}

function toBrowserQueueBoxCleanupResult(
    stores: readonly BrowserQueueBoxCleanupStoreResult[],
    sessionId?: string,
): BrowserQueueBoxCleanupResult {
    return {
        dbName: BROWSER_AL_RUNTIME_DB_NAME,
        sessionId,
        stores,
        deleted: stores.reduce((sum, store) => sum + store.deleted, 0),
    };
}

async function readBrowserQueueBoxStoreNames(): Promise<readonly string[]> {
    const db = await openBrowserRuntimeDatabase();

    try {
        return Array.from(db.objectStoreNames)
            .filter(storeName => storeName.startsWith(BROWSER_QUEUEBOX_STORE_NAME_PREFIX))
            .sort();
    } finally {
        db.close();
    }
}

async function openBrowserRuntimeDatabase(): Promise<IDBDatabase> {
    return await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(BROWSER_AL_RUNTIME_DB_NAME);

        request.onerror = () => reject(
            request.error ?? new Error('Browser runtime IndexedDB open failed'),
        );
        request.onsuccess = () => resolve(request.result);
    });
}
