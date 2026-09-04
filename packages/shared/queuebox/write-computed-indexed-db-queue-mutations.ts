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
        let storedValueError: Error | undefined;

        tx.oncomplete = () => resolve(true);
        tx.onabort = () => {
            if (storedValueError) {
                reject(storedValueError);
                return;
            }
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
                let matches: boolean;
                try {
                    matches = matchesIndexedDbQueueExpectedState(getRequest.result, mutation.expected);
                }
                catch (error) {
                    storedValueError = error instanceof Error ? error : new Error(String(error));
                    tx.abort();
                    return;
                }
                if (!matches) {
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
    current: IDBRequest['result'],
    expected: IndexedDbQueueExpectedState
): boolean {
    switch (expected.kind) {
        case 'missing':
            return current === undefined;
        case 'revision':
            return readIndexedDbQueueRevision(current) === expected.revision;
    }
}

function readIndexedDbQueueRevision(value: IDBRequest['result']): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('IndexedDB queue row must be a record');
    }
    const revision = Object.getOwnPropertyDescriptor(value, 'revision');
    if (
        !revision ||
        !Object.hasOwn(revision, 'value') ||
        typeof revision.value !== 'number' ||
        !Number.isSafeInteger(revision.value) ||
        revision.value < 0 ||
        Object.is(revision.value, -0)
    ) {
        throw new TypeError('IndexedDB queue revision must be a non-negative safe integer data field');
    }
    return revision.value;
}
