import { openIndexedDbWithStore } from '../persistence/openIndexedDb.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '../persistence/PersistenceProvider.ts';
import {
    decodeALAdmissionStoredValue,
    type ALAdmissionBackend,
    type ALAdmissionBackendEntry,
    type ALAdmissionStoredValue,
    type ALAdmissionWriteContext
} from './al-admission-backend.ts';
import { ALAdmissionCorruptionError, decodeALAdmissionValue, type ALAdmissionDecoder } from './al-admission-decoder.ts';
import { decodeALAdmissionNumber } from './al-admission-value-validation.ts';
import { ALAdmissionBackendConflictError } from './ALAdmissionBackendConflictError.ts';

export const AL_ADMISSION_REVISION_KEY = '__rallar_al_admission_revision__';

type IndexedDbAdmissionMutation =
    | Readonly<{ kind: 'set'; stored: ALAdmissionStoredValue; }>
    | Readonly<{ kind: 'remove'; key: string; }>;

export class IndexedDbAdmissionBackend implements ALAdmissionBackend {
    private dbPromise?: Promise<IDBDatabase>;

    private readonly dbName: string;
    private readonly storeName: string;
    private readonly nowMs: () => number;

    constructor(
        dbName: string,
        storeName: string,
        nowMs: () => number
    ) {
        this.dbName = dbName;
        this.storeName = storeName;
        this.nowMs = nowMs;
    }

    async ready(): Promise<void> {
        await this.openDb();
    }

    async read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined> {
        const db = await this.openDb();
        const snapshot = await readIndexedDbAdmissionSnapshot(db, this.storeName, key);
        if (snapshot.stored === undefined) {
            return undefined;
        }
        const observed = decodeAdmissionValue(snapshot.stored, key, decode, this.nowMs());
        if (!observed.expired) {
            return observed.value;
        }
        await removeExpiredIndexedDbAdmissionValues({
            db,
            storeName: this.storeName,
            expectedRevision: snapshot.revision,
            keys: [key]
        });
        return undefined;
    }

    async list<V>(prefix: string, decode: ALAdmissionDecoder<V>): Promise<readonly ALAdmissionBackendEntry<V>[]> {
        const db = await this.openDb();
        const snapshot = await listIndexedDbAdmissionSnapshot(db, this.storeName, prefix);
        const entries: ALAdmissionBackendEntry<V>[] = [];
        const expiredKeys: string[] = [];
        const nowMs = this.nowMs();
        for (const row of snapshot.stored) {
            if (row.key === AL_ADMISSION_REVISION_KEY) {
                continue;
            }
            const observed = decodeAdmissionValue(row, row.key, decode, nowMs);
            if (observed.expired) {
                expiredKeys.push(row.key);
            }
            else {
                entries.push({ key: row.key, value: observed.value });
            }
        }
        if (expiredKeys.length > 0) {
            await removeExpiredIndexedDbAdmissionValues({
                db,
                storeName: this.storeName,
                expectedRevision: snapshot.revision,
                keys: expiredKeys
            });
        }
        return entries;
    }

    async write<T>(fn: (tx: ALAdmissionWriteContext) => Promise<T>): Promise<T> {
        const db = await this.openDb();
        const expectedRevision = await readIndexedDbAdmissionRevision(db, this.storeName);
        const buffer = new IndexedDbAdmissionWriteBuffer(db, this.storeName, this.nowMs);
        const result = await fn(buffer);
        const mutations = buffer.mutations();
        const revisionWrite: ALAdmissionStoredValue = {
            key: AL_ADMISSION_REVISION_KEY,
            value: expectedRevision + 1,
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
        };
        const committed = await writeIndexedDbAdmissionMutations({
            db,
            storeName: this.storeName,
            expectedRevision,
            mutations,
            revisionWrite
        });
        if (!committed) {
            throw new ALAdmissionBackendConflictError('IndexedDB AL admission write conflicted');
        }
        return result;
    }

    private async openDb(): Promise<IDBDatabase> {
        if (!this.dbPromise) {
            this.dbPromise = openIndexedDbWithStore(
                this.dbName,
                {
                    name: this.storeName,
                    keyPath: 'key'
                }
            ).then((db) => {
                db.onversionchange = () => {
                    db.close();
                    this.dbPromise = undefined;
                };
                return db;
            });
        }

        return await this.dbPromise;
    }
}

class IndexedDbAdmissionWriteBuffer implements ALAdmissionWriteContext {
    private readonly pending = new Map<string, ALAdmissionStoredValue | undefined>();
    private readonly db: IDBDatabase;
    private readonly storeName: string;
    private readonly nowMs: () => number;

    constructor(db: IDBDatabase, storeName: string, nowMs: () => number) {
        this.db = db;
        this.storeName = storeName;
        this.nowMs = nowMs;
    }

    async read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined> {
        if (!this.pending.has(key)) {
            const stored = await readIndexedDbAdmissionStoredValue(this.db, this.storeName, key);
            if (stored === undefined) {
                return undefined;
            }
            const observed = decodeAdmissionValue(stored, key, decode, this.nowMs());
            return observed.expired ? undefined : observed.value;
        }
        const stored = this.pending.get(key);
        if (stored === undefined) {
            return undefined;
        }
        const observed = decodeAdmissionValue(stored, key, decode, this.nowMs());
        return observed.expired ? undefined : observed.value;
    }

    async list<V>(prefix: string, decode: ALAdmissionDecoder<V>): Promise<readonly ALAdmissionBackendEntry<V>[]> {
        const values = new Map<string, V>();
        const storedEntries = await listIndexedDbAdmissionStoredValues(this.db, this.storeName, prefix);
        const nowMs = this.nowMs();
        for (const stored of storedEntries) {
            if (stored.key === AL_ADMISSION_REVISION_KEY || this.pending.has(stored.key)) {
                continue;
            }
            const observed = decodeAdmissionValue(stored, stored.key, decode, nowMs);
            if (!observed.expired) {
                values.set(stored.key, observed.value);
            }
        }
        for (const [key, stored] of this.pending) {
            if (!key.startsWith(prefix)) {
                continue;
            }
            if (stored === undefined) {
                values.delete(key);
                continue;
            }
            const observed = decodeAdmissionValue(stored, key, decode, nowMs);
            if (observed.expired) {
                values.delete(key);
            }
            else {
                values.set(key, observed.value);
            }
        }
        return [...values].map(([key, value]) => ({ key, value }));
    }

    async set<V>(key: string, value: V, expireAtTimestamp = NEVER_EXPIRE_AT_TIMESTAMP): Promise<void> {
        this.pending.set(key, {
            key,
            value,
            expireAtTimestamp: decodeALAdmissionNumber(expireAtTimestamp)
        });
    }

    async remove(key: string): Promise<void> {
        this.pending.set(key, undefined);
    }

    mutations(): readonly IndexedDbAdmissionMutation[] {
        return [...this.pending].map(([key, stored]) =>
            stored === undefined ? { kind: 'remove', key } : { kind: 'set', stored }
        );
    }
}

function decodeAdmissionValue<V>(
    stored: ALAdmissionStoredValue,
    key: string,
    decode: ALAdmissionDecoder<V>,
    nowMs: number
): Readonly<{ value: V; expired: boolean; }> {
    const canonical = decodeALAdmissionValue(stored, key, decodeALAdmissionStoredValue);
    const value = decodeALAdmissionValue(canonical.value, key, decode);
    return { value, expired: canonical.expireAtTimestamp <= nowMs };
}

interface IndexedDbAdmissionReadSnapshot {
    readonly revision: number;
    readonly stored: ALAdmissionStoredValue | undefined;
}

interface IndexedDbAdmissionListSnapshot {
    readonly revision: number;
    readonly stored: readonly ALAdmissionStoredValue[];
}

async function readIndexedDbAdmissionSnapshot(
    db: IDBDatabase,
    storeName: string,
    key: string
): Promise<IndexedDbAdmissionReadSnapshot> {
    const transaction = db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const completed = transactionDone(transaction);
    const valuePromise = requestToPromise<unknown>(store.get(key));
    const revisionPromise = requestToPromise<unknown>(store.get(AL_ADMISSION_REVISION_KEY));
    const [value, revisionValue] = await Promise.all([valuePromise, revisionPromise]);
    await completed;
    return {
        revision: decodeIndexedDbAdmissionRevision(revisionValue),
        stored: value === undefined
            ? undefined
            : decodeALAdmissionValue(value, key, decodeALAdmissionStoredValue)
    };
}

async function listIndexedDbAdmissionSnapshot(
    db: IDBDatabase,
    storeName: string,
    prefix: string
): Promise<IndexedDbAdmissionListSnapshot> {
    const transaction = db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const completed = transactionDone(transaction);
    const valuesPromise = collectIndexedDbAdmissionStoredValues(store, prefix);
    const revisionPromise = requestToPromise<unknown>(store.get(AL_ADMISSION_REVISION_KEY));
    const [stored, revisionValue] = await Promise.all([valuesPromise, revisionPromise]);
    await completed;
    return { revision: decodeIndexedDbAdmissionRevision(revisionValue), stored };
}

function decodeIndexedDbAdmissionRevision(value: unknown): number {
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
        const key = cursor.primaryKey;
        if (typeof key !== 'string') {
            throw new ALAdmissionCorruptionError(String(key), new TypeError('Admission row key must be a string'));
        }
        if (key.startsWith(prefix)) {
            values.push(decodeALAdmissionValue(cursor.value, key, decodeALAdmissionStoredValue));
        }
    });
    return values;
}

interface RemoveExpiredIndexedDbAdmissionValuesInput {
    readonly db: IDBDatabase;
    readonly expectedRevision: number;
    readonly keys: readonly string[];
    readonly storeName: string;
}

async function removeExpiredIndexedDbAdmissionValues(
    input: RemoveExpiredIndexedDbAdmissionValuesInput
): Promise<void> {
    const committed = await writeIndexedDbAdmissionMutations({
        db: input.db,
        storeName: input.storeName,
        expectedRevision: input.expectedRevision,
        mutations: input.keys.map((key) => ({ kind: 'remove', key })),
        revisionWrite: {
            key: AL_ADMISSION_REVISION_KEY,
            value: input.expectedRevision + 1,
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
        }
    });
    if (!committed) {
        throw new ALAdmissionBackendConflictError('IndexedDB AL admission expiry cleanup conflicted');
    }
}

async function readIndexedDbAdmissionRevision(db: IDBDatabase, storeName: string): Promise<number> {
    const stored = await readIndexedDbAdmissionStoredValue(db, storeName, AL_ADMISSION_REVISION_KEY);
    return stored === undefined
        ? 0
        : decodeALAdmissionValue(stored.value, AL_ADMISSION_REVISION_KEY, decodeALAdmissionNumber);
}

async function readIndexedDbAdmissionStoredValue(
    db: IDBDatabase,
    storeName: string,
    key: string
): Promise<ALAdmissionStoredValue | undefined> {
    const transaction = db.transaction(storeName, 'readonly');
    const completed = transactionDone(transaction);
    const value = await requestToPromise<unknown>(transaction.objectStore(storeName).get(key));
    await completed;
    return value === undefined
        ? undefined
        : decodeALAdmissionValue(value, key, decodeALAdmissionStoredValue);
}

async function listIndexedDbAdmissionStoredValues(
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

interface WriteIndexedDbAdmissionMutationsInput {
    readonly db: IDBDatabase;
    readonly expectedRevision: number;
    readonly mutations: readonly IndexedDbAdmissionMutation[];
    readonly revisionWrite: ALAdmissionStoredValue;
    readonly storeName: string;
}

async function writeIndexedDbAdmissionMutations(
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
            const storedRevision = revisionRequest.result as ALAdmissionStoredValue | undefined;
            const actualRevision = storedRevision?.value ?? 0;
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
