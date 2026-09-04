interface IndexedDbIndexDefinition {
    readonly name: string;
    readonly keyPath: string | readonly string[];
    readonly unique?: boolean;
}

interface IndexedDbStoreDefinition {
    readonly name: string;
    readonly keyPath: string;
    readonly indexes?: readonly IndexedDbIndexDefinition[];
}

interface IndexedDbIndexSchema {
    readonly name: string;
    readonly keyPath: string | string[];
    readonly unique: boolean;
}

interface IndexedDbStoreSchema {
    readonly name: string;
    readonly keyPath: string;
    readonly indexes: readonly IndexedDbIndexSchema[];
}

export class IndexedDbConnection {
    private opening?: Promise<IDBDatabase>;
    private readonly openDatabase: () => Promise<IDBDatabase>;

    constructor(openDatabase: () => Promise<IDBDatabase>) {
        this.openDatabase = openDatabase;
    }

    async get(): Promise<IDBDatabase> {
        if (!this.opening) {
            this.opening = this.openDatabase().then((db) => {
                db.onversionchange = () => {
                    db.close();
                    this.opening = undefined;
                };
                return db;
            });
        }

        const opening = this.opening;
        try {
            return await opening;
        }
        catch (error) {
            if (this.opening === opening) {
                this.opening = undefined;
            }
            throw error;
        }
    }
}

export async function openIndexedDbWithStore(
    dbName: string,
    definition: IndexedDbStoreDefinition
): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') {
        throw new Error('IndexedDB is not supported in this environment');
    }
    const store = toIndexedDbStoreSchema(definition);
    const database = await openIndexedDb(dbName, store);
    database.onversionchange = () => database.close();
    try {
        assertIndexedDbStoreSchema(database, store);
        return database;
    }
    catch (error) {
        database.close();
        throw error;
    }
}

function toIndexedDbStoreSchema(definition: IndexedDbStoreDefinition): IndexedDbStoreSchema {
    return {
        name: definition.name,
        keyPath: definition.keyPath,
        indexes: (definition.indexes ?? []).map((index) => ({
            name: index.name,
            keyPath: typeof index.keyPath === 'string'
                ? index.keyPath
                : [...index.keyPath],
            unique: index.unique ?? false
        }))
    };
}

function assertIndexedDbStoreSchema(
    db: IDBDatabase,
    store: IndexedDbStoreSchema
): void {
    if (!db.objectStoreNames.contains(store.name)) {
        throw new Error(`IndexedDB database does not contain required store "${store.name}"`);
    }
    const objectStore = db.transaction(store.name).objectStore(store.name);
    if (!isEqualKeyPath(objectStore.keyPath, store.keyPath)) {
        throw new Error(
            `IndexedDB store "${store.name}" has key path "${formatKeyPath(objectStore.keyPath)}"; ` +
                `expected "${store.keyPath}"`
        );
    }
    if (store.indexes.some((index) => !isMatchingIndex(objectStore, index))) {
        throw new Error(`IndexedDB indexes for "${store.name}" do not match their required schema`);
    }
}

function formatKeyPath(keyPath: string | string[] | null): string {
    if (keyPath === null) {
        return 'null';
    }
    return typeof keyPath === 'string' ? keyPath : keyPath.join(',');
}

async function openIndexedDb(
    dbName: string,
    store: IndexedDbStoreSchema
): Promise<IDBDatabase> {
    return await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);

        request.onupgradeneeded = () => {
            createIndexedDbStore(request.result, store);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    });
}

function createIndexedDbStore(
    db: IDBDatabase,
    store: IndexedDbStoreSchema
): void {
    const objectStore = db.createObjectStore(store.name, { keyPath: store.keyPath });
    for (const index of store.indexes) {
        objectStore.createIndex(index.name, index.keyPath, { unique: index.unique });
    }
}

function isMatchingIndex(
    store: IDBObjectStore,
    definition: IndexedDbIndexSchema
): boolean {
    if (!store.indexNames.contains(definition.name)) {
        return false;
    }
    const index = store.index(definition.name);
    return index.unique === definition.unique &&
        isEqualKeyPath(index.keyPath, definition.keyPath);
}

function isEqualKeyPath(
    actual: string | string[] | null,
    expected: string | readonly string[]
): boolean {
    if (actual === null) {
        return false;
    }
    if (typeof actual === 'string' || typeof expected === 'string') {
        return actual === expected;
    }
    return actual.length === expected.length &&
        actual.every((part, index) => part === expected[index]);
}
