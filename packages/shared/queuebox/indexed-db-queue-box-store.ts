import type { StoredResourceEntry } from './indexed-db-queue-box-entry.ts';
import { EntityStatus, type ResourceEntryKeyString } from './ResourceEntry.ts';

export type ReadFairnessStoredQueueEntriesInput = Readonly<{
    db: IDBDatabase;
    indexName: string;
    maxPerType: number;
    overdueBeforeEpochMs: number;
    storeName: string;
    typeIds: readonly string[];
}>;

export async function readStoredQueueEntry(
    db: IDBDatabase,
    storeName: string,
    keyString: ResourceEntryKeyString
): Promise<StoredResourceEntry | undefined> {
    const entries = await readStoredQueueEntries(db, storeName, [keyString]);
    return entries.get(keyString);
}

export async function readStoredQueueEntries(
    db: IDBDatabase,
    storeName: string,
    keyStrings: readonly ResourceEntryKeyString[]
): Promise<ReadonlyMap<ResourceEntryKeyString, StoredResourceEntry>> {
    if (keyStrings.length === 0) {
        return new Map();
    }

    return await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const entries = new Map<ResourceEntryKeyString, StoredResourceEntry>();

        tx.oncomplete = () => resolve(entries);
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB queue read aborted'));
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB queue read failed'));

        for (const keyString of keyStrings) {
            const request = store.get(keyString);
            request.onerror = () => reject(request.error ?? new Error('IndexedDB queue get failed'));
            request.onsuccess = () => {
                const stored = request.result as StoredResourceEntry | undefined;
                if (stored) {
                    entries.set(keyString, stored);
                }
            };
        }
    });
}

export async function readAllStoredQueueEntries(
    db: IDBDatabase,
    storeName: string
): Promise<readonly StoredResourceEntry[]> {
    return await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const request = tx.objectStore(storeName).openCursor();
        const entries: StoredResourceEntry[] = [];

        tx.oncomplete = () => resolve(entries);
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB queue scan aborted'));
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB queue scan failed'));
        request.onerror = () => reject(request.error ?? new Error('IndexedDB queue cursor failed'));
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
                return;
            }
            entries.push(cursor.value as StoredResourceEntry);
            cursor.continue();
        };
    });
}

export async function readFairnessStoredQueueEntries(
    input: ReadFairnessStoredQueueEntriesInput
): Promise<ReadonlyMap<string, readonly StoredResourceEntry[]>> {
    return await new Promise((resolve, reject) => {
        const tx = input.db.transaction(input.storeName, 'readonly');
        const index = tx.objectStore(input.storeName).index(input.indexName);
        const entriesByType = new Map<string, StoredResourceEntry[]>();

        tx.oncomplete = () => resolve(entriesByType);
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB fairness read aborted'));
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB fairness read failed'));

        for (const typeId of input.typeIds) {
            const entries: StoredResourceEntry[] = [];
            entriesByType.set(typeId, entries);
            const request = index.openCursor(IDBKeyRange.bound(
                [typeId, EntityStatus.RETRY, Number.MIN_SAFE_INTEGER, ''],
                [typeId, EntityStatus.RETRY, input.overdueBeforeEpochMs, '\uffff']
            ));
            request.onerror = () => reject(request.error ?? new Error('IndexedDB fairness cursor failed'));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor || entries.length >= input.maxPerType) {
                    return;
                }
                entries.push(cursor.value as StoredResourceEntry);
                cursor.continue();
            };
        }
    });
}
