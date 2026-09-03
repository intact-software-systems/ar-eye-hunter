import { NEVER_EXPIRE_AT_TIMESTAMP } from '../persistence/PersistenceProvider.ts';
import {
    decodeALAdmissionStoredValue,
    type ALAdmissionStoredValue
} from './al-admission-backend.ts';
import { ALAdmissionCorruptionError, decodeALAdmissionValue } from './al-admission-decoder.ts';
import { decodeALAdmissionNumber } from './al-admission-value-validation.ts';

export const AL_ADMISSION_REVISION_KEY = '__rallar_al_admission_revision__';

export type IndexedDbAdmissionMutation =
    | Readonly<{ kind: 'set'; stored: ALAdmissionStoredValue; }>
    | Readonly<{ kind: 'remove'; key: string; }>;

export interface IndexedDbAdmissionReadSnapshot {
    readonly revision: number;
    readonly stored: ALAdmissionStoredValue | undefined;
}

export interface IndexedDbAdmissionListSnapshot {
    readonly revision: number;
    readonly stored: readonly ALAdmissionStoredValue[];
}

export interface IndexedDbAdmissionKeySnapshot {
    readonly revision: number;
    readonly keys: readonly string[];
}

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

export function computeIndexedDbAdmissionRevisionWrite(
    expectedRevision: number
): IndexedDbAdmissionRevisionWrite {
    return {
        key: AL_ADMISSION_REVISION_KEY,
        value: expectedRevision + 1,
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    };
}

export async function readIndexedDbAdmissionSnapshot(
    db: IDBDatabase,
    storeName: string,
    key: string
): Promise<IndexedDbAdmissionReadSnapshot> {
    const transaction = db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const completed = transactionDone(transaction);
    const valuePromise = requestToPromise(store.get(key));
    const revisionPromise = requestToPromise(store.get(AL_ADMISSION_REVISION_KEY));
    const [value, revisionValue] = await Promise.all([valuePromise, revisionPromise]);
    await completed;
    return {
        revision: decodeIndexedDbAdmissionRevision(revisionValue),
        stored: value === undefined
            ? undefined
            : decodeALAdmissionValue(value, key, decodeALAdmissionStoredValue)
    };
}

export async function listIndexedDbAdmissionSnapshot(
    db: IDBDatabase,
    storeName: string,
    prefix: string
): Promise<IndexedDbAdmissionListSnapshot> {
    const transaction = db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const completed = transactionDone(transaction);
    const valuesPromise = collectIndexedDbAdmissionStoredValues(store, prefix);
    const revisionPromise = requestToPromise(store.get(AL_ADMISSION_REVISION_KEY));
    const [stored, revisionValue] = await Promise.all([valuesPromise, revisionPromise]);
    await completed;
    return { revision: decodeIndexedDbAdmissionRevision(revisionValue), stored };
}

export async function readIndexedDbAdmissionKeySnapshot(
    db: IDBDatabase,
    storeName: string,
    keyPrefixes: readonly string[]
): Promise<IndexedDbAdmissionKeySnapshot> {
    const transaction = db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const completed = transactionDone(transaction);
    const keysPromise = collectIndexedDbAdmissionKeys(store, keyPrefixes);
    const revisionPromise = requestToPromise(store.get(AL_ADMISSION_REVISION_KEY));
    const [keys, revisionValue] = await Promise.all([keysPromise, revisionPromise]);
    await completed;
    return { revision: decodeIndexedDbAdmissionRevision(revisionValue), keys };
}

export async function readIndexedDbAdmissionRevision(
    db: IDBDatabase,
    storeName: string
): Promise<number> {
    const stored = await readIndexedDbAdmissionStoredValue(db, storeName, AL_ADMISSION_REVISION_KEY);
    return stored === undefined
        ? 0
        : decodeALAdmissionValue(stored.value, AL_ADMISSION_REVISION_KEY, decodeALAdmissionNumber);
}

export async function readIndexedDbAdmissionStoredValue(
    db: IDBDatabase,
    storeName: string,
    key: string
): Promise<ALAdmissionStoredValue | undefined> {
    const transaction = db.transaction(storeName, 'readonly');
    const completed = transactionDone(transaction);
    const value = await requestToPromise(transaction.objectStore(storeName).get(key));
    await completed;
    return value === undefined
        ? undefined
        : decodeALAdmissionValue(value, key, decodeALAdmissionStoredValue);
}

export async function listIndexedDbAdmissionStoredValues(
    db: IDBDatabase,
    storeName: string,
    prefix: string
): Promise<readonly ALAdmissionStoredValue[]> {
    const transaction = db.transaction(storeName, 'readonly');
    const completed = transactionDone(transaction);
    const values = await collectIndexedDbAdmissionStoredValues(transaction.objectStore(storeName), prefix);
    await completed;
    return values;
}

export async function writeIndexedDbAdmissionMutations(
    input: WriteIndexedDbAdmissionMutationsInput
): Promise<boolean> {
    return await new Promise<boolean>((resolve, reject) => {
        const transaction = input.db.transaction(input.storeName, 'readwrite');
        const store = transaction.objectStore(input.storeName);
        const revisionRequest = store.get(AL_ADMISSION_REVISION_KEY);
        let conflict = false;

        transaction.oncomplete = () => resolve(true);
        transaction.onabort = () => {
            if (conflict) {
                resolve(false);
                return;
            }
            reject(transaction.error ?? new Error('IndexedDB AL admission write aborted'));
        };
        transaction.onerror = () => {
            if (!conflict) {
                reject(transaction.error ?? new Error('IndexedDB AL admission write failed'));
            }
        };
        revisionRequest.onerror = () =>
            reject(revisionRequest.error ?? new Error('IndexedDB AL admission revision read failed'));
        revisionRequest.onsuccess = () => {
            const actualRevision = decodeIndexedDbAdmissionRevision(revisionRequest.result);
            if (actualRevision !== input.expectedRevision) {
                conflict = true;
                transaction.abort();
                return;
            }
            for (const mutation of input.mutations) {
                const request = mutation.kind === 'set'
                    ? store.put(mutation.stored)
                    : store.delete(mutation.key);
                request.onerror = () => reject(request.error ?? new Error('IndexedDB AL admission mutation failed'));
            }
            if (input.mutations.length > 0) {
                const request = store.put(input.revisionWrite);
                request.onerror = () =>
                    reject(request.error ?? new Error('IndexedDB AL admission revision write failed'));
            }
        };
    });
}

function decodeIndexedDbAdmissionRevision(value: IDBRequest['result']): number {
    if (value === undefined) {
        return 0;
    }
    const stored = decodeALAdmissionValue(value, AL_ADMISSION_REVISION_KEY, decodeALAdmissionStoredValue);
    return decodeALAdmissionValue(stored.value, AL_ADMISSION_REVISION_KEY, decodeALAdmissionNumber);
}

async function collectIndexedDbAdmissionStoredValues(
    store: IDBObjectStore,
    prefix: string
): Promise<readonly ALAdmissionStoredValue[]> {
    const values: ALAdmissionStoredValue[] = [];
    await cursorEach(store, (cursor) => {
        const key = requireStringKey(cursor.primaryKey);
        if (key.startsWith(prefix)) {
            values.push(decodeALAdmissionValue(cursor.value, key, decodeALAdmissionStoredValue));
        }
    });
    return values;
}

async function collectIndexedDbAdmissionKeys(
    store: IDBObjectStore,
    keyPrefixes: readonly string[]
): Promise<readonly string[]> {
    const keys: string[] = [];
    await cursorEach(store, (cursor) => {
        const key = requireStringKey(cursor.primaryKey);
        if (keyPrefixes.some((prefix) => key.startsWith(prefix))) {
            keys.push(key);
        }
    });
    return keys;
}

function requireStringKey(key: IDBValidKey): string {
    if (typeof key !== 'string') {
        throw new ALAdmissionCorruptionError(String(key), new TypeError('Admission row key must be a string'));
    }
    return key;
}

async function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
}

async function cursorEach(
    store: IDBObjectStore,
    handler: (cursor: IDBCursorWithValue) => void
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const request = store.openCursor();
        request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed'));
        request.onsuccess = () => {
            const cursor = request.result;
            if (cursor === null) {
                resolve();
                return;
            }
            try {
                handler(cursor);
                cursor.continue();
            }
            catch (error) {
                reject(error);
            }
        };
    });
}

async function transactionDone(transaction: IDBTransaction): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    });
}
