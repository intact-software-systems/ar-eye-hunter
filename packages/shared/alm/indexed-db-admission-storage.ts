import {
    readIndexedDbRequest,
    waitForIndexedDbTransaction
} from '../persistence/indexed-db-request.ts';
import { openIndexedDbWithStore } from '../persistence/openIndexedDb.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '../persistence/PersistenceProvider.ts';
import { toError } from '../resilience/to-error.ts';
import type { ALAdmissionStoredValue } from './al-admission-backend.ts';
import { ALAdmissionCorruptionError, decodeALAdmissionValue } from './al-admission-decoder.ts';
import { decodeALAdmissionNumber } from './al-admission-value-validation.ts';
import {
    decodeIndexedDbAdmissionStoredRow,
    toALAdmissionStoredValue,
    type IndexedDbAdmissionStoredRow
} from './indexed-db-admission-row.ts';
import { migrateIndexedDbAdmissionWriteTokens } from './migrate-indexed-db-admission-write-tokens.ts';

export {
    type IndexedDbAdmissionStoredRow,
    toALAdmissionStoredValue
} from './indexed-db-admission-row.ts';

export const AL_ADMISSION_REVISION_KEY = '__rallar_al_admission_revision__';
export const AL_ADMISSION_EXPIRY_INDEX_NAME = 'expireAtTimestamp';

export type IndexedDbAdmissionMutation =
    | Readonly<{ kind: 'set'; stored: IndexedDbAdmissionStoredRow; }>
    | Readonly<{ kind: 'remove'; key: string; }>
    | Readonly<{
        kind: 'remove-if-write-token';
        key: string;
        expectedWriteToken: string;
    }>;

type IndexedDbAdmissionGuardedRemoval = Extract<IndexedDbAdmissionMutation, { kind: 'remove-if-write-token'; }>;

export interface IndexedDbAdmissionSnapshot {
    readonly revision: number;
    readonly stored: readonly IndexedDbAdmissionStoredRow[];
}

export type IndexedDbAdmissionSelection =
    | Readonly<{ kind: 'key'; key: string; }>
    | Readonly<{ kind: 'prefixes'; prefixes: readonly string[]; }>
    | Readonly<{ kind: 'expired'; maximumExpireAtTimestamp: number; }>
    | Readonly<{ kind: 'revision'; }>;

export interface IndexedDbAdmissionRevisionWrite {
    readonly key: typeof AL_ADMISSION_REVISION_KEY;
    readonly value: number;
    readonly expireAtTimestamp: number;
}

export interface WriteIndexedDbAdmissionMutationsInput {
    readonly db: IDBDatabase;
    readonly expectedRevision: number;
    readonly mutations: readonly IndexedDbAdmissionMutation[];
    readonly revisionWrite: ALAdmissionStoredValue;
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

export async function openIndexedDbAdmissionDatabase(
    dbName: string,
    storeName: string
): Promise<IDBDatabase> {
    return await openIndexedDbWithStore(
        dbName,
        {
            name: storeName,
            keyPath: 'key',
            indexes: [{
                name: AL_ADMISSION_EXPIRY_INDEX_NAME,
                keyPath: 'expireAtTimestamp'
            }]
        },
        (database) =>
            migrateIndexedDbAdmissionWriteTokens(
                database,
                storeName,
                AL_ADMISSION_REVISION_KEY
            )
    );
}

export async function readIndexedDbAdmissionSnapshot(
    db: IDBDatabase,
    storeName: string,
    selection: IndexedDbAdmissionSelection
): Promise<IndexedDbAdmissionSnapshot> {
    const transaction = db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const completed = waitForIndexedDbTransaction(transaction);
    const [rows, revisionValue] = await Promise.all([
        readIndexedDbAdmissionSelection(store, selection),
        readIndexedDbRequest(store.get(AL_ADMISSION_REVISION_KEY))
    ]);
    await completed;
    return { stored: rows, revision: decodeIndexedDbAdmissionRevision(revisionValue) };
}

export async function writeIndexedDbAdmissionMutations(
    input: WriteIndexedDbAdmissionMutationsInput
): Promise<boolean> {
    const guardedRemovals = input.mutations.filter(
        (mutation): mutation is IndexedDbAdmissionGuardedRemoval => mutation.kind === 'remove-if-write-token'
    );
    const transaction = input.db.transaction(input.storeName, 'readwrite');
    const completed = waitForIndexedDbTransaction(transaction);
    const store = transaction.objectStore(input.storeName);
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
        if (context.conflict) {
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
    if (writeToken === undefined) {
        return undefined;
    }
    if (!Object.hasOwn(writeToken, 'value') || typeof writeToken.value !== 'string') {
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

function decodeIndexedDbAdmissionRevision(value: IDBRequest['result']): number {
    if (value === undefined) {
        return 0;
    }
    const stored = toALAdmissionStoredValue(
        decodeIndexedDbAdmissionStoredRow(value, AL_ADMISSION_REVISION_KEY)
    );
    return decodeALAdmissionValue(stored.value, AL_ADMISSION_REVISION_KEY, decodeALAdmissionNumber);
}

async function readIndexedDbAdmissionSelection(
    store: IDBObjectStore,
    selection: IndexedDbAdmissionSelection
): Promise<readonly IndexedDbAdmissionStoredRow[]> {
    switch (selection.kind) {
        case 'key': {
            const value = await readIndexedDbRequest(store.get(selection.key));
            return value === undefined
                ? []
                : [decodeIndexedDbAdmissionStoredRow(value, selection.key)];
        }
        case 'prefixes':
            return await collectIndexedDbAdmissionStoredValuesForPrefixes(
                store,
                selection.prefixes
            );
        case 'expired':
            return await readIndexedDbAdmissionRange(
                store.index(AL_ADMISSION_EXPIRY_INDEX_NAME),
                IDBKeyRange.upperBound(selection.maximumExpireAtTimestamp)
            );
        case 'revision':
            return [];
    }
}

async function collectIndexedDbAdmissionStoredValuesForPrefixes(
    store: IDBObjectStore,
    prefixes: readonly string[]
): Promise<readonly IndexedDbAdmissionStoredRow[]> {
    const stored = await Promise.all(
        prefixes.map((prefix) =>
            readIndexedDbAdmissionRange(
                store,
                toIndexedDbPrefixRange(prefix)
            )
        )
    );
    return stored.flat();
}

async function readIndexedDbAdmissionRange(
    source: IDBObjectStore | IDBIndex,
    range: IDBKeyRange | undefined
): Promise<readonly IndexedDbAdmissionStoredRow[]> {
    const [values, keys] = await Promise.all([
        readIndexedDbRequest(source.getAll(range)),
        readIndexedDbRequest(source.getAllKeys(range))
    ]);
    return values.map((value, index) => {
        const key = requireStringKey(keys[index]);
        return decodeIndexedDbAdmissionStoredRow(value, key);
    });
}

function toIndexedDbPrefixRange(prefix: string): IDBKeyRange | undefined {
    return prefix.length === 0
        ? undefined
        : IDBKeyRange.bound(prefix, `${prefix}\uffff`);
}

function requireStringKey(key: IDBValidKey): string {
    if (typeof key !== 'string') {
        throw new ALAdmissionCorruptionError(String(key), new TypeError('Admission row key must be a string'));
    }
    return key;
}
