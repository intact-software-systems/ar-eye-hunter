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

describe('IndexedDB schema upgrades', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it.each(['creation', 'upgrade'])('applies the complete schema in the %s versionchange transaction', async (operation) => {
        const factory = new FakeIndexedDb.IDBFactory();
        vi.stubGlobal('indexedDB', factory);
        if (operation === 'upgrade') {
            const previous = await openIndexedDbWithStore('schema-options', { name: 'previous', keyPath: 'id' });
            previous.close();
        }
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

    it('replaces mismatched indexes without losing stored records and keeps a matching schema version', async () => {
        vi.stubGlobal('indexedDB', new FakeIndexedDb.IDBFactory());
        const initial = await openIndexedDbWithStore('schema-replacement', {
            name: 'items',
            keyPath: 'id',
            indexes: [{ name: 'by-group', keyPath: 'legacy', unique: false }]
        });
        const seed = initial.transaction('items', 'readwrite');
        seed.objectStore('items').put({ id: 'one', legacy: 'old', groupId: 'group', position: 1 });
        await waitForTransaction(seed);
        const initialVersion = initial.version;
        initial.close();

        const store = {
            name: 'items',
            keyPath: 'id',
            indexes: [{ name: 'by-group', keyPath: ['groupId', 'position'], unique: true }]
        };
        const upgraded = await openIndexedDbWithStore('schema-replacement', store);
        try {
            expect(upgraded.version).toBe(initialVersion + 1);
            const index = upgraded.transaction('items').objectStore('items').index('by-group');
            expect(index.keyPath).toEqual(['groupId', 'position']);
            expect(index.unique).toBe(true);
            expect(await readRequest(index.get(['group', 1]))).toEqual({
                id: 'one',
                legacy: 'old',
                groupId: 'group',
                position: 1
            });
        }
        finally {
            upgraded.close();
        }
        const unchanged = await openIndexedDbWithStore('schema-replacement', store);
        expect(unchanged.version).toBe(initialVersion + 1);
        unchanged.close();
    });

    it('rejects an existing store whose key path belongs to another schema', async () => {
        vi.stubGlobal('indexedDB', new FakeIndexedDb.IDBFactory());
        const initial = await openIndexedDbWithStore('schema-key-path', {
            name: 'items',
            keyPath: 'legacyId'
        });
        const initialVersion = initial.version;
        initial.close();

        await expect(openIndexedDbWithStore('schema-key-path', {
            name: 'items',
            keyPath: 'id'
        })).rejects.toThrow('IndexedDB store "items" has key path "legacyId"; expected "id"');

        const unchanged = await openIndexedDbWithStore('schema-key-path', {
            name: 'items',
            keyPath: 'legacyId'
        });
        expect(unchanged.version).toBe(initialVersion);
        unchanged.close();
    });

    it('rolls back a rejected unique-index upgrade', async () => {
        vi.stubGlobal('indexedDB', new FakeIndexedDb.IDBFactory());
        const initial = await openIndexedDbWithStore('schema-rollback', { name: 'items', keyPath: 'id' });
        const seed = initial.transaction('items', 'readwrite');
        seed.objectStore('items').put({ id: 'one', reference: 'duplicate' });
        seed.objectStore('items').put({ id: 'two', reference: 'duplicate' });
        await waitForTransaction(seed);
        const initialVersion = initial.version;
        initial.close();

        await expect(openIndexedDbWithStore('schema-rollback', {
            name: 'items',
            keyPath: 'id',
            indexes: [{ name: 'by-reference', keyPath: 'reference', unique: true }]
        })).rejects.toMatchObject({ name: 'AbortError' });

        const unchanged = await openIndexedDbWithStore('schema-rollback', { name: 'items', keyPath: 'id' });
        try {
            expect(unchanged.version).toBe(initialVersion);
            expect([...unchanged.objectStoreNames]).toEqual(['items']);
            const items = unchanged.transaction('items').objectStore('items');
            expect([...items.indexNames]).toEqual([]);
            expect(await readRequest(items.getAll())).toEqual([
                { id: 'one', reference: 'duplicate' },
                { id: 'two', reference: 'duplicate' }
            ]);
        }
        finally {
            unchanged.close();
        }
    });

    it('serializes concurrent upgrades for distinct stores in one database', async () => {
        const factory = new FakeIndexedDb.IDBFactory();
        vi.stubGlobal('indexedDB', factory);
        const seed = await openIndexedDbWithStore('concurrent-schema', {
            name: 'seed',
            keyPath: 'id'
        });
        seed.close();

        const [first, second] = await Promise.all([
            openIndexedDbWithStore('concurrent-schema', { name: 'first', keyPath: 'id' }),
            openIndexedDbWithStore('concurrent-schema', { name: 'second', keyPath: 'id' })
        ]);
        first.close();
        second.close();

        const database = await readRequest(factory.open('concurrent-schema'));
        expect([...database.objectStoreNames]).toEqual(['first', 'second', 'seed']);
        database.close();
    });

    it('keeps a blocked upgrade pending and closes cleanly after the blocker releases', async () => {
        const factory = new FakeIndexedDb.IDBFactory();
        vi.stubGlobal('indexedDB', factory);
        const blocker = await openUncooperativeDatabase(factory, 'blocked-schema');
        let settled = false;
        const opening = openIndexedDbWithStore('blocked-schema', {
            name: 'replacement',
            keyPath: 'id'
        }).finally(() => {
            settled = true;
        });

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(settled).toBe(false);
        blocker.close();
        const upgraded = await opening;
        upgraded.close();

        await expect(deleteDatabase(factory, 'blocked-schema')).resolves.toBeUndefined();
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

async function openUncooperativeDatabase(
    factory: IDBFactory,
    name: string
): Promise<IDBDatabase> {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('seed', { keyPath: 'id' });
    return await readRequest(request);
}

async function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const request = factory.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error('IndexedDB deletion failed'));
        request.onblocked = () => reject(new Error('IndexedDB deletion remained blocked'));
    });
}

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
