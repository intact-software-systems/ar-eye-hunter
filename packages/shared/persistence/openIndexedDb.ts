export type IndexedDbIndexDefinition = Readonly<{
    name: string;
    keyPath: string | readonly string[];
    unique?: boolean;
}>;

export type IndexedDbStoreDefinition = Readonly<{
    name: string;
    keyPath: string;
    indexes?: readonly IndexedDbIndexDefinition[];
}>;

export async function openIndexedDbWithStore(
    dbName: string,
    store: IndexedDbStoreDefinition,
): Promise<IDBDatabase> {
    return await openIndexedDbWithStores(dbName, [store]);
}

export async function openIndexedDbWithStores(
    dbName: string,
    stores: readonly IndexedDbStoreDefinition[],
): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') {
        throw new Error('IndexedDB is not supported in this environment');
    }

    const initialDb = await openIndexedDb(
        dbName,
        undefined,
        (db, transaction) => ensureStores(db, transaction, stores),
    );
    if (!hasMissingSchema(initialDb, stores)) {
        initialDb.onversionchange = () => initialDb.close();
        return initialDb;
    }

    const nextVersion = Math.max(1, initialDb.version) + 1;
    initialDb.close();

    const upgradedDb = await openIndexedDb(
        dbName,
        nextVersion,
        (db, transaction) => ensureStores(db, transaction, stores),
    );
    upgradedDb.onversionchange = () => upgradedDb.close();

    for (const store of stores) {
        if (!upgradedDb.objectStoreNames.contains(store.name)) {
            upgradedDb.close();
            throw new Error(`IndexedDB store "${store.name}" was not created`);
        }
        const existingStore = upgradedDb.transaction(store.name).objectStore(store.name);
        for (const index of store.indexes ?? []) {
            if (!existingStore.indexNames.contains(index.name)) {
                upgradedDb.close();
                throw new Error(`IndexedDB index "${index.name}" was not created`);
            }
        }
    }

    return upgradedDb;
}

async function openIndexedDb(
    dbName: string,
    version?: number,
    onUpgradeNeeded?: (db: IDBDatabase, transaction: IDBTransaction) => void,
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
    stores: readonly IndexedDbStoreDefinition[],
): void {
    for (const store of stores) {
        const objectStore = !db.objectStoreNames.contains(store.name)
            ? db.createObjectStore(store.name, {
                keyPath: store.keyPath,
            })
            : transaction.objectStore(store.name);
        for (const index of store.indexes ?? []) {
            if (!objectStore.indexNames.contains(index.name)) {
                objectStore.createIndex(
                    index.name,
                    Array.isArray(index.keyPath) ? [...index.keyPath] : index.keyPath,
                    { unique: index.unique ?? false },
                );
            }
        }
    }
}

function hasMissingSchema(
    db: IDBDatabase,
    stores: readonly IndexedDbStoreDefinition[],
): boolean {
    for (const store of stores) {
        if (!db.objectStoreNames.contains(store.name)) {
            return true;
        }
        const objectStore = db.transaction(store.name).objectStore(store.name);
        for (const index of store.indexes ?? []) {
            if (!objectStore.indexNames.contains(index.name)) {
                return true;
            }
        }
    }
    return false;
}
