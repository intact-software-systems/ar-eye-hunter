export interface IndexedDbIndexDefinition {
    readonly name: string;
    readonly keyPath: string | readonly string[];
    readonly unique?: boolean;
}

export interface IndexedDbStoreDefinition {
    readonly name: string;
    readonly keyPath: string;
    readonly indexes?: readonly IndexedDbIndexDefinition[];
}

export type IndexedDbStoreMigration = (database: IDBDatabase) => Promise<void>;

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

const indexedDbOpenTailByName = new Map<string, Promise<void>>();

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
    definition: IndexedDbStoreDefinition,
    migrate?: IndexedDbStoreMigration
): Promise<IDBDatabase> {
    const store = toIndexedDbStoreSchema(definition);
    return await runSerializedIndexedDbOpen(
        dbName,
        async () => {
            const database = await openIndexedDbWithStoreOnce(dbName, store);
            try {
                await migrate?.(database);
                return database;
            }
            catch (error) {
                database.close();
                throw error;
            }
        }
    );
}

async function openIndexedDbWithStoreOnce(
    dbName: string,
    store: IndexedDbStoreSchema
): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') {
        throw new Error('IndexedDB is not supported in this environment');
    }

    const initialDb = await openIndexedDb(dbName, store);
    try {
        assertCompatibleStoreKeyPath(initialDb, store);
    }
    catch (error) {
        initialDb.close();
        throw error;
    }
    if (!hasSchemaMismatch(initialDb, store)) {
        initialDb.onversionchange = () => initialDb.close();
        return initialDb;
    }

    const nextVersion = Math.max(1, initialDb.version) + 1;
    initialDb.close();

    const upgradedDb = await openIndexedDb(dbName, store, nextVersion);
    upgradedDb.onversionchange = () => upgradedDb.close();
    try {
        assertIndexedDbStoreSchema(upgradedDb, store);
        return upgradedDb;
    }
    catch (error) {
        upgradedDb.close();
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

function assertCompatibleStoreKeyPath(
    db: IDBDatabase,
    store: IndexedDbStoreSchema
): void {
    if (!db.objectStoreNames.contains(store.name)) {
        return;
    }
    const actual = db.transaction(store.name).objectStore(store.name).keyPath;
    if (!isEqualKeyPath(actual, store.keyPath)) {
        throw new Error(
            `IndexedDB store "${store.name}" has key path "${formatKeyPath(actual)}"; ` +
                `expected "${store.keyPath}"`
        );
    }
}

function assertIndexedDbStoreSchema(
    db: IDBDatabase,
    store: IndexedDbStoreSchema
): void {
    assertCompatibleStoreKeyPath(db, store);
    if (!db.objectStoreNames.contains(store.name)) {
        throw new Error(`IndexedDB store "${store.name}" was not created`);
    }
    if (!hasMatchingIndexes(db, store)) {
        throw new Error(`IndexedDB indexes for "${store.name}" do not match their schema`);
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
    store: IndexedDbStoreSchema,
    version?: number
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
            writeIndexedDbSchema(request.result, request.transaction, store);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    });
}

async function runSerializedIndexedDbOpen<Value>(
    dbName: string,
    open: () => Promise<Value>
): Promise<Value> {
    const previous = indexedDbOpenTailByName.get(dbName) ?? Promise.resolve();
    const opening = previous.then(open);
    const tail = opening.then(
        () => undefined,
        () => undefined
    );
    indexedDbOpenTailByName.set(dbName, tail);
    try {
        return await opening;
    }
    finally {
        if (indexedDbOpenTailByName.get(dbName) === tail) {
            indexedDbOpenTailByName.delete(dbName);
        }
    }
}

function writeIndexedDbSchema(
    db: IDBDatabase,
    transaction: IDBTransaction,
    store: IndexedDbStoreSchema
): void {
    const objectStore = !db.objectStoreNames.contains(store.name)
        ? db.createObjectStore(store.name, { keyPath: store.keyPath })
        : transaction.objectStore(store.name);
    for (const index of store.indexes) {
        if (
            objectStore.indexNames.contains(index.name) &&
            !isMatchingIndex(objectStore, index)
        ) {
            objectStore.deleteIndex(index.name);
        }
        if (!objectStore.indexNames.contains(index.name)) {
            objectStore.createIndex(index.name, index.keyPath, { unique: index.unique });
        }
    }
}

function hasSchemaMismatch(
    db: IDBDatabase,
    store: IndexedDbStoreSchema
): boolean {
    return !db.objectStoreNames.contains(store.name) || !hasMatchingIndexes(db, store);
}

function hasMatchingIndexes(
    db: IDBDatabase,
    store: IndexedDbStoreSchema
): boolean {
    if (!db.objectStoreNames.contains(store.name)) {
        return false;
    }
    const objectStore = db.transaction(store.name).objectStore(store.name);
    return store.indexes.every((index) => isMatchingIndex(objectStore, index));
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
