import { waitForIndexedDbTransaction } from '../persistence/indexed-db-request.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '../persistence/PersistenceProvider.ts';
import {
    validateComputedIndexedDbQueueMutations,
    type ComputedIndexedDbQueueMutation
} from '../queuebox/indexed-db-queue-box-entry.ts';
import { submitComputedIndexedDbQueueMutations } from '../queuebox/write-computed-indexed-db-queue-mutations.ts';
import { toError } from '../resilience/to-error.ts';
import { ALAdmissionCorruptionError } from './al-admission-decoder.ts';
import type { IndexedDbAdmissionStoredRow } from './indexed-db-admission-row.ts';
import {
    AL_ADMISSION_REVISION_KEY,
    AL_ADMISSION_WORK_STORE_NAME,
    decodeIndexedDbAdmissionRevision
} from './open-indexed-db-admission-database.ts';

export type IndexedDbAdmissionMutation =
    | Readonly<{ kind: 'set'; stored: IndexedDbAdmissionStoredRow; }>
    | Readonly<{ kind: 'remove'; key: string; }>
    | Readonly<{
        kind: 'remove-if-write-token';
        key: string;
        expectedWriteToken: string;
    }>;

type IndexedDbAdmissionGuardedRemoval = Extract<IndexedDbAdmissionMutation, { kind: 'remove-if-write-token'; }>;

interface IndexedDbAdmissionRevisionWrite {
    readonly key: typeof AL_ADMISSION_REVISION_KEY;
    readonly value: number;
    readonly expireAtTimestamp: number;
}

export interface WriteIndexedDbAdmissionMutationsInput {
    readonly db: IDBDatabase;
    readonly expectedRevision: number;
    readonly mutations: readonly IndexedDbAdmissionMutation[];
    readonly queueMutations: readonly ComputedIndexedDbQueueMutation[];
    readonly revisionWrite: IndexedDbAdmissionRevisionWrite;
    readonly storeName: string;
}

interface IndexedDbAdmissionWriteContext {
    readonly guardedRemovals: readonly IndexedDbAdmissionGuardedRemoval[];
    readonly input: WriteIndexedDbAdmissionMutationsInput;
    readonly store: IDBObjectStore;
    readonly transaction: IDBTransaction;
    conflict: boolean;
    storedValueError: Error | undefined;
}

export function computeIndexedDbAdmissionRevisionWrite(
    expectedRevision: number
): IndexedDbAdmissionRevisionWrite {
    return {
        key: AL_ADMISSION_REVISION_KEY,
        value: expectedRevision + 1,
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    };
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
    const storeNames = input.queueMutations.length === 0
        ? [input.storeName]
        : [input.storeName, AL_ADMISSION_WORK_STORE_NAME];
    const transaction = input.db.transaction(storeNames, 'readwrite');
    const completed = waitForIndexedDbTransaction(transaction);
    const store = transaction.objectStore(input.storeName);
    const queueWrite = input.queueMutations.length === 0
        ? undefined
        : submitComputedIndexedDbQueueMutations(
            transaction.objectStore(AL_ADMISSION_WORK_STORE_NAME),
            input.queueMutations
        );
    const revisionRequest = store.get(AL_ADMISSION_REVISION_KEY);
    const context: IndexedDbAdmissionWriteContext = {
        guardedRemovals,
        input,
        store,
        transaction,
        conflict: false,
        storedValueError: undefined
    };
    revisionRequest.onsuccess = () => continueIndexedDbAdmissionWrite(context, revisionRequest.result);
    try {
        await completed;
        return true;
    }
    catch (error) {
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

function continueIndexedDbAdmissionWrite(
    context: IndexedDbAdmissionWriteContext,
    revisionValue: IDBRequest['result']
): void {
    let actualRevision: number;
    try {
        actualRevision = decodeIndexedDbAdmissionRevision(revisionValue);
    }
    catch (error) {
        abortIndexedDbAdmissionWrite(context, AL_ADMISSION_REVISION_KEY, toError(error));
        return;
    }
    if (actualRevision !== context.input.expectedRevision) {
        context.conflict = true;
        context.transaction.abort();
        return;
    }
    if (context.guardedRemovals.length === 0) {
        applyIndexedDbAdmissionMutations(context.store, context.input);
        return;
    }
    readGuardedIndexedDbAdmissionRemovals(context, context.guardedRemovals);
}

function readGuardedIndexedDbAdmissionRemovals(
    context: IndexedDbAdmissionWriteContext,
    removals: readonly IndexedDbAdmissionGuardedRemoval[]
): void {
    let remaining = removals.length;
    for (const removal of removals) {
        const request = context.store.get(removal.key);
        request.onsuccess = () => {
            if (context.conflict || context.storedValueError) {
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
                context.conflict = true;
                context.transaction.abort();
                return;
            }
            remaining -= 1;
            if (remaining === 0) {
                applyIndexedDbAdmissionMutations(context.store, context.input);
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
    store: IDBObjectStore,
    input: WriteIndexedDbAdmissionMutationsInput
): void {
    for (const mutation of input.mutations) {
        mutation.kind === 'set'
            ? store.put(mutation.stored)
            : store.delete(mutation.key);
    }
    store.put(input.revisionWrite);
}
