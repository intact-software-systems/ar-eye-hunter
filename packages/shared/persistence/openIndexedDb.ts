export type IndexedDbStoreDefinition = Readonly<{
    name: string;
    keyPath: string;
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
        db => ensureStores(db, stores),
    );
    const missingStores = stores.filter(store => !initialDb.objectStoreNames.contains(store.name));
    if (missingStores.length === 0) {
        initialDb.onversionchange = () => initialDb.close();
        return initialDb;
    }

    const nextVersion = Math.max(1, initialDb.version) + 1;
    initialDb.close();

    const upgradedDb = await openIndexedDb(
        dbName,
        nextVersion,
        db => ensureStores(db, stores),
    );
    upgradedDb.onversionchange = () => upgradedDb.close();

    for (const store of stores) {
        if (!upgradedDb.objectStoreNames.contains(store.name)) {
            upgradedDb.close();
            throw new Error(`IndexedDB store "${store.name}" was not created`);
        }
    }

    return upgradedDb;
}

async function openIndexedDb(
    dbName: string,
    version?: number,
    onUpgradeNeeded?: (db: IDBDatabase) => void,
): Promise<IDBDatabase> {
    return await new Promise<IDBDatabase>((resolve, reject) => {
        const request = version === undefined
            ? indexedDB.open(dbName)
            : indexedDB.open(dbName, version);

        request.onupgradeneeded = () => {
            onUpgradeNeeded?.(request.result);
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
    stores: readonly IndexedDbStoreDefinition[],
): void {
    for (const store of stores) {
        if (!db.objectStoreNames.contains(store.name)) {
            db.createObjectStore(store.name, {
                keyPath: store.keyPath,
            });
        }
    }
}
