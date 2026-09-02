import { readFileSync } from 'node:fs';

import * as FakeIndexedDb from 'fake-indexeddb';
import { ts } from 'ts-morph';
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
    readonly readyBeforeOpen: boolean;
    readonly transactionMode: IDBTransactionMode;
}

describe('IndexedDB schema upgrades', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it.each(['creation', 'upgrade'])('finishes DDL option records before %s opens a transaction', async (operation) => {
        const factory = new FakeIndexedDb.IDBFactory();
        vi.stubGlobal('indexedDB', factory);
        if (operation === 'upgrade') {
            const previous = await openIndexedDbWithStore('schema-options', { name: 'previous', keyPath: 'id' });
            previous.close();
        }
        const allocationsBeforeOpen = new WeakSet<object>();
        let openStarted = false;
        const nativeOpen = factory.open.bind(factory);
        vi.spyOn(factory, 'open').mockImplementation((...args) => {
            openStarted = true;
            return nativeOpen(...args);
        });
        const openObservedDatabase = createAllocationObservedOpener((value) => {
            if (!openStarted) {
                allocationsBeforeOpen.add(value);
            }
        });
        const writes = observeSchemaWrites(allocationsBeforeOpen);

        const database = await openObservedDatabase('schema-options', [{
            name: 'items',
            keyPath: 'id',
            indexes: [
                { name: 'by-group', keyPath: ['groupId', 'position'] },
                { name: 'by-reference', keyPath: 'reference', unique: true }
            ]
        }]);
        try {
            expect(writes).toEqual(expect.arrayContaining([
                { kind: 'store', name: 'items', readyBeforeOpen: true, transactionMode: 'versionchange' },
                { kind: 'index', name: 'by-group', readyBeforeOpen: true, transactionMode: 'versionchange' },
                { kind: 'index', name: 'by-reference', readyBeforeOpen: true, transactionMode: 'versionchange' }
            ]));
            expect(writes.filter((write) => !write.readyBeforeOpen || write.transactionMode !== 'versionchange')).toEqual([]);
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

function createAllocationObservedOpener(recordAllocation: (value: object) => void): typeof openIndexedDbWithStores {
    const source = readFileSync(new URL('../../shared/persistence/openIndexedDb.ts', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
        transformers: { before: [observeObjectAllocations] }
    });
    const exports: Partial<typeof import('@shared/persistence/openIndexedDb.ts')> = {};
    const evaluate = new Function('exports', 'recordAllocation', compiled.outputText);
    evaluate(exports, (value: object) => {
        recordAllocation(value);
        return value;
    });
    if (typeof exports.openIndexedDbWithStores !== 'function') {
        throw new TypeError('Instrumented IndexedDB module did not expose its opener');
    }
    return exports.openIndexedDbWithStores;
}

function observeObjectAllocations(context: ts.TransformationContext): ts.Transformer<ts.SourceFile> {
    const visit: ts.Visitor = (node) => {
        const visited = ts.visitEachChild(node, visit, context);
        return ts.isObjectLiteralExpression(visited)
            ? ts.factory.createCallExpression(ts.factory.createIdentifier('recordAllocation'), undefined, [visited])
            : visited;
    };
    return (source) => ts.visitEachChild(source, visit, context);
}

function observeSchemaWrites(allocationsBeforeOpen: WeakSet<object>): SchemaWriteObservation[] {
    const writes: SchemaWriteObservation[] = [];
    const createStore = FakeIndexedDb.IDBDatabase.prototype.createObjectStore;
    const createIndex = FakeIndexedDb.IDBObjectStore.prototype.createIndex;
    vi.spyOn(FakeIndexedDb.IDBDatabase.prototype, 'createObjectStore').mockImplementation(function (this: IDBDatabase, name, options) {
        const store = createStore.call(this, name, options);
        writes.push({
            kind: 'store',
            name,
            readyBeforeOpen: options !== undefined && allocationsBeforeOpen.has(options),
            transactionMode: store.transaction.mode
        });
        return store;
    });
    vi.spyOn(FakeIndexedDb.IDBObjectStore.prototype, 'createIndex').mockImplementation(function (this: IDBObjectStore, name, keyPath, options) {
        const index = createIndex.call(this, name, keyPath, options);
        writes.push({
            kind: 'index',
            name,
            readyBeforeOpen: options !== undefined && allocationsBeforeOpen.has(options),
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
