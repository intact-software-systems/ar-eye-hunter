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
        return await this.write((transaction) => transaction.read(key, decode));
    }

    async list<V>(prefix: string, decode: ALAdmissionDecoder<V>): Promise<readonly ALAdmissionBackendEntry<V>[]> {
        return await this.write((transaction) => transaction.list(prefix, decode));
    }

    async write<T>(fn: (tx: ALAdmissionWriteContext) => Promise<T>): Promise<T> {
        const db = await this.openDb();
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);

        const completed = transactionDone(tx);
        // Observe early native failures while the callback is still awaiting other work.
        // The original completion promise is awaited below, so failures are not suppressed.
        void completed.catch(() => undefined);
        const activity = new IndexedDbAdmissionTransactionActivity(store);
        const context = new IndexedDbAdmissionWriteContext(store, activity, this.nowMs);

        try {
            const result = await fn(context);
            activity.release();
            await completed;
            return result;
        }
        catch (error) {
            try {
                tx.abort();
            }
            catch {
                // A failed request may already have aborted the transaction.
            }
            await completed.catch(() => undefined);
            throw error;
        }
        finally {
            activity.release();
        }
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

/** Decodes raw object-store records before exposing them within one native transaction. */
class IndexedDbAdmissionWriteContext implements ALAdmissionWriteContext {
    private readonly store: IDBObjectStore;
    private readonly activity: IndexedDbAdmissionTransactionActivity;
    private readonly nowMs: () => number;

    constructor(store: IDBObjectStore, activity: IndexedDbAdmissionTransactionActivity, nowMs: () => number) {
        this.store = store;
        this.activity = activity;
        this.nowMs = nowMs;
    }

    async read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined> {
        await this.activity.enter();
        const value = await requestToPromise<unknown>(this.store.get(key));
        if (value === undefined) {
            return undefined;
        }
        const stored = decodeALAdmissionValue(value, key, decodeALAdmissionStoredValue);
        const decoded = decodeALAdmissionValue(stored.value, key, decode);
        if (stored.expireAtTimestamp <= this.nowMs()) {
            this.store.delete(key);
            return undefined;
        }
        return decoded;
    }

    async list<V>(prefix: string, decode: ALAdmissionDecoder<V>): Promise<readonly ALAdmissionBackendEntry<V>[]> {
        await this.activity.enter();
        const values: ALAdmissionBackendEntry<V>[] = [];
        await cursorEach(this.store, (cursor) => {
            const key = cursor.primaryKey;
            if (typeof key !== 'string') {
                throw new ALAdmissionCorruptionError(String(key), new TypeError('Admission row key must be a string'));
            }
            if (!key.startsWith(prefix)) {
                return;
            }
            const stored = decodeALAdmissionValue(cursor.value, key, decodeALAdmissionStoredValue);
            const decoded = decodeALAdmissionValue(stored.value, key, decode);
            if (stored.expireAtTimestamp <= this.nowMs()) {
                cursor.delete();
                return;
            }
            values.push({ key, value: decoded });
        });
        return values;
    }

    async set<V>(key: string, value: V, expireAtTimestamp = NEVER_EXPIRE_AT_TIMESTAMP): Promise<void> {
        await this.activity.enter();
        await requestToPromise(this.store.put(
            {
                key,
                value,
                expireAtTimestamp: decodeALAdmissionNumber(expireAtTimestamp)
            } satisfies ALAdmissionStoredValue
        ));
    }

    async remove(key: string): Promise<void> {
        await this.activity.enter();
        await requestToPromise(this.store.delete(key));
    }
}

namespace IndexedDbAdmissionTransactionActivity {
    export interface Activation {
        readonly resolve: () => void;
        readonly reject: (error: Error) => void;
    }
}

/**
 * An async callback may outlive the native transaction's active event task.
 * Keep it open until the callback settles, and resume each request from an
 * IndexedDB success event: being open alone does not make a transaction active.
 */
class IndexedDbAdmissionTransactionActivity {
    private readonly store: IDBObjectStore;
    private held = true;
    private failure?: Error;
    private readonly pending: IndexedDbAdmissionTransactionActivity.Activation[] = [];

    constructor(store: IDBObjectStore) {
        this.store = store;
        this.requestKeepAlive();
    }

    async enter(): Promise<void> {
        if (!this.held) {
            throw this.failure ?? new Error('Admission transaction is closed');
        }
        await new Promise<void>((resolve, reject) => this.pending.push({ resolve, reject }));
    }

    release(): void {
        this.held = false;
    }

    private requestKeepAlive(): void {
        const request = this.store.getKey('');
        request.onsuccess = () => {
            for (const activation of this.pending.splice(0)) {
                activation.resolve();
            }
            if (this.held) {
                this.requestKeepAlive();
            }
        };
        request.onerror = () => {
            this.failure = request.error ?? new Error('Admission transaction activation failed');
            this.held = false;
            for (const activation of this.pending.splice(0)) {
                activation.reject(this.failure);
            }
        };
    }
}

async function requestToPromise<T>(
    request: IDBRequest<T>
): Promise<T> {
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
            if (!cursor) {
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

async function transactionDone(
    tx: IDBTransaction
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    });
}
