export type IndexedDbIndexDefinition = Readonly<{
    name: string;
    keyPath: string | readonly string[];
    unique?: boolean;
}>;

export type IndexedDbStoreDefinition = Readonly<{
    name: string;
    keyPath: string;
    indexes?: readonly IndexedDbIndexDefinition[];
    migrateOnUpgrade?: (store: IDBObjectStore) => void;
}>;

export async function openIndexedDbWithStore(
    dbName: string,
    store: IndexedDbStoreDefinition
): Promise<IDBDatabase> {
    return await openIndexedDbWithStores(dbName, [store]);
}

export async function openIndexedDbWithStores(
    dbName: string,
    stores: readonly IndexedDbStoreDefinition[]
): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') {
        throw new Error('IndexedDB is not supported in this environment');
    }

    const initialDb = await openIndexedDb(
        dbName,
        undefined,
        (db, transaction) => ensureStores(db, transaction, stores)
    );
    if (!hasSchemaMismatch(initialDb, stores)) {
        initialDb.onversionchange = () => initialDb.close();
        return initialDb;
    }

    const nextVersion = Math.max(1, initialDb.version) + 1;
    initialDb.close();

    const upgradedDb = await openIndexedDb(
        dbName,
        nextVersion,
        (db, transaction) => ensureStores(db, transaction, stores)
    );
    upgradedDb.onversionchange = () => upgradedDb.close();

    for (const store of stores) {
        if (!upgradedDb.objectStoreNames.contains(store.name)) {
            upgradedDb.close();
            throw new Error(`IndexedDB store "${store.name}" was not created`);
        }
        const existingStore = upgradedDb.transaction(store.name).objectStore(store.name);
        for (const index of store.indexes ?? []) {
            if (!isMatchingIndex(existingStore, index)) {
                upgradedDb.close();
                throw new Error(`IndexedDB index "${index.name}" does not match its schema`);
            }
        }
    }

    return upgradedDb;
}

async function openIndexedDb(
    dbName: string,
    version?: number,
    onUpgradeNeeded?: (db: IDBDatabase, transaction: IDBTransaction) => void
): Promise<IDBDatabase> {
    return await new Promise<IDBDatabase>((resolve, reject) => {
        const request = version === undefined
            ? indexedDB.open(dbName)
            : indexedDB.open(dbName, version);

        request.onupgradeneeded = () => {
            if (!request.transaction) {
                reject(new Error('IndexedDB upgrade transaction is unavailable'));
                return;
            }
            onUpgradeNeeded?.(request.result, request.transaction);
        };

        request.onsuccess = () => {
            resolve(request.result);
        };

        request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
        request.onblocked = () => reject(new Error('IndexedDB open blocked'));
    });
}

function ensureStores(
    db: IDBDatabase,
    transaction: IDBTransaction,
    stores: readonly IndexedDbStoreDefinition[]
): void {
    for (const store of stores) {
        const objectStore = !db.objectStoreNames.contains(store.name)
            ? db.createObjectStore(store.name, {
                keyPath: store.keyPath
            })
            : transaction.objectStore(store.name);
        for (const index of store.indexes ?? []) {
            if (
                objectStore.indexNames.contains(index.name) &&
                !isMatchingIndex(objectStore, index)
            ) {
                objectStore.deleteIndex(index.name);
            }
            if (!objectStore.indexNames.contains(index.name)) {
                objectStore.createIndex(
                    index.name,
                    Array.isArray(index.keyPath) ? [...index.keyPath] : index.keyPath,
                    { unique: index.unique ?? false }
                );
            }
        }
        store.migrateOnUpgrade?.(objectStore);
    }
}

function hasSchemaMismatch(
    db: IDBDatabase,
    stores: readonly IndexedDbStoreDefinition[]
): boolean {
    for (const store of stores) {
        if (!db.objectStoreNames.contains(store.name)) {
            return true;
        }
        const objectStore = db.transaction(store.name).objectStore(store.name);
        for (const index of store.indexes ?? []) {
            if (!isMatchingIndex(objectStore, index)) {
                return true;
            }
        }
    }
    return false;
}

function isMatchingIndex(
    store: IDBObjectStore,
    definition: IndexedDbIndexDefinition
): boolean {
    if (!store.indexNames.contains(definition.name)) {
        return false;
    }

    const index = store.index(definition.name);
    return index.unique === (definition.unique ?? false) &&
        isEqualKeyPath(index.keyPath, definition.keyPath);
}

function isEqualKeyPath(
    actual: string | string[],
    expected: string | readonly string[]
): boolean {
    if (typeof actual === 'string' || typeof expected === 'string') {
        return actual === expected;
    }
    return actual.length === expected.length &&
        actual.every((part, index) => part === expected[index]);
}
