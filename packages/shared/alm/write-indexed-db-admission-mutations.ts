import { IndexedDbWriteDeadline, waitForIndexedDbTransaction } from '../persistence/indexed-db-request.ts';
import {
    requireLivePersistenceWrite,
    type PersistenceWriteDeadline
} from '../persistence/persistence-write-deadline.ts';
import {
    validateComputedIndexedDbQueueMutations,
    type ComputedIndexedDbQueueMutation
} from '../queuebox/indexed-db-queue-box-entry.ts';
import { submitComputedIndexedDbQueueMutations } from '../queuebox/write-computed-indexed-db-queue-mutations.ts';
import { toError } from '../resilience/to-error.ts';
import { ALAdmissionCorruptionError } from './al-admission-decoder.ts';
import type { IndexedDbAdmissionFence } from './indexed-db-admission-fence.ts';
import type { IndexedDbAdmissionStoredRow } from './indexed-db-admission-row.ts';
import { AL_ADMISSION_WORK_STORE_NAME } from './open-indexed-db-admission-database.ts';
import { readIndexedDbAdmissionWriteFence } from './read-indexed-db-admission-write-fence.ts';

export type IndexedDbAdmissionMutation =
    | Readonly<{ kind: 'set'; stored: IndexedDbAdmissionStoredRow; }>
    | Readonly<{ kind: 'remove'; key: string; }>
    | Readonly<{
        kind: 'remove-if-write-token';
        key: string;
        expectedWriteToken: string;
    }>;

type IndexedDbAdmissionGuardedRemoval = Extract<IndexedDbAdmissionMutation, { kind: 'remove-if-write-token'; }>;

export interface WriteIndexedDbAdmissionMutationsInput {
    readonly deadline?: PersistenceWriteDeadline;
    readonly db: IDBDatabase;
    readonly fence: IndexedDbAdmissionFence;
    readonly mutations: readonly IndexedDbAdmissionMutation[];
    readonly queueMutations: readonly ComputedIndexedDbQueueMutation[];
    readonly storeName: string;
}

interface IndexedDbAdmissionWriteContext {
    readonly eligibility: IndexedDbWriteDeadline;
    readonly guardedRemovals: readonly IndexedDbAdmissionGuardedRemoval[];
    readonly input: WriteIndexedDbAdmissionMutationsInput;
    readonly store: IDBObjectStore;
    readonly transaction: IDBTransaction;
    conflict: boolean;
    storedValueError: Error | undefined;
}

export async function writeIndexedDbAdmissionMutations(
    input: WriteIndexedDbAdmissionMutationsInput
): Promise<boolean> {
    const guardedRemovals = input.mutations.filter(
        (mutation): mutation is IndexedDbAdmissionGuardedRemoval => mutation.kind === 'remove-if-write-token'
    );
    const validatedQueue = validateComputedIndexedDbQueueMutations(input.queueMutations);
    if (validatedQueue.left) {
        throw validatedQueue.left;
    }
    requireLivePersistenceWrite(input.deadline?.expiresAtMs ?? null, input.deadline?.nowMs() ?? 0);
    const storeNames = input.queueMutations.length === 0
        ? [input.storeName]
        : [input.storeName, AL_ADMISSION_WORK_STORE_NAME];
    const transaction = input.db.transaction(storeNames, 'readwrite');
    const completed = waitForIndexedDbTransaction(transaction);
    const store = transaction.objectStore(input.storeName);
    const eligibility = new IndexedDbWriteDeadline(transaction, input.deadline);
    const queueWrite = input.queueMutations.length === 0
        ? undefined
        : submitComputedIndexedDbQueueMutations(
            transaction.objectStore(AL_ADMISSION_WORK_STORE_NAME),
            input.queueMutations,
            eligibility
        );
    const context: IndexedDbAdmissionWriteContext = {
        eligibility,
        guardedRemovals,
        input,
        store,
        transaction,
        conflict: false,
        storedValueError: undefined
    };
    readIndexedDbAdmissionWriteFence({
        eligibility,
        fence: input.fence,
        store,
        onMatched: () => continueIndexedDbAdmissionWrite(context),
        onConflict: () => conflictIndexedDbAdmissionWrite(context),
        onCorruption: (key, error) => abortIndexedDbAdmissionWrite(context, key, error),
        settled: () => isIndexedDbAdmissionWriteSettled(context)
    });
    try {
        await completed;
        return true;
    }
    catch (error) {
        if (eligibility.expired) {
            throw eligibility.expired;
        }
        if (context.storedValueError) {
            throw context.storedValueError;
        }
        if (queueWrite?.storedValueError) {
            throw queueWrite.storedValueError;
        }
        if (context.conflict || queueWrite?.conflict) {
            return false;
        }
        throw transaction.error ?? toError(error);
    }
}

function continueIndexedDbAdmissionWrite(context: IndexedDbAdmissionWriteContext): void {
    if (context.eligibility.expired) {
        return;
    }
    if (context.guardedRemovals.length === 0) {
        applyIndexedDbAdmissionMutations(context);
        return;
    }
    readGuardedIndexedDbAdmissionRemovals(context, context.guardedRemovals);
}

function conflictIndexedDbAdmissionWrite(context: IndexedDbAdmissionWriteContext): void {
    context.conflict = true;
    context.transaction.abort();
}

/** A decided write ignores every re-read still in flight: its transaction is already aborting. */
function isIndexedDbAdmissionWriteSettled(context: IndexedDbAdmissionWriteContext): boolean {
    return context.conflict ||
        context.storedValueError !== undefined ||
        context.eligibility.expired !== undefined;
}

function readGuardedIndexedDbAdmissionRemovals(
    context: IndexedDbAdmissionWriteContext,
    removals: readonly IndexedDbAdmissionGuardedRemoval[]
): void {
    let remaining = removals.length;
    for (const removal of removals) {
        const request = context.eligibility.observe(context.store.get(removal.key));
        request.onsuccess = () => {
            if (isIndexedDbAdmissionWriteSettled(context)) {
                return;
            }
            let currentWriteToken: string | undefined;
            try {
                currentWriteToken = readIndexedDbAdmissionWriteToken(request.result, removal.key);
            }
            catch (error) {
                abortIndexedDbAdmissionWrite(context, removal.key, toError(error));
                return;
            }
            if (currentWriteToken !== removal.expectedWriteToken) {
                conflictIndexedDbAdmissionWrite(context);
                return;
            }
            remaining -= 1;
            if (remaining === 0) {
                applyIndexedDbAdmissionMutations(context);
            }
        };
    }
}

function abortIndexedDbAdmissionWrite(
    context: IndexedDbAdmissionWriteContext,
    key: string,
    error: Error
): void {
    context.storedValueError = error instanceof ALAdmissionCorruptionError
        ? error
        : new ALAdmissionCorruptionError(key, toError(error));
    context.transaction.abort();
}

function readIndexedDbAdmissionWriteToken(
    value: IDBRequest['result'],
    expectedKey: string
): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('IndexedDB admission row must be a record');
    }
    const key = Object.getOwnPropertyDescriptor(value, 'key');
    if (!key || !Object.hasOwn(key, 'value') || key.value !== expectedKey) {
        throw new TypeError('IndexedDB admission row key differs from the requested key');
    }
    const writeToken = Object.getOwnPropertyDescriptor(value, 'writeToken');
    if (!writeToken || !Object.hasOwn(writeToken, 'value') || typeof writeToken.value !== 'string') {
        throw new TypeError('IndexedDB admission write token must be a string data field');
    }
    return writeToken.value;
}

function applyIndexedDbAdmissionMutations(
    context: IndexedDbAdmissionWriteContext
): void {
    const { store, input, eligibility } = context;
    for (const mutation of input.mutations) {
        mutation.kind === 'set'
            ? eligibility.observe(store.put(mutation.stored))
            : eligibility.observe(store.delete(mutation.key));
    }
}
