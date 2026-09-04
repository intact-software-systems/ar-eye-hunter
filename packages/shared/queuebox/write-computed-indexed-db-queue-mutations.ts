import {
    decodeStoredResourceEntryValue,
    type StoredResourceEntry
} from './indexed-db-queue-box-entry-codec.ts';
import type {
    ComputedIndexedDbQueueMutation,
    IndexedDbQueueExpectedState
} from './indexed-db-queue-box-entry.ts';
import { validateComputedIndexedDbQueueMutations } from './indexed-db-queue-box-entry.ts';

export async function writeComputedIndexedDbQueueMutations(
    db: IDBDatabase,
    storeName: string,
    mutations: readonly ComputedIndexedDbQueueMutation[]
): Promise<boolean> {
    if (mutations.length === 0) {
        return true;
    }
    validateComputedIndexedDbQueueMutations(mutations);

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
        for (const mutation of mutations) {
            if (mutation.kind === 'delete-unconditionally') {
                store.delete(mutation.keyString);
                continue;
            }

            const getRequest = store.get(mutation.keyString);
            getRequest.onsuccess = () => {
                if (conflict) {
                    return;
                }
                const current = getRequest.result === undefined
                    ? undefined
                    : decodeStoredResourceEntryValue(getRequest.result);
                if (!matchesIndexedDbQueueExpectedState(current, mutation.expected)) {
                    conflict = true;
                    tx.abort();
                    return;
                }
                mutation.kind === 'put'
                    ? store.put(mutation.value)
                    : store.delete(mutation.keyString);
            };
        }
    });
}

function matchesIndexedDbQueueExpectedState(
    current: StoredResourceEntry | undefined,
    expected: IndexedDbQueueExpectedState
): boolean {
    switch (expected.kind) {
        case 'missing':
            return current === undefined;
        case 'revision':
            return current?.revision === expected.revision;
    }
}
