import {
    readIndexedDbRequest,
    waitForIndexedDbTransaction
} from '../persistence/indexed-db-request.ts';
import { openIndexedDbWithStore } from '../persistence/openIndexedDb.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '../persistence/PersistenceProvider.ts';
import {
    decodeALAdmissionStoredValue,
    type ALAdmissionStoredValue
} from './al-admission-backend.ts';
import { ALAdmissionCorruptionError, decodeALAdmissionValue } from './al-admission-decoder.ts';
import { decodeALAdmissionNumber } from './al-admission-value-validation.ts';

export const AL_ADMISSION_REVISION_KEY = '__rallar_al_admission_revision__';
export const AL_ADMISSION_EXPIRY_INDEX_NAME = 'expireAtTimestamp';

export type IndexedDbAdmissionMutation =
    | Readonly<{ kind: 'set'; stored: ALAdmissionStoredValue; }>
    | Readonly<{ kind: 'remove'; key: string; }>
    | Readonly<{
        kind: 'remove-if-write-token';
        key: string;
        expectedWriteToken: string;
    }>;

export interface IndexedDbAdmissionSnapshot<Stored = ALAdmissionStoredValue> {
    readonly revision: number;
    readonly stored: readonly Stored[];
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
    return await openIndexedDbWithStore(dbName, {
        name: storeName,
        keyPath: 'key',
        indexes: [{
            name: AL_ADMISSION_EXPIRY_INDEX_NAME,
            keyPath: 'expireAtTimestamp'
        }]
    });
}

export async function readIndexedDbAdmissionSnapshot(
    db: IDBDatabase,
    storeName: string,
    selection: IndexedDbAdmissionSelection
): Promise<IndexedDbAdmissionSnapshot>;
export async function readIndexedDbAdmissionSnapshot<Stored>(
    db: IDBDatabase,
    storeName: string,
    selection: IndexedDbAdmissionSelection,
    readStored: (value: unknown, key: string) => Stored
): Promise<IndexedDbAdmissionSnapshot<Stored>>;
export async function readIndexedDbAdmissionSnapshot<Stored>(
    db: IDBDatabase,
    storeName: string,
    selection: IndexedDbAdmissionSelection,
    readStored: (value: unknown, key: string) => Stored = decodeALAdmissionStoredValue as (
        value: unknown,
        key: string
    ) => Stored
): Promise<IndexedDbAdmissionSnapshot<Stored>> {
    const transaction = db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const completed = waitForIndexedDbTransaction(transaction);
    const [stored, revisionValue] = await Promise.all([
        readIndexedDbAdmissionSelection(store, selection, readStored),
        readIndexedDbRequest(store.get(AL_ADMISSION_REVISION_KEY))
    ]);
    await completed;
    return { stored, revision: decodeIndexedDbAdmissionRevision(revisionValue) };
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
        revisionRequest.onsuccess = () => {
            const actualRevision = decodeIndexedDbAdmissionRevision(revisionRequest.result);
            if (actualRevision !== input.expectedRevision) {
                conflict = true;
                transaction.abort();
                return;
            }
            const guardedRemovals = input.mutations.filter(
                (mutation) => mutation.kind === 'remove-if-write-token'
            );
            if (guardedRemovals.length === 0) {
                applyIndexedDbAdmissionMutations(store, input);
                return;
            }
            let remaining = guardedRemovals.length;
            for (const removal of guardedRemovals) {
                const request = store.get(removal.key);
                request.onsuccess = () => {
                    if (conflict) {
                        return;
                    }
                    const current = request.result as Readonly<{ writeToken?: unknown; }> | undefined;
                    if (current?.writeToken !== removal.expectedWriteToken) {
                        conflict = true;
                        transaction.abort();
                        return;
                    }
                    remaining -= 1;
                    if (remaining === 0) {
                        applyIndexedDbAdmissionMutations(store, input);
                    }
                };
            }
        };
    });
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
    const stored = decodeALAdmissionValue(value, AL_ADMISSION_REVISION_KEY, decodeALAdmissionStoredValue);
    return decodeALAdmissionValue(stored.value, AL_ADMISSION_REVISION_KEY, decodeALAdmissionNumber);
}

async function readIndexedDbAdmissionSelection<Stored>(
    store: IDBObjectStore,
    selection: IndexedDbAdmissionSelection,
    readStored: (value: unknown, key: string) => Stored
): Promise<readonly Stored[]> {
    switch (selection.kind) {
        case 'key': {
            const value = await readIndexedDbRequest(store.get(selection.key));
            return value === undefined
                ? []
                : [decodeALAdmissionValue(value, selection.key, readStored)];
        }
        case 'prefixes':
            return await collectIndexedDbAdmissionStoredValuesForPrefixes(
                store,
                selection.prefixes,
                readStored
            );
        case 'expired':
            return await readIndexedDbAdmissionRange(
                store.index(AL_ADMISSION_EXPIRY_INDEX_NAME),
                IDBKeyRange.upperBound(selection.maximumExpireAtTimestamp),
                readStored
            );
        case 'revision':
            return [];
    }
}

async function collectIndexedDbAdmissionStoredValuesForPrefixes<Stored>(
    store: IDBObjectStore,
    prefixes: readonly string[],
    readStored: (value: unknown, key: string) => Stored
): Promise<readonly Stored[]> {
    const stored = await Promise.all(
        prefixes.map((prefix) =>
            readIndexedDbAdmissionRange(
                store,
                toIndexedDbPrefixRange(prefix),
                readStored
            )
        )
    );
    return stored.flat();
}

async function readIndexedDbAdmissionRange<Stored>(
    source: IDBObjectStore | IDBIndex,
    range: IDBKeyRange | undefined,
    readStored: (value: unknown, key: string) => Stored
): Promise<readonly Stored[]> {
    const [values, keys] = await Promise.all([
        readIndexedDbRequest(source.getAll(range)),
        readIndexedDbRequest(source.getAllKeys(range))
    ]);
    return values.map((value, index) => {
        const key = requireStringKey(keys[index]);
        return decodeALAdmissionValue(value, key, readStored);
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
