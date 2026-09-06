import { waitForIndexedDbTransaction } from '../persistence/indexed-db-request.ts';
import { toError } from '../resilience/to-error.ts';
import type {
    ComputedIndexedDbQueueMutation,
    IndexedDbQueueExpectedState
} from './indexed-db-queue-box-entry.ts';
import { validateComputedIndexedDbQueueMutations } from './indexed-db-queue-box-entry.ts';

interface IndexedDbQueueWriteState {
    conflict: boolean;
    storedValueError: Error | undefined;
}

export async function writeComputedIndexedDbQueueMutations(
    db: IDBDatabase,
    storeName: string,
    mutations: readonly ComputedIndexedDbQueueMutation[]
): Promise<boolean> {
    const validated = validateComputedIndexedDbQueueMutations(mutations);
    if (validated.left) {
        throw validated.left;
    }
    if (mutations.length === 0) {
        return true;
    }
    const transaction = db.transaction(storeName, 'readwrite');
    const completed = waitForIndexedDbTransaction(transaction);
    const state = submitComputedIndexedDbQueueMutations(transaction.objectStore(storeName), mutations);
    try {
        await completed;
        return true;
    }
    catch (error) {
        if (state.storedValueError) {
            throw state.storedValueError;
        }
        if (state.conflict) {
            return false;
        }
        throw transaction.error ?? toError(error);
    }
}

/** The transaction owner validates the candidate before opening its transaction and observes completion. */
export function submitComputedIndexedDbQueueMutations(
    store: IDBObjectStore,
    mutations: readonly ComputedIndexedDbQueueMutation[]
): Readonly<IndexedDbQueueWriteState> {
    const state: IndexedDbQueueWriteState = { conflict: false, storedValueError: undefined };
    for (const mutation of mutations) {
        if (mutation.kind === 'delete-unconditionally') {
            store.delete(mutation.keyString);
            continue;
        }
        const request = store.get(mutation.keyString);
        request.onsuccess = () => {
            if (state.conflict || state.storedValueError) {
                return;
            }
            let matches: boolean;
            try {
                matches = matchesIndexedDbQueueExpectedState(request.result, mutation.expected);
            }
            catch (error) {
                state.storedValueError = toError(error);
                store.transaction.abort();
                return;
            }
            if (!matches) {
                state.conflict = true;
                store.transaction.abort();
                return;
            }
            if (mutation.kind === 'put') {
                store.put(mutation.value);
            }
            else if (mutation.kind === 'delete') {
                store.delete(mutation.keyString);
            }
        };
    }
    return state;
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
