import * as FakeIndexedDb from 'fake-indexeddb';
// dprint-ignore
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { openIndexedDbWithStore, openIndexedDbWithStores } from '@shared/persistence/openIndexedDb.ts';

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

        const stores = [{
            name: 'items',
            keyPath: 'id',
            indexes: [{ name: 'by-group', keyPath: ['groupId', 'position'], unique: true }]
        }];
        const upgraded = await openIndexedDbWithStores('schema-replacement', stores);
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
        const unchanged = await openIndexedDbWithStores('schema-replacement', stores);
        expect(unchanged.version).toBe(initialVersion + 1);
        unchanged.close();
    });

    it('rolls back a rejected unique-index upgrade, including a preceding store creation', async () => {
        vi.stubGlobal('indexedDB', new FakeIndexedDb.IDBFactory());
        const initial = await openIndexedDbWithStore('schema-rollback', { name: 'items', keyPath: 'id' });
        const seed = initial.transaction('items', 'readwrite');
        seed.objectStore('items').put({ id: 'one', reference: 'duplicate' });
        seed.objectStore('items').put({ id: 'two', reference: 'duplicate' });
        await waitForTransaction(seed);
        const initialVersion = initial.version;
        initial.close();

        await expect(openIndexedDbWithStores('schema-rollback', [
            { name: 'audit', keyPath: 'id' },
            { name: 'items', keyPath: 'id', indexes: [{ name: 'by-reference', keyPath: 'reference', unique: true }] }
        ])).rejects.toMatchObject({ name: 'AbortError' });

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
