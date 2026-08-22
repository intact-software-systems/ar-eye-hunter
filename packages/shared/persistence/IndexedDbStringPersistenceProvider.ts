import { openIndexedDbWithStore } from './openIndexedDb.ts';
import type { PersistenceProvider, PersistenceSetItemOptions } from './PersistenceProvider.ts';

type StoredIndexedDbValue<V> = Readonly<{
    key: string;
    value: V;
    expireAtTimestamp: number;
}>;

export type IndexedDbStringPersistenceProviderOptions = Readonly<{
    dbName?: string;
    storeName?: string;
    keyPrefix?: string;
}>;

export class IndexedDbStringPersistenceProvider<V> implements PersistenceProvider<string, V> {
    static readonly DEFAULT_DB_NAME = 'ar-eye-hunter-persistence';
    static readonly DEFAULT_STORE_NAME = 'entries';

    private readonly dbName: string;
    private readonly storeName: string;
    private readonly keyPrefix?: string;
    private dbPromise?: Promise<IDBDatabase>;

    constructor(options: IndexedDbStringPersistenceProviderOptions = {}) {
        this.dbName = options.dbName ?? IndexedDbStringPersistenceProvider.DEFAULT_DB_NAME;
        this.storeName = options.storeName ?? IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME;
        this.keyPrefix = options.keyPrefix;
    }

    static isSupported(): boolean {
        return typeof indexedDB !== 'undefined';
    }

    async getItem(key: string): Promise<V | undefined> {
        const db = await this.openDb();
        const storedKey = this.toStoredKey(key);

        return await new Promise<V | undefined>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const request = store.get(storedKey);
            let value: V | undefined;

            tx.oncomplete = () => resolve(value);
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB getItem aborted'));
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB getItem failed'));
            request.onerror = () => reject(request.error ?? new Error('IndexedDB get failed'));
            request.onsuccess = () => {
                const result = request.result as StoredIndexedDbValue<V> | undefined;
                if (!result) {
                    return;
                }

                if (this.isExpired(result.expireAtTimestamp)) {
                    const deleteRequest = store.delete(storedKey);
                    deleteRequest.onerror = () =>
                        reject(deleteRequest.error ?? new Error('IndexedDB delete failed during getItem'));
                    return;
                }

                value = result.value;
            };
        });
    }

    async setItem(
        key: string,
        value: V,
        options: PersistenceSetItemOptions
    ): Promise<void> {
        const db = await this.openDb();
        const storedKey = this.toStoredKey(key);

        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const request = store.put(
                {
                    key: storedKey,
                    value,
                    expireAtTimestamp: this.toExpireAtTimestamp(options.expireAtTimestamp)
                } satisfies StoredIndexedDbValue<V>
            );

            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB setItem aborted'));
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB setItem failed'));
            request.onerror = () => reject(request.error ?? new Error('IndexedDB put failed'));
        });
    }

    async removeItem(key: string): Promise<void> {
        const db = await this.openDb();
        const storedKey = this.toStoredKey(key);

        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const request = store.delete(storedKey);

            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB removeItem aborted'));
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB removeItem failed'));
            request.onerror = () => reject(request.error ?? new Error('IndexedDB delete failed'));
        });
    }

    async getAllKeys(): Promise<string[]> {
        const db = await this.openDb();

        return await new Promise<string[]>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const request = store.openCursor();
            const keys: string[] = [];

            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB getAllKeys aborted'));
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB getAllKeys failed'));
            tx.oncomplete = () => resolve(keys);

            request.onerror = () => reject(request.error ?? new Error('IndexedDB getAllKeys failed'));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    return;
                }

                const stored = cursor.value as StoredIndexedDbValue<V>;
                if (!this.matchesPrefix(stored.key)) {
                    cursor.continue();
                    return;
                }

                if (this.isExpired(stored.expireAtTimestamp)) {
                    const deleteRequest = cursor.delete();
                    deleteRequest.onerror = () =>
                        reject(deleteRequest.error ?? new Error('IndexedDB delete failed during getAllKeys'));
                    deleteRequest.onsuccess = () => cursor.continue();
                    return;
                }

                keys.push(this.fromStoredKey(stored.key));
                cursor.continue();
            };
        });
    }

    async deleteExpired(): Promise<number> {
        const db = await this.openDb();

        return await new Promise<number>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const request = store.openCursor();
            let deleted = 0;

            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB deleteExpired aborted'));
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB deleteExpired failed'));
            tx.oncomplete = () => resolve(deleted);

            request.onerror = () => reject(request.error ?? new Error('IndexedDB deleteExpired cursor failed'));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    return;
                }

                const stored = cursor.value as StoredIndexedDbValue<V>;
                if (!this.matchesPrefix(stored.key) || !this.isExpired(stored.expireAtTimestamp)) {
                    cursor.continue();
                    return;
                }

                deleted += 1;
                const deleteRequest = cursor.delete();
                deleteRequest.onerror = () =>
                    reject(deleteRequest.error ?? new Error('IndexedDB delete failed during deleteExpired'));
                deleteRequest.onsuccess = () => cursor.continue();
            };
        });
    }

    private async openDb(): Promise<IDBDatabase> {
        if (!IndexedDbStringPersistenceProvider.isSupported()) {
            throw new Error('IndexedDB is not supported in this environment');
        }

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

    private toStoredKey(key: string): string {
        return this.keyPrefix ? `${this.keyPrefix}:${key}` : key;
    }

    private fromStoredKey(storedKey: string): string {
        if (!this.keyPrefix) {
            return storedKey;
        }

        return storedKey.slice(this.keyPrefix.length + 1);
    }

    private matchesPrefix(storedKey: string): boolean {
        if (!this.keyPrefix) {
            return true;
        }

        return storedKey.startsWith(`${this.keyPrefix}:`);
    }

    private isExpired(expireAtTimestamp: number): boolean {
        return !Number.isFinite(expireAtTimestamp) || expireAtTimestamp <= Date.now();
    }

    private toExpireAtTimestamp(expireAtTimestamp: number): number {
        if (!Number.isFinite(expireAtTimestamp)) {
            throw new Error('expireAtTimestamp must be a finite number');
        }

        return expireAtTimestamp;
    }
}
