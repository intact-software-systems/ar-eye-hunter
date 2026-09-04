export type StoredIndexedDbValue<Value> = Readonly<{
    key: string;
    value: Value;
    expireAtTimestamp: number;
}>;

export type ComputedIndexedDbStringDeletion = Readonly<{
    key: string;
    expectedExpireAtTimestamp: number;
}>;

export async function writeComputedIndexedDbStringValue<Value>(
    db: IDBDatabase,
    storeName: string,
    stored: StoredIndexedDbValue<Value>
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const request = tx.objectStore(storeName).put(stored);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB setItem aborted'));
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB setItem failed'));
        request.onerror = () => reject(request.error ?? new Error('IndexedDB put failed'));
    });
}

export async function removeComputedIndexedDbStringValue(
    db: IDBDatabase,
    storeName: string,
    key: string
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const request = tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB removeItem aborted'));
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB removeItem failed'));
        request.onerror = () => reject(request.error ?? new Error('IndexedDB delete failed'));
    });
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
        tx.onerror = () => {
            if (!conflict) {
                reject(tx.error ?? new Error('IndexedDB computed delete failed'));
            }
        };

        for (const deletion of deletions) {
            const getRequest = store.get(deletion.key);
            getRequest.onerror = () => {
                if (!conflict) {
                    reject(getRequest.error ?? new Error('IndexedDB computed delete compare failed'));
                }
            };
            getRequest.onsuccess = () => {
                if (conflict) {
                    return;
                }
                const current = getRequest.result as
                    | Readonly<{
                        expireAtTimestamp: number;
                    }>
                    | undefined;
                if (current?.expireAtTimestamp !== deletion.expectedExpireAtTimestamp) {
                    conflict = true;
                    tx.abort();
                    return;
                }
                const deleteRequest = store.delete(deletion.key);
                deleteRequest.onerror = () => {
                    if (!conflict) {
                        reject(deleteRequest.error ?? new Error('IndexedDB computed delete failed'));
                    }
                };
            };
        }
    });
}
