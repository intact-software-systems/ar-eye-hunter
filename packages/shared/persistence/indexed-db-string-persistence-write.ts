import { waitForIndexedDbTransaction } from './indexed-db-request.ts';

export type StoredIndexedDbValue<Value> = Readonly<{
    key: string;
    value: Value;
    expireAtTimestamp: number;
    writeToken?: string;
}>;

export type ComputedIndexedDbStringDeletion = Readonly<{
    key: string;
    expectedExpireAtTimestamp: number;
    expectedWriteToken: string;
}>;

export async function writeComputedIndexedDbStringValue<Value>(
    db: IDBDatabase,
    storeName: string,
    stored: StoredIndexedDbValue<Value>
): Promise<void> {
    const transaction = db.transaction(storeName, 'readwrite');
    const completed = waitForIndexedDbTransaction(transaction);
    transaction.objectStore(storeName).put(stored);
    await completed;
}

export async function removeComputedIndexedDbStringValue(
    db: IDBDatabase,
    storeName: string,
    key: string
): Promise<void> {
    const transaction = db.transaction(storeName, 'readwrite');
    const completed = waitForIndexedDbTransaction(transaction);
    transaction.objectStore(storeName).delete(key);
    await completed;
}

export async function deleteComputedIndexedDbStringValues(
    db: IDBDatabase,
    storeName: string,
    deletions: readonly ComputedIndexedDbStringDeletion[]
): Promise<boolean> {
    if (deletions.length === 0) {
        return true;
    }

    return await new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        let conflict = false;
        tx.oncomplete = () => resolve(true);
        tx.onabort = () => {
            if (conflict) {
                resolve(false);
                return;
            }
            reject(tx.error ?? new Error('IndexedDB computed delete aborted'));
        };
        for (const deletion of deletions) {
            const getRequest = store.get(deletion.key);
            getRequest.onsuccess = () => {
                if (conflict) {
                    return;
                }
                const current = getRequest.result as
                    | Readonly<{
                        expireAtTimestamp: number;
                        writeToken?: string;
                    }>
                    | undefined;
                if (
                    current?.expireAtTimestamp !== deletion.expectedExpireAtTimestamp ||
                    current.writeToken !== deletion.expectedWriteToken
                ) {
                    conflict = true;
                    tx.abort();
                    return;
                }
                store.delete(deletion.key);
            };
        }
    });
}
