import {
    readIndexedDbRequest,
    waitForIndexedDbTransaction
} from './indexed-db-request.ts';
import {
    decodeStoredIndexedDbValue,
    deleteComputedIndexedDbStringValues,
    removeComputedIndexedDbStringValue,
    StoredIndexedDbValue,
    writeComputedIndexedDbStringValue,
    type ComputedIndexedDbStringDeletion
} from './indexed-db-string-persistence-write.ts';
import { IndexedDbConnection, openIndexedDbWithStore } from './openIndexedDb.ts';
import type { PersistenceProvider, PersistenceSetItemOptions } from './PersistenceProvider.ts';

export type IndexedDbStringPersistenceProviderOptions = Readonly<{
    dbName?: string;
    storeName?: string;
    keyPrefix?: string;
}>;

export class IndexedDbStringPersistenceProvider<V> implements PersistenceProvider<string, V> {
    static readonly DEFAULT_DB_NAME = 'ar-eye-hunter-persistence';
    static readonly DEFAULT_STORE_NAME = 'entries';

    readonly #connection: IndexedDbConnection;
    readonly #storeName: string;
    readonly #storedKeyPrefix: string;

    constructor(options: IndexedDbStringPersistenceProviderOptions = {}) {
        const dbName = options.dbName ?? IndexedDbStringPersistenceProvider.DEFAULT_DB_NAME;
        this.#storeName = options.storeName ?? IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME;
        this.#storedKeyPrefix = options.keyPrefix ? `${options.keyPrefix}:` : '';
        this.#connection = new IndexedDbConnection(() =>
            openIndexedDbWithStore(dbName, {
                name: this.#storeName,
                keyPath: 'key'
            })
        );
    }

    static isSupported(): boolean {
        return typeof indexedDB !== 'undefined';
    }

    async getItem(key: string): Promise<V | undefined> {
        const db = await this.#connection.get();
        const storedKey = toStoredIndexedDbKey(this.#storedKeyPrefix, key);
        const result = await readStoredIndexedDbValue<V>(db, this.#storeName, storedKey);
        if (!result) {
            return undefined;
        }
        if (!isIndexedDbValueExpired(result.expireAtTimestamp, Date.now())) {
            return result.value;
        }
        requireIndexedDbCleanupCommit(
            await deleteComputedIndexedDbStringValues(
                db,
                this.#storeName,
                [{
                    key: storedKey,
                    expectedExpireAtTimestamp: result.expireAtTimestamp,
                    expectedWriteToken: result.writeToken
                }]
            )
        );
        return undefined;
    }

    async setItem(
        key: string,
        value: V,
        options: PersistenceSetItemOptions
    ): Promise<void> {
        const db = await this.#connection.get();
        const storedKey = toStoredIndexedDbKey(this.#storedKeyPrefix, key);
        const stored = {
            key: storedKey,
            value,
            expireAtTimestamp: requireFiniteExpireAtTimestamp(options.expireAtTimestamp),
            writeToken: crypto.randomUUID()
        } satisfies StoredIndexedDbValue<V>;
        await writeComputedIndexedDbStringValue(db, this.#storeName, stored);
    }

    async removeItem(key: string): Promise<void> {
        const db = await this.#connection.get();
        const storedKey = toStoredIndexedDbKey(this.#storedKeyPrefix, key);

        await removeComputedIndexedDbStringValue(db, this.#storeName, storedKey);
    }

    async getAllKeys(): Promise<string[]> {
        const db = await this.#connection.get();
        const storedValues = await readAllStoredIndexedDbValues<V>(db, this.#storeName);
        const computed = computeIndexedDbStringExpiry(
            storedValues,
            this.#storedKeyPrefix,
            Date.now()
        );
        requireIndexedDbCleanupCommit(
            await deleteComputedIndexedDbStringValues(
                db,
                this.#storeName,
                computed.deletions
            )
        );
        return computed.keys;
    }

    async deleteExpired(): Promise<number> {
        const db = await this.#connection.get();
        const storedValues = await readAllStoredIndexedDbValues<V>(db, this.#storeName);
        const computed = computeIndexedDbStringExpiry(
            storedValues,
            this.#storedKeyPrefix,
            Date.now()
        );
        requireIndexedDbCleanupCommit(
            await deleteComputedIndexedDbStringValues(
                db,
                this.#storeName,
                computed.deletions
            )
        );
        return computed.deletions.length;
    }
}

async function readStoredIndexedDbValue<Value>(
    db: IDBDatabase,
    storeName: string,
    storedKey: string
): Promise<StoredIndexedDbValue<Value> | undefined> {
    const transaction = db.transaction(storeName, 'readonly');
    const completed = waitForIndexedDbTransaction(transaction);
    const stored = await readIndexedDbRequest<unknown>(
        transaction.objectStore(storeName).get(storedKey)
    );
    await completed;
    return stored === undefined
        ? undefined
        : decodeStoredIndexedDbValue<Value>(stored, storedKey);
}

async function readAllStoredIndexedDbValues<Value>(
    db: IDBDatabase,
    storeName: string
): Promise<readonly StoredIndexedDbValue<Value>[]> {
    const transaction = db.transaction(storeName, 'readonly');
    const completed = waitForIndexedDbTransaction(transaction);
    const stored = await readIndexedDbRequest<unknown[]>(
        transaction.objectStore(storeName).getAll()
    );
    await completed;
    return stored.map((value) => decodeStoredIndexedDbValue<Value>(value));
}

function requireIndexedDbCleanupCommit(committed: boolean): void {
    if (!committed) {
        throw new Error('IndexedDB persistence cleanup conflicted');
    }
}

function toStoredIndexedDbKey(storedKeyPrefix: string, key: string): string {
    return `${storedKeyPrefix}${key}`;
}

function fromStoredIndexedDbKey(storedKeyPrefix: string, storedKey: string): string {
    return storedKey.slice(storedKeyPrefix.length);
}

function matchesStoredIndexedDbKey(storedKeyPrefix: string, storedKey: string): boolean {
    return storedKey.startsWith(storedKeyPrefix);
}

function computeIndexedDbStringExpiry<Value>(
    storedValues: readonly StoredIndexedDbValue<Value>[],
    storedKeyPrefix: string,
    now: number
): Readonly<{
    deletions: readonly ComputedIndexedDbStringDeletion[];
    keys: string[];
}> {
    const deletions: ComputedIndexedDbStringDeletion[] = [];
    const keys: string[] = [];
    for (const stored of storedValues) {
        if (!matchesStoredIndexedDbKey(storedKeyPrefix, stored.key)) {
            continue;
        }
        if (isIndexedDbValueExpired(stored.expireAtTimestamp, now)) {
            deletions.push({
                key: stored.key,
                expectedExpireAtTimestamp: stored.expireAtTimestamp,
                expectedWriteToken: stored.writeToken
            });
        }
        else {
            keys.push(fromStoredIndexedDbKey(storedKeyPrefix, stored.key));
        }
    }
    return { deletions, keys };
}

function isIndexedDbValueExpired(expireAtTimestamp: number, now: number): boolean {
    return !Number.isFinite(expireAtTimestamp) || expireAtTimestamp <= now;
}

function requireFiniteExpireAtTimestamp(expireAtTimestamp: number): number {
    if (!Number.isFinite(expireAtTimestamp)) {
        throw new Error('expireAtTimestamp must be a finite number');
    }
    return expireAtTimestamp;
}
