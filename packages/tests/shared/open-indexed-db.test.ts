import * as FakeIndexedDb from 'fake-indexeddb';
// dprint-ignore
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import {
    IndexedDbConnection,
    openIndexedDbWithStore
} from '@shared/persistence/openIndexedDb.ts';

interface SchemaWriteObservation {
    readonly kind: 'store' | 'index';
    readonly name: string;
    readonly transactionMode: IDBTransactionMode;
}

describe('IndexedDB current schema', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('creates the complete schema in the initial versionchange transaction', async () => {
        const factory = new FakeIndexedDb.IDBFactory();
        vi.stubGlobal('indexedDB', factory);
        const writes = observeSchemaWrites();

        const database = await openIndexedDbWithStore('schema-options', {
            name: 'items',
            keyPath: 'id',
            indexes: [
                { name: 'by-group', keyPath: ['groupId', 'position'] },
                { name: 'by-reference', keyPath: 'reference', unique: true }
            ]
        });
        try {
            expect(writes).toEqual(expect.arrayContaining([
                { kind: 'store', name: 'items', transactionMode: 'versionchange' },
                { kind: 'index', name: 'by-group', transactionMode: 'versionchange' },
                { kind: 'index', name: 'by-reference', transactionMode: 'versionchange' }
            ]));
            expect(writes.every((write) => write.transactionMode === 'versionchange')).toBe(true);
            const items = database.transaction('items').objectStore('items');
            expect(items.keyPath).toBe('id');
            expect(items.index('by-group').keyPath).toEqual(['groupId', 'position']);
            expect(items.index('by-group').unique).toBe(false);
            expect(items.index('by-reference').unique).toBe(true);
        }
        finally {
            database.close();
        }
    });

    it('rejects an existing index with a different definition without changing stored records', async () => {
        const factory = new FakeIndexedDb.IDBFactory();
        vi.stubGlobal('indexedDB', factory);
        const initial = await openIndexedDbWithStore('schema-replacement', {
            name: 'items',
            keyPath: 'id',
            indexes: [{ name: 'by-group', keyPath: 'groupId', unique: false }]
        });
        const seed = initial.transaction('items', 'readwrite');
        seed.objectStore('items').put({ id: 'one', groupId: 'group', position: 1 });
        await waitForTransaction(seed);
        const initialVersion = initial.version;
        initial.close();

        await expect(openIndexedDbWithStore('schema-replacement', {
            name: 'items',
            keyPath: 'id',
            indexes: [{ name: 'by-group', keyPath: ['groupId', 'position'], unique: true }]
        })).rejects.toThrow('IndexedDB indexes for "items" do not match their required schema');

        const unchanged = await readRequest(factory.open('schema-replacement'));
        try {
            expect(unchanged.version).toBe(initialVersion);
            const items = unchanged.transaction('items').objectStore('items');
            expect(items.index('by-group').keyPath).toBe('groupId');
            expect(items.index('by-group').unique).toBe(false);
            expect(await readRequest(items.get('one'))).toEqual({
                id: 'one',
                groupId: 'group',
                position: 1
            });
        }
        finally {
            unchanged.close();
        }
    });

    it('rejects an existing store whose key path belongs to another schema', async () => {
        vi.stubGlobal('indexedDB', new FakeIndexedDb.IDBFactory());
        const initial = await openIndexedDbWithStore('schema-key-path', {
            name: 'items',
            keyPath: 'otherId'
        });
        const initialVersion = initial.version;
        initial.close();

        await expect(openIndexedDbWithStore('schema-key-path', {
            name: 'items',
            keyPath: 'id'
        })).rejects.toThrow('IndexedDB store "items" has key path "otherId"; expected "id"');

        const unchanged = await openIndexedDbWithStore('schema-key-path', {
            name: 'items',
            keyPath: 'otherId'
        });
        expect(unchanged.version).toBe(initialVersion);
        unchanged.close();
    });

    it('rejects an existing store missing a required index without changing stored records', async () => {
        const factory = new FakeIndexedDb.IDBFactory();
        vi.stubGlobal('indexedDB', factory);
        const initial = await openIndexedDbWithStore('schema-rollback', { name: 'items', keyPath: 'id' });
        const seed = initial.transaction('items', 'readwrite');
        seed.objectStore('items').put({ id: 'one', reference: 'first' });
        await waitForTransaction(seed);
        const initialVersion = initial.version;
        initial.close();

        await expect(openIndexedDbWithStore('schema-rollback', {
            name: 'items',
            keyPath: 'id',
            indexes: [{ name: 'by-reference', keyPath: 'reference', unique: true }]
        })).rejects.toThrow('IndexedDB indexes for "items" do not match their required schema');

        const unchanged = await readRequest(factory.open('schema-rollback'));
        try {
            expect(unchanged.version).toBe(initialVersion);
            expect([...unchanged.objectStoreNames]).toEqual(['items']);
            const items = unchanged.transaction('items').objectStore('items');
            expect([...items.indexNames]).toEqual([]);
            expect(await readRequest(items.getAll())).toEqual([{ id: 'one', reference: 'first' }]);
        }
        finally {
            unchanged.close();
        }
    });

    it('rejects an existing database that does not contain the required store', async () => {
        const factory = new FakeIndexedDb.IDBFactory();
        vi.stubGlobal('indexedDB', factory);
        const seed = await openIndexedDbWithStore('concurrent-schema', {
            name: 'seed',
            keyPath: 'id'
        });
        const initialVersion = seed.version;
        seed.close();

        await expect(openIndexedDbWithStore('concurrent-schema', {
            name: 'required',
            keyPath: 'id'
        })).rejects.toThrow('IndexedDB database does not contain required store "required"');

        const database = await readRequest(factory.open('concurrent-schema'));
        expect(database.version).toBe(initialVersion);
        expect([...database.objectStoreNames]).toEqual(['seed']);
        database.close();
    });

    it('shares one open attempt and permits a fresh attempt after failure', async () => {
        vi.stubGlobal('indexedDB', new FakeIndexedDb.IDBFactory());
        let attempts = 0;
        const connection = new IndexedDbConnection(async () => {
            attempts += 1;
            if (attempts === 1) {
                throw new Error('opening failed');
            }
            return await openIndexedDbWithStore('connection-retry', {
                name: 'items',
                keyPath: 'id'
            });
        });

        await expect(connection.get()).rejects.toThrow('opening failed');
        const [first, second] = await Promise.all([
            connection.get(),
            connection.get()
        ]);

        expect(first).toBe(second);
        expect(attempts).toBe(2);
        first.close();
    });
});

function observeSchemaWrites(): SchemaWriteObservation[] {
    const writes: SchemaWriteObservation[] = [];
    const createStore = FakeIndexedDb.IDBDatabase.prototype.createObjectStore;
    const createIndex = FakeIndexedDb.IDBObjectStore.prototype.createIndex;
    vi.spyOn(FakeIndexedDb.IDBDatabase.prototype, 'createObjectStore').mockImplementation(function (this: IDBDatabase, name, options) {
        const store = createStore.call(this, name, options);
        writes.push({
            kind: 'store',
            name,
            transactionMode: store.transaction.mode
        });
        return store;
    });
    vi.spyOn(FakeIndexedDb.IDBObjectStore.prototype, 'createIndex').mockImplementation(function (this: IDBObjectStore, name, keyPath, options) {
        const index = createIndex.call(this, name, keyPath, options);
        writes.push({
            kind: 'index',
            name,
            transactionMode: this.transaction.mode
        });
        return index;
    });
    return writes;
}

async function waitForTransaction(transaction: IDBTransaction): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
    });
}

async function readRequest<T>(request: IDBRequest<T>): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
