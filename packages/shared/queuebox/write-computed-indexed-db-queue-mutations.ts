import type {
    ComputedIndexedDbQueueMutation,
    StoredResourceEntry
} from './indexed-db-queue-box-entry.ts';

export async function writeComputedIndexedDbQueueMutations(
    db: IDBDatabase,
    storeName: string,
    mutations: readonly ComputedIndexedDbQueueMutation[]
): Promise<boolean> {
    if (mutations.length === 0) {
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
            reject(tx.error ?? new Error('IndexedDB computed queue write aborted'));
        };
        tx.onerror = () => {
            if (!conflict) {
                reject(tx.error ?? new Error('IndexedDB computed queue write failed'));
            }
        };

        for (const mutation of mutations) {
            if (mutation.expectedRevision === undefined) {
                const request = mutation.value
                    ? store.put(mutation.value)
                    : store.delete(mutation.keyString);
                request.onerror = () =>
                    reject(
                        request.error ?? new Error('IndexedDB computed queue mutation failed')
                    );
                continue;
            }

            const getRequest = store.get(mutation.keyString);
            getRequest.onerror = () => {
                if (!conflict) {
                    reject(getRequest.error ?? new Error('IndexedDB computed queue compare failed'));
                }
            };
            getRequest.onsuccess = () => {
                if (conflict) {
                    return;
                }
                const current = getRequest.result as StoredResourceEntry | undefined;
                const actualRevision = current ? current.revision ?? 0 : null;
                if (actualRevision !== mutation.expectedRevision) {
                    conflict = true;
                    tx.abort();
                    return;
                }
                const writeRequest = mutation.value
                    ? store.put(mutation.value)
                    : store.delete(mutation.keyString);
                writeRequest.onerror = () => {
                    if (!conflict) {
                        reject(
                            writeRequest.error ?? new Error('IndexedDB computed queue mutation failed')
                        );
                    }
                };
            };
        }
    });
}
