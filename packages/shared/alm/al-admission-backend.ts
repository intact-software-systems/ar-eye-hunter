import { openIndexedDbWithStore } from '../persistence/openIndexedDb.ts';
import type { PersistenceProvider } from '../persistence/PersistenceProvider.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '../persistence/PersistenceProvider.ts';

interface StoredValue {
    readonly key: string;
    readonly value: unknown;
    readonly expireAtTimestamp: number;
}

export interface ALAdmissionMemoryState {
    readonly data: Map<string, StoredValue>;
    writeTail: Promise<void>;
}

export interface ALAdmissionBackendEntry<V> {
    readonly key: string;
    readonly value: V;
}

export interface ALAdmissionBackend {
    ready(): Promise<void>;
    get<V>(key: string): Promise<V | undefined>;
    list<V>(prefix: string): Promise<readonly ALAdmissionBackendEntry<V>[]>;
    write<T>(fn: (tx: ALAdmissionWriteContext) => Promise<T>): Promise<T>;
}

export interface ALAdmissionWriteContext {
    get<V>(key: string): Promise<V | undefined>;
    list<V>(prefix: string): Promise<readonly ALAdmissionBackendEntry<V>[]>;
    set<V>(key: string, value: V, expireAtTimestamp?: number): Promise<void>;
    remove(key: string): Promise<void>;
}

const providerWriteTailByCoordinationKey = new Map<string, Promise<void>>();

export function createInMemoryALAdmissionState(): ALAdmissionMemoryState {
    return {
        data: new Map<string, StoredValue>(),
        writeTail: Promise.resolve()
    };
}

export class InMemoryAdmissionBackend implements ALAdmissionBackend {
    private readonly state: ALAdmissionMemoryState;

    constructor(
        state: ALAdmissionMemoryState
    ) {
        this.state = state;
    }

    async ready(): Promise<void> {
    }

    async get<V>(key: string): Promise<V | undefined> {
        const stored = this.state.data.get(key);
        if (!stored) {
            return undefined;
        }

        if (isExpired(stored.expireAtTimestamp)) {
            this.state.data.delete(key);
            return undefined;
        }

        return stored.value as V;
    }

    async list<V>(prefix: string): Promise<readonly ALAdmissionBackendEntry<V>[]> {
        const entries: ALAdmissionBackendEntry<V>[] = [];

        for (const [key, stored] of this.state.data.entries()) {
            if (!key.startsWith(prefix)) {
                continue;
            }

            if (isExpired(stored.expireAtTimestamp)) {
                this.state.data.delete(key);
                continue;
            }

            entries.push({
                key,
                value: stored.value as V
            });
        }

        return entries;
    }

    async write<T>(fn: (tx: ALAdmissionWriteContext) => Promise<T>): Promise<T> {
        const previous = this.state.writeTail;
        let release: (() => void) | undefined;
        this.state.writeTail = new Promise<void>((resolve) => {
            release = resolve;
        });

        await previous;

        try {
            return await fn({
                get: async (key) => await this.get(key),
                list: async (prefix) => await this.list(prefix),
                set: async (key, value, expireAtTimestamp = NEVER_EXPIRE_AT_TIMESTAMP) => {
                    this.state.data.set(
                        key,
                        {
                            key,
                            value,
                            expireAtTimestamp
                        }
                    );
                },
                remove: async (key) => {
                    this.state.data.delete(key);
                }
            });
        }
        finally {
            release?.();
        }
    }
}

export class IndexedDbAdmissionBackend implements ALAdmissionBackend {
    private dbPromise?: Promise<IDBDatabase>;

    private readonly dbName: string;
    private readonly storeName: string;

    constructor(
        dbName: string,
        storeName: string
    ) {
        this.dbName = dbName;
        this.storeName = storeName;
    }

    async ready(): Promise<void> {
        await this.openDb();
    }

    async get<V>(key: string): Promise<V | undefined> {
        const db = await this.openDb();
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const stored = await requestToPromise<StoredValue | undefined>(store.get(key));
        if (!stored) {
            await transactionDone(tx);
            return undefined;
        }

        if (isExpired(stored.expireAtTimestamp)) {
            store.delete(key);
            await transactionDone(tx);
            return undefined;
        }

        await transactionDone(tx);
        return stored.value as V;
    }

    async list<V>(prefix: string): Promise<readonly ALAdmissionBackendEntry<V>[]> {
        const db = await this.openDb();
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const values: ALAdmissionBackendEntry<V>[] = [];

        await cursorEach(store, async (cursor) => {
            const stored = cursor.value as StoredValue;
            if (!stored.key.startsWith(prefix)) {
                return;
            }

            if (isExpired(stored.expireAtTimestamp)) {
                cursor.delete();
                return;
            }

            values.push({
                key: stored.key,
                value: stored.value as V
            });
        });

        await transactionDone(tx);
        return values;
    }

    async write<T>(fn: (tx: ALAdmissionWriteContext) => Promise<T>): Promise<T> {
        const db = await this.openDb();
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);

        const result = await fn({
            get: async <V>(key: string): Promise<V | undefined> => {
                const stored = await requestToPromise<StoredValue | undefined>(store.get(key));
                if (!stored) {
                    return undefined;
                }

                if (isExpired(stored.expireAtTimestamp)) {
                    store.delete(key);
                    return undefined;
                }

                return stored.value as V;
            },
            list: async <V>(prefix: string): Promise<readonly ALAdmissionBackendEntry<V>[]> => {
                const values: ALAdmissionBackendEntry<V>[] = [];
                await cursorEach(store, async (cursor) => {
                    const stored = cursor.value as StoredValue;
                    if (!stored.key.startsWith(prefix)) {
                        return;
                    }

                    if (isExpired(stored.expireAtTimestamp)) {
                        cursor.delete();
                        return;
                    }

                    values.push({
                        key: stored.key,
                        value: stored.value as V
                    });
                });
                return values;
            },
            set: async (key, value, expireAtTimestamp = NEVER_EXPIRE_AT_TIMESTAMP) => {
                await requestToPromise(
                    store.put(
                        {
                            key,
                            value,
                            expireAtTimestamp
                        } satisfies StoredValue
                    )
                );
            },
            remove: async (key) => {
                await requestToPromise(store.delete(key));
            }
        });

        await transactionDone(tx);
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

export class PersistenceProviderAdmissionBackend implements ALAdmissionBackend {
    private readonly provider: PersistenceProvider<string, unknown>;
    private readonly coordinationKey: string;

    constructor(
        provider: PersistenceProvider<string, unknown>,
        coordinationKey: string
    ) {
        this.provider = provider;
        this.coordinationKey = coordinationKey;
    }

    async ready(): Promise<void> {
    }

    async get<V>(key: string): Promise<V | undefined> {
        return await this.provider.getItem(key) as V | undefined;
    }

    async list<V>(prefix: string): Promise<readonly ALAdmissionBackendEntry<V>[]> {
        const entries: ALAdmissionBackendEntry<V>[] = [];

        for (const key of await this.provider.getAllKeys()) {
            if (!key.startsWith(prefix)) {
                continue;
            }

            const value = await this.provider.getItem(key);
            if (value === undefined) {
                continue;
            }

            entries.push({
                key,
                value: value as V
            });
        }

        return entries;
    }

    async write<T>(fn: (tx: ALAdmissionWriteContext) => Promise<T>): Promise<T> {
        const previous = providerWriteTailByCoordinationKey.get(this.coordinationKey) ?? Promise.resolve();
        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.then(() => gate);
        providerWriteTailByCoordinationKey.set(this.coordinationKey, tail);

        await previous;

        try {
            return await fn({
                get: async (key) => await this.get(key),
                list: async (prefix) => await this.list(prefix),
                set: async (key, value, expireAtTimestamp = NEVER_EXPIRE_AT_TIMESTAMP) => {
                    await this.provider.setItem(
                        key,
                        value,
                        {
                            expireAtTimestamp
                        }
                    );
                },
                remove: async (key) => {
                    await this.provider.removeItem(key);
                }
            });
        }
        finally {
            release?.();
            if (providerWriteTailByCoordinationKey.get(this.coordinationKey) === tail) {
                providerWriteTailByCoordinationKey.delete(this.coordinationKey);
            }
        }
    }
}

function isExpired(expireAtTimestamp: number): boolean {
    return !Number.isFinite(expireAtTimestamp) || expireAtTimestamp <= Date.now();
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
    handler: (cursor: IDBCursorWithValue) => Promise<void> | void
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

            Promise.resolve(handler(cursor))
                .then(() => cursor.continue())
                .catch(reject);
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
