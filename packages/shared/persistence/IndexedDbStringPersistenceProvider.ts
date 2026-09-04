import {
    deleteComputedIndexedDbStringValues,
    removeComputedIndexedDbStringValue,
    StoredIndexedDbValue,
    writeComputedIndexedDbStringValue
} from './indexed-db-string-persistence-write.ts';
import { openIndexedDbWithStore } from './openIndexedDb.ts';
import type { PersistenceProvider, PersistenceSetItemOptions } from './PersistenceProvider.ts';

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
        const result = await this.readStoredValue(db, storedKey);
        if (!result) {
            return undefined;
        }
        if (!this.isExpired(result.expireAtTimestamp, Date.now())) {
            return result.value;
        }
        this.requireCleanupCommit(
            await deleteComputedIndexedDbStringValues(db, this.storeName, [{
                key: storedKey,
                expectedExpireAtTimestamp: result.expireAtTimestamp
            }])
        );
        return undefined;
    }

    async setItem(
        key: string,
        value: V,
        options: PersistenceSetItemOptions
    ): Promise<void> {
        const db = await this.openDb();
        const storedKey = this.toStoredKey(key);
        const stored = {
            key: storedKey,
            value,
            expireAtTimestamp: this.toExpireAtTimestamp(options.expireAtTimestamp)
        } satisfies StoredIndexedDbValue<V>;
        await writeComputedIndexedDbStringValue(db, this.storeName, stored);
    }

    async removeItem(key: string): Promise<void> {
        const db = await this.openDb();
        const storedKey = this.toStoredKey(key);

        await removeComputedIndexedDbStringValue(db, this.storeName, storedKey);
    }

    async getAllKeys(): Promise<string[]> {
        const db = await this.openDb();
        const storedValues = await this.readAllStoredValues(db);
        const now = Date.now();
        const matching = storedValues.filter((stored) => this.matchesPrefix(stored.key));
        const expired = matching.filter((stored) => this.isExpired(stored.expireAtTimestamp, now));
        const keys = matching
            .filter((stored) => !this.isExpired(stored.expireAtTimestamp, now))
            .map((stored) => this.fromStoredKey(stored.key));
        this.requireCleanupCommit(
            await deleteComputedIndexedDbStringValues(
                db,
                this.storeName,
                expired.map((stored) => ({
                    key: stored.key,
                    expectedExpireAtTimestamp: stored.expireAtTimestamp
                }))
            )
        );
        return keys;
    }

    async deleteExpired(): Promise<number> {
        const db = await this.openDb();
        const storedValues = await this.readAllStoredValues(db);
        const now = Date.now();
        const expired = storedValues.filter(
            (stored) =>
                this.matchesPrefix(stored.key) &&
                this.isExpired(stored.expireAtTimestamp, now)
        );
        this.requireCleanupCommit(
            await deleteComputedIndexedDbStringValues(
                db,
                this.storeName,
                expired.map((stored) => ({
                    key: stored.key,
                    expectedExpireAtTimestamp: stored.expireAtTimestamp
                }))
            )
        );
        return expired.length;
    }

    private async readStoredValue(
        db: IDBDatabase,
        storedKey: string
    ): Promise<StoredIndexedDbValue<V> | undefined> {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const request = tx.objectStore(this.storeName).get(storedKey);
            request.onsuccess = () => resolve(request.result as StoredIndexedDbValue<V> | undefined);
            request.onerror = () => reject(request.error ?? new Error('IndexedDB get failed'));
        });
    }

    private async readAllStoredValues(db: IDBDatabase): Promise<readonly StoredIndexedDbValue<V>[]> {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const request = tx.objectStore(this.storeName).openCursor();
            const values: StoredIndexedDbValue<V>[] = [];
            request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed'));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve(values);
                    return;
                }
                values.push(cursor.value as StoredIndexedDbValue<V>);
                cursor.continue();
            };
        });
    }

    private requireCleanupCommit(committed: boolean): void {
        if (!committed) {
            throw new Error('IndexedDB persistence cleanup conflicted');
        }
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

    private isExpired(expireAtTimestamp: number, now: number): boolean {
        return !Number.isFinite(expireAtTimestamp) || expireAtTimestamp <= now;
    }

    private toExpireAtTimestamp(expireAtTimestamp: number): number {
        if (!Number.isFinite(expireAtTimestamp)) {
            throw new Error('expireAtTimestamp must be a finite number');
        }

        return expireAtTimestamp;
    }
}
