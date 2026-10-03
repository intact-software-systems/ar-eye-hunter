import { IndexedDbWriteDeadline, waitForIndexedDbTransaction } from '../persistence/indexed-db-request.ts';
import {
    requireLivePersistenceWrite,
    type PersistenceWriteDeadline
} from '../persistence/persistence-write-deadline.ts';
import { toError } from '../resilience/to-error.ts';
import type {
    ComputedIndexedDbQueueMutation,
    IndexedDbQueueExpectedState
} from './indexed-db-queue-box-entry.ts';
import { validateComputedIndexedDbQueueMutations } from './indexed-db-queue-box-entry.ts';

export interface IndexedDbQueueWriteState {
    conflict: boolean;
    storedValueError: Error | undefined;
}

export interface WriteComputedIndexedDbQueueMutationsInput {
    readonly db: IDBDatabase;
    readonly storeName: string;
    readonly mutations: readonly ComputedIndexedDbQueueMutation[];
    readonly deadline?: PersistenceWriteDeadline;
}

export async function writeComputedIndexedDbQueueMutations(
    input: WriteComputedIndexedDbQueueMutationsInput
): Promise<boolean> {
    const { db, storeName, mutations, deadline } = input;
    const validated = validateComputedIndexedDbQueueMutations(mutations);
    if (validated.left) {
        throw validated.left;
    }
    requireLivePersistenceWrite(deadline?.expiresAtMs ?? null, deadline?.nowMs() ?? 0);
    if (mutations.length === 0) {
        return true;
    }
    const transaction = db.transaction(storeName, 'readwrite');
    const completed = waitForIndexedDbTransaction(transaction);
    const eligibility = new IndexedDbWriteDeadline(transaction, deadline);
    const state = submitComputedIndexedDbQueueMutations({
        store: transaction.objectStore(storeName),
        mutations,
        eligibility,
        onIssued: () => undefined
    });
    try {
        await completed;
        return true;
    }
    catch (error) {
        if (eligibility.expired) {
            throw eligibility.expired;
        }
        if (state.storedValueError) {
            throw state.storedValueError;
        }
        if (state.conflict) {
            return false;
        }
        throw transaction.error ?? toError(error);
    }
}

export interface SubmitComputedIndexedDbQueueMutationsInput {
    readonly store: IDBObjectStore;
    readonly mutations: readonly ComputedIndexedDbQueueMutation[];
    readonly eligibility: IndexedDbWriteDeadline;
    /**
     * Runs once the last request of the mutations is issued: a compare-and-set issues its write from its
     * read's callback. A conflict, a stored-value error or an expiry ends the write before it runs.
     */
    readonly onIssued: () => void;
}

/** The transaction owner validates the candidate before opening its transaction and observes completion. */
export function submitComputedIndexedDbQueueMutations(
    input: SubmitComputedIndexedDbQueueMutationsInput
): Readonly<IndexedDbQueueWriteState> {
    const { store, eligibility } = input;
    const state: IndexedDbQueueWriteState = { conflict: false, storedValueError: undefined };
    let unissued = input.mutations.filter((mutation) => !isUnconditionalIndexedDbQueueMutation(mutation)).length;
    for (const mutation of input.mutations) {
        if (mutation.kind === 'delete-unconditionally') {
            eligibility.observe(store.delete(mutation.keyString));
            continue;
        }
        if (mutation.kind === 'put-unconditionally') {
            eligibility.observe(store.put(mutation.value));
            continue;
        }
        const request = eligibility.observe(store.get(mutation.keyString));
        request.onsuccess = () => {
            if (state.conflict || state.storedValueError || eligibility.expired) {
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
                eligibility.observe(store.put(mutation.value));
            }
            else if (mutation.kind === 'delete') {
                eligibility.observe(store.delete(mutation.keyString));
            }
            unissued -= 1;
            if (unissued === 0) {
                input.onIssued();
            }
        };
    }
    if (unissued === 0) {
        input.onIssued();
    }
    return state;
}

function isUnconditionalIndexedDbQueueMutation(mutation: ComputedIndexedDbQueueMutation): boolean {
    return mutation.kind === 'delete-unconditionally' || mutation.kind === 'put-unconditionally';
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
