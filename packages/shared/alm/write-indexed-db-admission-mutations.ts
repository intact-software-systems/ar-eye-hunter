import { IndexedDbWriteDeadline, waitForIndexedDbTransaction } from '../persistence/indexed-db-request.ts';
import {
    requireLivePersistenceWrite,
    type PersistenceWriteDeadline
} from '../persistence/persistence-write-deadline.ts';
import {
    validateComputedIndexedDbQueueMutations,
    type ComputedIndexedDbQueueMutation
} from '../queuebox/indexed-db-queue-box-entry.ts';
import {
    submitComputedIndexedDbQueueMutations,
    type IndexedDbQueueWriteState
} from '../queuebox/write-computed-indexed-db-queue-mutations.ts';
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
    /** The admission store's requests and the queue's, each issued once its reads matched. */
    unissuedParts: number;
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
    // A request that throws ends this call before `await completed`; the abort it leaves is still handled.
    completed.catch(() => undefined);
    const eligibility = new IndexedDbWriteDeadline(transaction, input.deadline);
    const context: IndexedDbAdmissionWriteContext = {
        eligibility,
        guardedRemovals,
        input,
        store: transaction.objectStore(input.storeName),
        transaction,
        conflict: false,
        storedValueError: undefined,
        unissuedParts: input.queueMutations.length === 0 ? 1 : 2
    };
    const queueWrite = input.queueMutations.length === 0
        ? undefined
        : submitComputedIndexedDbQueueMutations({
            store: transaction.objectStore(AL_ADMISSION_WORK_STORE_NAME),
            mutations: input.queueMutations,
            eligibility,
            onIssued: () => commitIssuedIndexedDbAdmissionWrite(context)
        });
    const { store } = context;
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
        const failure = toIndexedDbAdmissionWriteFailure(context, queueWrite, toError(error));
        if (failure === undefined) {
            return false;
        }
        throw failure;
    }
}

/** What a rolled-back write reports; `undefined` is a conflict, which the write answers as `false`. */
function toIndexedDbAdmissionWriteFailure(
    context: IndexedDbAdmissionWriteContext,
    queueWrite: Readonly<IndexedDbQueueWriteState> | undefined,
    caught: Error
): Error | undefined {
    if (context.eligibility.expired) {
        return context.eligibility.expired;
    }
    if (context.storedValueError) {
        return context.storedValueError;
    }
    if (queueWrite?.storedValueError) {
        return queueWrite.storedValueError;
    }
    if (context.conflict || queueWrite?.conflict) {
        return undefined;
    }
    return context.transaction.error ?? caught;
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
    commitIssuedIndexedDbAdmissionWrite(context);
}

/**
 * `commit()` is requested once the last request is issued, so a write started while the page is hidden
 * or unloading can land without waiting for the page's next task, and never for a write with a
 * deadline: its expiry aborts it from a request's success, and an abort after `commit()` would throw.
 */
function commitIssuedIndexedDbAdmissionWrite(context: IndexedDbAdmissionWriteContext): void {
    context.unissuedParts -= 1;
    if (context.unissuedParts === 0 && context.input.deadline === undefined) {
        context.transaction.commit?.();
    }
}
