import * as FakeIndexedDb from 'fake-indexeddb';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { deleteExpiredBrowserALRuntimeEntries } from '@shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts';
import {
    BROWSER_AL_RUNTIME_STORE_NAME,
    toBrowserALRuntimeDbName
} from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import {
    AL_ADMISSION_EXPIRY_INDEX_NAME,
    AL_ADMISSION_SCHEMA_ID,
    AL_ADMISSION_SCHEMA_KEY,
    AL_ADMISSION_WORK_STORE_NAME,
    openIndexedDbAdmissionDatabase
} from '@shared/alm/open-indexed-db-admission-database.ts';
import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { readIndexedDbRequest, readIndexedDbTransaction } from '@shared/persistence/indexed-db-request.ts';

const LIVE_ROW = { key: 'other-session:live', value: 'retained', expireAtTimestamp: 10_000, writeToken: 'live-token', revision: 1 };
const LIVE_WORK = { keyString: 'other-session:work', resource: 'live work', expireAtTimestamp: 10_000 };

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('browser cleanup schema preservation', () => {
    it.each(['schema-id', 'store-schema', 'malformed-identity', 'missing-identity', 'unreadable-identity', 'unreadable-store-schema'] as const)(
        'refuses %s without deleting live rows or rewriting the database',
        async (failure) => {
            const factory = new FakeIndexedDb.IDBFactory();
            vi.stubGlobal('indexedDB', factory);
            vi.stubGlobal('IDBKeyRange', FakeIndexedDb.IDBKeyRange);
            const scope = { applicationId: 'preservation', workspaceId: crypto.randomUUID() };
            const dbName = toBrowserALRuntimeDbName(scope);
            await seedLiveDatabase(dbName, failure === 'schema-id' ? 'older-schema' : AL_ADMISSION_SCHEMA_ID);
            if (failure === 'store-schema') {
                const request = factory.open(dbName, 2);
                request.onupgradeneeded = () => {
                    request.transaction!.objectStore(BROWSER_AL_RUNTIME_STORE_NAME).deleteIndex(AL_ADMISSION_EXPIRY_INDEX_NAME);
                    request.result.createObjectStore('unrelated', { keyPath: 'key' }).put({ key: 'live', value: 'unselected' });
                };
                (await readIndexedDbRequest(request)).close();
            }
            if (failure === 'malformed-identity') {
                const db = await readIndexedDbRequest(factory.open(dbName));
                await writeRow(db, BROWSER_AL_RUNTIME_STORE_NAME, { key: AL_ADMISSION_SCHEMA_KEY, value: { malformed: true }, expireAtTimestamp: 10_000 });
                db.close();
            }
            if (failure === 'missing-identity') {
                const db = await readIndexedDbRequest(factory.open(dbName));
                const transaction = db.transaction(BROWSER_AL_RUNTIME_STORE_NAME, 'readwrite');
                transaction.objectStore(BROWSER_AL_RUNTIME_STORE_NAME).delete(AL_ADMISSION_SCHEMA_KEY);
                await readIndexedDbTransaction(transaction, async () => {});
                db.close();
            }
            const before = await readDatabase(factory, dbName);
            const handles: IDBDatabase[] = [];
            const open = factory.open.bind(factory);
            vi.spyOn(factory, 'open').mockImplementation((name: string) => {
                const request = open(name);
                request.addEventListener('success', () => handles.push(request.result));
                return request;
            });
            const readFailure = new Error('identity read failed');
            const transaction = FakeIndexedDb.IDBDatabase.prototype.transaction;
            if (failure.startsWith('unreadable')) {
                vi.spyOn(FakeIndexedDb.IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, stores, mode) {
                    if (this.name === dbName && mode === (failure === 'unreadable-store-schema' ? undefined : 'readonly')) {
                        throw readFailure;
                    }
                    return transaction.call(this, stores, mode);
                });
            }
            const events: ALStorageEvent[] = [];
            const result = await deleteExpiredBrowserALRuntimeEntries({ currentScope: scope, storage: (event) => events.push(event), nowMs: 100 })
                .then((value) => ({ value, error: undefined }), (error: Error) => ({ value: undefined, error }));
            vi.restoreAllMocks();
            expect(result.value).toBeUndefined();
            expect(result.error?.name).toBe(
                failure === 'unreadable-store-schema'
                    ? 'ALStorageUnavailableError'
                    : (failure === 'malformed-identity' || failure === 'unreadable-identity')
                    ? 'ALStorageSchemaIdentityError'
                    : 'ALStorageSchemaMismatchError'
            );
            if (failure.startsWith('unreadable')) {
                expect(result.error?.cause).toBe(readFailure);
            }
            expect(events).toEqual([]);
            expect(handles.length).toBeGreaterThan(0);
            for (const db of handles) {
                expect(() => db.transaction(BROWSER_AL_RUNTIME_STORE_NAME)).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
            }
            expect(await readDatabase(factory, dbName)).toEqual(before);
            expect(before.rows).toContainEqual(LIVE_ROW);
            expect(before.work).toEqual([LIVE_WORK]);
        }
    );

    it('creates a genuinely absent current-schema database', async () => {
        const factory = new FakeIndexedDb.IDBFactory();
        vi.stubGlobal('indexedDB', factory);
        vi.stubGlobal('IDBKeyRange', FakeIndexedDb.IDBKeyRange);
        const scope = { applicationId: 'preservation', workspaceId: crypto.randomUUID() };
        const result = await deleteExpiredBrowserALRuntimeEntries({ currentScope: scope, storage: () => {}, nowMs: 100 });
        expect(result.deleted).toBe(0);
        const db = await openIndexedDbAdmissionDatabase({
            dbName: toBrowserALRuntimeDbName(scope),
            storeName: BROWSER_AL_RUNTIME_STORE_NAME,
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: () => {}
        });
        expect(
            await readIndexedDbRequest(db.transaction(BROWSER_AL_RUNTIME_STORE_NAME).objectStore(BROWSER_AL_RUNTIME_STORE_NAME).get(AL_ADMISSION_SCHEMA_KEY))
        )
            .toMatchObject({ key: '__rallar_al_schema__', value: 'rallar-alm-2026-10-roster-fence' });
        db.close();
    });
});

interface DatabaseSnapshot {
    readonly version: number;
    readonly stores: readonly string[];
    readonly rows: readonly object[];
    readonly work: readonly object[];
    readonly unrelated: readonly object[];
}

async function seedLiveDatabase(dbName: string, schemaId: string): Promise<void> {
    const db = await openIndexedDbAdmissionDatabase({ dbName, storeName: BROWSER_AL_RUNTIME_STORE_NAME, schemaId, onStorageReset: () => {} });
    await writeRow(db, BROWSER_AL_RUNTIME_STORE_NAME, LIVE_ROW);
    await writeRow(db, AL_ADMISSION_WORK_STORE_NAME, LIVE_WORK);
    db.close();
}

async function writeRow(db: IDBDatabase, storeName: string, row: object): Promise<void> {
    const transaction = db.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).put(row);
    await readIndexedDbTransaction(transaction, async () => {});
}

async function readDatabase(factory: IDBFactory, dbName: string): Promise<DatabaseSnapshot> {
    const db = await readIndexedDbRequest(factory.open(dbName));
    try {
        const read = (store: string) => readIndexedDbRequest(db.transaction(store).objectStore(store).getAll());
        return {
            version: db.version,
            stores: [...db.objectStoreNames],
            rows: await read(BROWSER_AL_RUNTIME_STORE_NAME),
            work: await read(AL_ADMISSION_WORK_STORE_NAME),
            unrelated: db.objectStoreNames.contains('unrelated') ? await read('unrelated') : []
        };
    }
    finally {
        db.close();
    }
}
