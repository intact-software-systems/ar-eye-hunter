import { toError } from '../resilience/to-error.ts';

interface IndexedDbIndexDefinition {
    readonly name: string;
    readonly keyPath: string | readonly string[];
    readonly unique?: boolean;
}

export interface IndexedDbStoreDefinition<InitialRecord extends object> {
    readonly name: string;
    readonly keyPath: string;
    readonly indexes?: readonly IndexedDbIndexDefinition[];
    readonly initialRecords?: readonly InitialRecord[];
}

interface IndexedDbIndexSchema {
    readonly name: string;
    readonly keyPath: string | string[];
    readonly unique: boolean;
}

interface IndexedDbStoreSchema<InitialRecord extends object> {
    readonly name: string;
    readonly keyPath: string;
    readonly indexes: readonly IndexedDbIndexSchema[];
    readonly initialRecords: readonly InitialRecord[];
}

/** Copied values only; no live database, transaction, store or index handles reach validation. */
interface IndexedDbDatabaseMetadata {
    readonly storeNames: readonly string[];
    readonly stores: readonly IndexedDbStoreMetadata[];
}

interface IndexedDbStoreMetadata {
    readonly name: string;
    readonly keyPath: string | readonly string[] | null;
    readonly autoIncrement: boolean;
    readonly indexes: readonly IndexedDbIndexMetadata[];
}

interface IndexedDbIndexMetadata {
    readonly name: string;
    readonly keyPath: string | readonly string[];
    readonly unique: boolean;
    readonly multiEntry: boolean;
}

export interface OpenedIndexedDb {
    readonly db: IDBDatabase;
    /** Empty when the opened database is the required schema; every reason it is not otherwise. */
    readonly schemaIssues: readonly string[];
    /** The open ran `upgradeneeded`: an open that names no version does so only when the database did not exist. */
    readonly created: boolean;
}

type OpenedIndexedDbHandle = Pick<OpenedIndexedDb, 'db' | 'created'>;

/** Thrown when an existing database's store, key path, auto-increment, or index set is not the required schema. */
class IndexedDbSchemaMismatchError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = 'IndexedDbSchemaMismatchError';
    }
}

/** One open per uncached connection attempt; failure or versionchange permits a fresh caller-owned attempt. */
export type IndexedDbOpening = () => Promise<IDBDatabase>;

export class IndexedDbConnection {
    private opening?: Promise<IDBDatabase>;
    private readonly openDatabase: IndexedDbOpening;

    constructor(openDatabase: IndexedDbOpening) {
        this.openDatabase = openDatabase;
    }

    async open(): Promise<IDBDatabase> {
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

/**
 * Opens the database and reports whether what it found is the required schema, without deciding
 * what a mismatch means. Existing databases are never upgraded or rewritten; the caller closes
 * the returned handle after using it or refusing its reported mismatch.
 */
export async function openIndexedDbWithValidatedStores<InitialRecord extends object>(
    dbName: string,
    definitions: readonly IndexedDbStoreDefinition<InitialRecord>[]
): Promise<OpenedIndexedDb> {
    if (typeof indexedDB === 'undefined') {
        throw new Error('IndexedDB is not supported in this environment');
    }
    const stores = definitions.map(toIndexedDbStoreSchema);
    const issues = validateIndexedDbStoreNames(stores);
    if (issues.length > 0) {
        throw new Error(issues[0]);
    }
    const { db, created } = await openIndexedDb(dbName, stores);
    db.onversionchange = () => db.close();
    try {
        const metadata = readIndexedDbDatabaseMetadata(db, stores);
        return { db, schemaIssues: validateIndexedDbDatabaseSchema(metadata, stores), created };
    }
    catch (error) {
        db.close();
        throw error;
    }
}

/** The same open for a caller whose contract is that a schema mismatch is a defect, not an outcome. */
export async function openIndexedDbWithStores<InitialRecord extends object>(
    dbName: string,
    definitions: readonly IndexedDbStoreDefinition<InitialRecord>[]
): Promise<IDBDatabase> {
    const opened = await openIndexedDbWithValidatedStores(dbName, definitions);
    if (opened.schemaIssues.length === 0) {
        return opened.db;
    }
    opened.db.close();
    throw new IndexedDbSchemaMismatchError(opened.schemaIssues[0]);
}

function toIndexedDbStoreSchema<InitialRecord extends object>(
    definition: IndexedDbStoreDefinition<InitialRecord>
): IndexedDbStoreSchema<InitialRecord> {
    return {
        name: definition.name,
        keyPath: definition.keyPath,
        indexes: (definition.indexes ?? []).map((index) => ({
            name: index.name,
            keyPath: typeof index.keyPath === 'string'
                ? index.keyPath
                : [...index.keyPath],
            unique: index.unique ?? false
        })),
        initialRecords: [...(definition.initialRecords ?? [])]
    };
}

function validateIndexedDbStoreNames(
    stores: readonly IndexedDbStoreSchema<object>[]
): readonly string[] {
    const names = new Set(stores.map((store) => store.name));
    return stores.length === 0 || names.size !== stores.length
        ? ['IndexedDB schema requires distinct store names']
        : [];
}

/** Captures native metadata and owns its transaction/getter failures; a name mismatch needs no transaction. */
function readIndexedDbDatabaseMetadata(
    db: IDBDatabase,
    stores: readonly IndexedDbStoreSchema<object>[]
): IndexedDbDatabaseMetadata {
    const storeNames = [...db.objectStoreNames];
    return {
        storeNames,
        stores: hasMatchingIndexedDbStoreNames(storeNames, stores)
            ? stores.map((store) => readIndexedDbStoreMetadata(db, store.name))
            : []
    };
}

function readIndexedDbStoreMetadata(db: IDBDatabase, storeName: string): IndexedDbStoreMetadata {
    const store = db.transaction(storeName).objectStore(storeName);
    const keyPath = store.keyPath;
    return {
        name: storeName,
        keyPath: keyPath === null || typeof keyPath === 'string' ? keyPath : [...keyPath],
        autoIncrement: store.autoIncrement,
        indexes: [...store.indexNames].map((name) => {
            const index = store.index(name);
            const keyPath = index.keyPath;
            return {
                name,
                keyPath: typeof keyPath === 'string' ? keyPath : [...keyPath],
                unique: index.unique,
                multiEntry: index.multiEntry
            };
        })
    };
}

function hasMatchingIndexedDbStoreNames(
    names: readonly string[],
    stores: readonly IndexedDbStoreSchema<object>[]
): boolean {
    return names.length === stores.length && stores.every((store) => names.includes(store.name));
}

/** Every reason the captured database is not the required schema; empty means it is. */
function validateIndexedDbDatabaseSchema(
    metadata: IndexedDbDatabaseMetadata,
    stores: readonly IndexedDbStoreSchema<object>[]
): readonly string[] {
    if (!hasMatchingIndexedDbStoreNames(metadata.storeNames, stores)) {
        return ['IndexedDB database stores do not match the required schema'];
    }
    return stores.flatMap((store, position) => validateIndexedDbStoreSchema(metadata.stores[position], store));
}

function validateIndexedDbStoreSchema(
    metadata: IndexedDbStoreMetadata,
    store: IndexedDbStoreSchema<object>
): readonly string[] {
    const issues: string[] = [];
    if (!isEqualKeyPath(metadata.keyPath, store.keyPath)) {
        issues.push(
            `IndexedDB store "${store.name}" has key path "${formatKeyPath(metadata.keyPath)}"; ` +
                `expected "${store.keyPath}"`
        );
    }
    if (metadata.autoIncrement) {
        issues.push(`IndexedDB store "${store.name}" auto-increment does not match its required schema`);
    }
    if (
        metadata.indexes.length !== store.indexes.length ||
        store.indexes.some((index) =>
            !isMatchingIndex(metadata.indexes.find((actual) => actual.name === index.name), index)
        )
    ) {
        issues.push(`IndexedDB indexes for "${store.name}" do not match their required schema`);
    }
    return issues;
}

function formatKeyPath(keyPath: string | readonly string[] | null): string {
    if (keyPath === null) {
        return 'null';
    }
    return typeof keyPath === 'string' ? keyPath : keyPath.join(',');
}

async function openIndexedDb<InitialRecord extends object>(
    dbName: string,
    stores: readonly IndexedDbStoreSchema<InitialRecord>[]
): Promise<OpenedIndexedDbHandle> {
    return await new Promise<OpenedIndexedDbHandle>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        let schemaWriteError: Error | undefined;
        let created = false;
        request.onupgradeneeded = () => {
            created = true;
            try {
                for (const store of stores) {
                    createIndexedDbStore(request.result, store);
                }
            }
            catch (error) {
                schemaWriteError = toError(error);
                request.transaction!.abort();
            }
        };
        request.onsuccess = () => resolve({ db: request.result, created });
        request.onerror = () => reject(schemaWriteError ?? request.error ?? new Error('IndexedDB open failed'));
    });
}

function createIndexedDbStore<InitialRecord extends object>(
    db: IDBDatabase,
    store: IndexedDbStoreSchema<InitialRecord>
): void {
    const objectStore = db.createObjectStore(store.name, { keyPath: store.keyPath });
    for (const index of store.indexes) {
        objectStore.createIndex(index.name, index.keyPath, { unique: index.unique });
    }
    for (const record of store.initialRecords) {
        objectStore.put(record);
    }
}

function isMatchingIndex(
    actual: IndexedDbIndexMetadata | undefined,
    definition: IndexedDbIndexSchema
): boolean {
    return actual !== undefined && actual.unique === definition.unique &&
        actual.multiEntry === false &&
        isEqualKeyPath(actual.keyPath, definition.keyPath);
}

function isEqualKeyPath(
    actual: string | readonly string[] | null,
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
