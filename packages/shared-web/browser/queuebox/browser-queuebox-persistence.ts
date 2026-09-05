import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/indexed-db-queue-box.ts';
import { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { tryRunInIntervals } from '@shared/resilience/TryWith.ts';
import { BROWSER_AL_RUNTIME_DB_NAME } from '../al-runtime/browser-al-runtime-identity.ts';

const BROWSER_QUEUEBOX_EXPIRY_EVICTION_INTERVAL_MS = 15_000;
const BROWSER_QUEUEBOX_STORE_NAME_PREFIX = 'queuebox:';

type BrowserQueueBoxCleanupStoreResult = Readonly<{
    storeName: string;
    deleted: number;
}>;

type BrowserQueueBoxCleanupResult = Readonly<{
    sessionId?: string;
    stores: readonly BrowserQueueBoxCleanupStoreResult[];
    deleted: number;
}>;

type DeleteExpiredBrowserQueueBoxEntriesOptions = Readonly<{
    storeNames?: readonly string[];
}>;

let browserQueueBoxExpiryEvictionPromise: Promise<void> | undefined;

export function createBrowserQueueBox(name: string): QueueBoxResourceEntryRepository {
    if (IndexedDbQueueBox.isSupported()) {
        const storeName = toBrowserQueueBoxStoreName(name);
        return new IndexedDbQueueBox({
            dbName: toBrowserQueueBoxDatabaseName(storeName),
            storeName
        });
    }

    return new InMemoryQueueBox();
}

function toBrowserQueueBoxStoreName(name: string): string {
    return `${BROWSER_QUEUEBOX_STORE_NAME_PREFIX}${name}`;
}

function toBrowserQueueBoxDatabaseName(storeName: string): string {
    return `${BROWSER_AL_RUNTIME_DB_NAME}:${storeName}`;
}

function toBrowserSessionQueueBoxStoreNames(
    sessionId: string
): readonly string[] {
    return [
        toBrowserQueueBoxStoreName(`ws-inbox-${sessionId}`),
        toBrowserQueueBoxStoreName(`ws-outbox-${sessionId}`),
        toBrowserQueueBoxStoreName(`rtc-inbox-${sessionId}`),
        toBrowserQueueBoxStoreName(`rtc-overlay-outbox-${sessionId}`)
    ];
}

export async function deleteBrowserQueueBoxDatabasesForSession(
    sessionId: string
): Promise<void> {
    if (!IndexedDbQueueBox.isSupported()) {
        return;
    }
    const existingStoreNames = new Set(await readBrowserQueueBoxStoreNames());
    await Promise.all(
        toBrowserSessionQueueBoxStoreNames(sessionId)
            .filter((storeName) => existingStoreNames.has(storeName))
            .map((storeName) => deleteIndexedDbDatabase(toBrowserQueueBoxDatabaseName(storeName)))
    );
}

async function deleteExpiredBrowserQueueBoxEntries(
    options: DeleteExpiredBrowserQueueBoxEntriesOptions = {}
): Promise<BrowserQueueBoxCleanupResult> {
    return await deleteExpiredBrowserQueueBoxEntriesMatching(options.storeNames);
}

async function deleteExpiredBrowserQueueBoxEntriesMatching(
    inputStoreNames?: readonly string[],
    sessionId?: string
): Promise<BrowserQueueBoxCleanupResult> {
    if (!IndexedDbQueueBox.isSupported()) {
        return toBrowserQueueBoxCleanupResult(
            inputStoreNames?.map((storeName) => ({
                storeName,
                deleted: 0
            })) ?? [],
            sessionId
        );
    }

    const existingStoreNames = new Set(await readBrowserQueueBoxStoreNames());
    const storeNames = inputStoreNames
        ? [...new Set(inputStoreNames)]
        : [...existingStoreNames];
    const stores: BrowserQueueBoxCleanupStoreResult[] = [];
    for (const storeName of storeNames) {
        if (!existingStoreNames.has(storeName)) {
            stores.push({ storeName, deleted: 0 });
            continue;
        }
        const queueBox = new IndexedDbQueueBox({
            dbName: toBrowserQueueBoxDatabaseName(storeName),
            storeName
        });
        stores.push({
            storeName,
            deleted: await queueBox.deleteExpired()
        });
    }

    return toBrowserQueueBoxCleanupResult(stores, sessionId);
}

async function evictExpiredBrowserQueueBoxEntries(): Promise<BrowserQueueBoxCleanupResult> {
    const result = await deleteExpiredBrowserQueueBoxEntries();
    if (result.deleted > 0) {
        console.log(`Evicted expired browser queuebox rows: ${result.deleted}`);
    }

    return result;
}

export async function initBrowserQueueBoxExpiryEviction(
    intervalMs: number = BROWSER_QUEUEBOX_EXPIRY_EVICTION_INTERVAL_MS
): Promise<void> {
    if (!browserQueueBoxExpiryEvictionPromise) {
        const promise = tryRunInIntervals(
            async () => {
                await evictExpiredBrowserQueueBoxEntries();
            },
            intervalMs
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
    sessionId?: string
): BrowserQueueBoxCleanupResult {
    return {
        sessionId,
        stores,
        deleted: stores.reduce((sum, store) => sum + store.deleted, 0)
    };
}

async function readBrowserQueueBoxStoreNames(): Promise<readonly string[]> {
    const databaseNamePrefix = `${BROWSER_AL_RUNTIME_DB_NAME}:`;
    const databases = await indexedDB.databases();
    return databases
        .flatMap(({ name }) => {
            if (!name?.startsWith(databaseNamePrefix)) {
                return [];
            }
            const storeName = name.slice(databaseNamePrefix.length);
            return storeName.startsWith(BROWSER_QUEUEBOX_STORE_NAME_PREFIX) ? [storeName] : [];
        })
        .sort();
}

async function deleteIndexedDbDatabase(databaseName: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(databaseName);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error('Browser queuebox database deletion failed'));
        request.onblocked = () => reject(new Error('Browser queuebox database deletion was blocked'));
    });
}
