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
    readIndexedDbRequest,
    readIndexedDbTransaction
} from '@shared/persistence/indexed-db-request.ts';
import {
    IndexedDbConnection,
    openIndexedDbWithStores
} from '@shared/persistence/open-indexed-db.ts';

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

    it('creates and reopens one fixed database with several stores and their initial records', async () => {
        const factory = new FakeIndexedDb.IDBFactory();
        vi.stubGlobal('indexedDB', factory);
        const definitions = [
            { name: 'admission', keyPath: 'id', initialRecords: [{ id: 'revision', value: 0 }] },
            { name: 'work', keyPath: 'id', indexes: [{ name: 'due', keyPath: 'dueAt' }] }
        ];
        const created = await openIndexedDbWithStores('atomic-schema', definitions);
        expect([...created.objectStoreNames]).toEqual(['admission', 'work']);
        expect(await readRequest(created.transaction('admission').objectStore('admission').get('revision')))
            .toEqual({ id: 'revision', value: 0 });
        created.close();
        const reopened = await openIndexedDbWithStores('atomic-schema', [...definitions].reverse());
        expect(reopened.transaction('work').objectStore('work').index('due').keyPath).toBe('dueAt');
        reopened.close();
    });

    it('rejects adding a store to an existing database without changing that database', async () => {
        const factory = new FakeIndexedDb.IDBFactory();
        vi.stubGlobal('indexedDB', factory);
        const existing = await openIndexedDbWithStores('single-store-schema', [{
            name: 'admission',
            keyPath: 'id',
            initialRecords: [{ id: 'accepted' }]
        }]);
        const version = existing.version;
        existing.close();
        await expect(openIndexedDbWithStores('single-store-schema', [
            { name: 'admission', keyPath: 'id' },
            { name: 'work', keyPath: 'id' }
        ])).rejects.toThrow('stores do not match');
        const unchanged = await readRequest(factory.open('single-store-schema'));
        expect(unchanged.version).toBe(version);
        expect([...unchanged.objectStoreNames]).toEqual(['admission']);
        expect(await readRequest(unchanged.transaction('admission').objectStore('admission').get('accepted')))
            .toEqual({ id: 'accepted' });
        unchanged.close();
    });

    it('rejects duplicate store definitions before opening IndexedDB', async () => {
        const factory = new FakeIndexedDb.IDBFactory();
        vi.stubGlobal('indexedDB', factory);
        const open = vi.spyOn(factory, 'open');
        await expect(openIndexedDbWithStores('duplicate-schema', [
            { name: 'work', keyPath: 'id' },
            { name: 'work', keyPath: 'anotherId' }
        ])).rejects.toThrow('distinct store names');
        expect(open).not.toHaveBeenCalled();
    });

    it('rolls back every store when initial records violate an index constraint', async () => {
        vi.stubGlobal('indexedDB', new FakeIndexedDb.IDBFactory());
        await expect(openIndexedDbWithStores('aborted-schema', [
            { name: 'admission', keyPath: 'id', initialRecords: [{ id: 'uncommitted' }] },
            {
                name: 'work',
                keyPath: 'id',
                indexes: [{ name: 'unique-resource', keyPath: 'resource', unique: true }],
                initialRecords: [{ id: 'one', resource: 'same' }, { id: 'two', resource: 'same' }]
            }
        ])).rejects.toMatchObject({ name: 'AbortError' });
        const fresh = await openIndexedDbWithStores('aborted-schema', [
            { name: 'admission', keyPath: 'id' },
            { name: 'work', keyPath: 'id' }
        ]);
        expect(await readRequest(fresh.transaction('admission').objectStore('admission').getAll())).toEqual([]);
        expect(await readRequest(fresh.transaction('work').objectStore('work').getAll())).toEqual([]);
        fresh.close();
    });

    it('reports synchronous schema-write failure through the open promise and rolls back every store', async () => {
        vi.stubGlobal('indexedDB', new FakeIndexedDb.IDBFactory());
        await expect(openIndexedDbWithStores('uncloneable-initial-record', [
            { name: 'admission', keyPath: 'id', initialRecords: [{ id: 'uncommitted' }] },
            { name: 'work', keyPath: 'id', initialRecords: [{ id: 'invalid', callback: () => true }] }
        ])).rejects.toMatchObject({ name: 'DataCloneError' });
        const fresh = await openIndexedDbWithStores('uncloneable-initial-record', [
            { name: 'admission', keyPath: 'id' },
            { name: 'work', keyPath: 'id' }
        ]);
        expect(await readRequest(fresh.transaction('admission').objectStore('admission').getAll())).toEqual([]);
        fresh.close();
    });

    it('creates the complete schema in the initial versionchange transaction', async () => {
        const factory = new FakeIndexedDb.IDBFactory();
        vi.stubGlobal('indexedDB', factory);
        const writes = observeSchemaWrites();

        const database = await openIndexedDbWithStores('schema-options', [{
            name: 'items',
            keyPath: 'id',
            indexes: [
                { name: 'by-group', keyPath: ['groupId', 'position'] },
                { name: 'by-reference', keyPath: 'reference', unique: true }
            ]
        }]);
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
        const initial = await openIndexedDbWithStores('schema-replacement', [{
            name: 'items',
            keyPath: 'id',
            indexes: [{ name: 'by-group', keyPath: 'groupId', unique: false }]
        }]);
        const seed = initial.transaction('items', 'readwrite');
        seed.objectStore('items').put({ id: 'one', groupId: 'group', position: 1 });
        await waitForTransaction(seed);
        const initialVersion = initial.version;
        initial.close();

        await expect(openIndexedDbWithStores('schema-replacement', [{
            name: 'items',
            keyPath: 'id',
            indexes: [{ name: 'by-group', keyPath: ['groupId', 'position'], unique: true }]
        }])).rejects.toThrow('IndexedDB indexes for "items" do not match their required schema');

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
        const initial = await openIndexedDbWithStores('schema-key-path', [{
            name: 'items',
            keyPath: 'otherId'
        }]);
        const initialVersion = initial.version;
        initial.close();

        await expect(openIndexedDbWithStores('schema-key-path', [{
            name: 'items',
            keyPath: 'id'
        }])).rejects.toThrow('IndexedDB store "items" has key path "otherId"; expected "id"');

        const unchanged = await openIndexedDbWithStores('schema-key-path', [{
            name: 'items',
            keyPath: 'otherId'
        }]);
        expect(unchanged.version).toBe(initialVersion);
        unchanged.close();
    });

    it('rejects an existing store missing a required index without changing stored records', async () => {
        const factory = new FakeIndexedDb.IDBFactory();
        vi.stubGlobal('indexedDB', factory);
        const initial = await openIndexedDbWithStores('schema-rollback', [{ name: 'items', keyPath: 'id' }]);
        const seed = initial.transaction('items', 'readwrite');
        seed.objectStore('items').put({ id: 'one', reference: 'first' });
        await waitForTransaction(seed);
        const initialVersion = initial.version;
        initial.close();

        await expect(openIndexedDbWithStores('schema-rollback', [{
            name: 'items',
            keyPath: 'id',
            indexes: [{ name: 'by-reference', keyPath: 'reference', unique: true }]
        }])).rejects.toThrow('IndexedDB indexes for "items" do not match their required schema');

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

    it('rejects a surplus store instead of accepting another schema', async () => {
        const factory = new FakeIndexedDb.IDBFactory();
        vi.stubGlobal('indexedDB', factory);
        const request = factory.open('surplus-schema');
        request.onupgradeneeded = () => {
            const items = request.result.createObjectStore('items', { keyPath: 'id' });
            items.createIndex('required', 'required');
            items.createIndex('surplus', 'surplus');
            request.result.createObjectStore('surplus-store', { keyPath: 'id' });
        };
        const existing = await readRequest(request);
        existing.close();

        await expect(openIndexedDbWithStores('surplus-schema', [{
            name: 'items',
            keyPath: 'id',
            indexes: [{ name: 'required', keyPath: 'required' }]
        }])).rejects.toThrow('IndexedDB database stores do not match the required schema');
    });

    it('rejects a surplus index instead of accepting different write constraints', async () => {
        const factory = new FakeIndexedDb.IDBFactory();
        vi.stubGlobal('indexedDB', factory);
        const request = factory.open('surplus-index');
        request.onupgradeneeded = () => {
            const items = request.result.createObjectStore('items', { keyPath: 'id' });
            items.createIndex('required', 'required');
            items.createIndex('surplus', 'surplus', { unique: true });
        };
        const existing = await readRequest(request);
        existing.close();

        await expect(openIndexedDbWithStores('surplus-index', [{
            name: 'items',
            keyPath: 'id',
            indexes: [{ name: 'required', keyPath: 'required' }]
        }])).rejects.toThrow('IndexedDB indexes for "items" do not match their required schema');
    });

    it('rejects auto-increment metadata absent from the current schema', async () => {
        const factory = new FakeIndexedDb.IDBFactory();
        vi.stubGlobal('indexedDB', factory);
        const request = factory.open('auto-increment-metadata');
        request.onupgradeneeded = () => {
            request.result.createObjectStore('items', {
                keyPath: 'id',
                autoIncrement: true
            });
        };
        const existing = await readRequest(request);
        existing.close();

        await expect(openIndexedDbWithStores('auto-increment-metadata', [{
            name: 'items',
            keyPath: 'id'
        }])).rejects.toThrow('IndexedDB store "items" auto-increment does not match its required schema');
    });

    it('rejects multi-entry index metadata absent from the current schema', async () => {
        const factory = new FakeIndexedDb.IDBFactory();
        vi.stubGlobal('indexedDB', factory);
        const request = factory.open('multi-entry-metadata');
        request.onupgradeneeded = () => {
            const items = request.result.createObjectStore('items', { keyPath: 'id' });
            items.createIndex('tags', 'tags', { multiEntry: true });
        };
        const existing = await readRequest(request);
        existing.close();

        await expect(openIndexedDbWithStores('multi-entry-metadata', [{
            name: 'items',
            keyPath: 'id',
            indexes: [{ name: 'tags', keyPath: 'tags' }]
        }])).rejects.toThrow('IndexedDB indexes for "items" do not match their required schema');
    });

    it('rejects an existing database that does not contain the required store', async () => {
        const factory = new FakeIndexedDb.IDBFactory();
        vi.stubGlobal('indexedDB', factory);
        const seed = await openIndexedDbWithStores('concurrent-schema', [{
            name: 'seed',
            keyPath: 'id'
        }]);
        const initialVersion = seed.version;
        seed.close();

        await expect(openIndexedDbWithStores('concurrent-schema', [{
            name: 'required',
            keyPath: 'id'
        }])).rejects.toThrow('IndexedDB database stores do not match the required schema');

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
            return await openIndexedDbWithStores('connection-retry', [{
                name: 'items',
                keyPath: 'id'
            }]);
        });

        await expect(connection.open()).rejects.toThrow('opening failed');
        const [first, second] = await Promise.all([
            connection.open(),
            connection.open()
        ]);

        expect(first).toBe(second);
        expect(attempts).toBe(2);
        first.close();
    });

    it('observes both the request failure and the resulting transaction abort', async () => {
        const factory = new FakeIndexedDb.IDBFactory();
        vi.stubGlobal('indexedDB', factory);
        const database = await openIndexedDbWithStores('request-and-transaction-failure', [{
            name: 'items',
            keyPath: 'id',
            initialRecords: [{ id: 'duplicate' }]
        }]);
        const transaction = database.transaction('items', 'readwrite');
        const duplicate = transaction.objectStore('items').add({ id: 'duplicate' });

        await expect(readIndexedDbTransaction(
            transaction,
            () => readIndexedDbRequest(duplicate)
        )).rejects.toMatchObject({ name: 'ConstraintError' });

        expect(transaction.error).toMatchObject({ name: 'ConstraintError' });
        database.close();
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
