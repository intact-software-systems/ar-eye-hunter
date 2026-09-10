import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';

import {
    AL_ADMISSION_SCHEMA_ID,
    AL_ADMISSION_SCHEMA_KEY,
    AL_ADMISSION_WORK_STORE_NAME,
    openIndexedDbAdmissionDatabase,
    type ALStorageResetEvent
} from '@shared/alm/open-indexed-db-admission-database.ts';

const STORE_NAME = 'entries';

describe('browser ALM storage schema identity reset', () => {
    it('resets the database when its stored schema id no longer matches', async () => {
        const dbName = `al-storage-reset-schema-id-${crypto.randomUUID()}`;
        const oldDb = await openIndexedDbAdmissionDatabase({
            dbName,
            storeName: STORE_NAME,
            schemaId: 'old',
            onStorageReset: assertNoStorageReset
        });
        await putRow(oldDb, { key: 'version:old-row', value: '1', expireAtTimestamp: Number.MAX_SAFE_INTEGER });
        oldDb.close();

        const events: ALStorageResetEvent[] = [];
        const db = await openIndexedDbAdmissionDatabase({
            dbName,
            storeName: STORE_NAME,
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: (event) => events.push(event)
        });
        try {
            expect(events).toEqual([{
                dbName,
                previousSchemaId: 'old',
                schemaId: AL_ADMISSION_SCHEMA_ID,
                reason: 'schema-id-mismatch'
            }]);
            expect(await getRow(db, 'version:old-row')).toBeUndefined();
            expect(await getRow(db, AL_ADMISSION_SCHEMA_KEY)).toMatchObject({
                key: AL_ADMISSION_SCHEMA_KEY,
                value: AL_ADMISSION_SCHEMA_ID
            });
        }
        finally {
            db.close();
        }
    });

    it('resets a database created with a different store set', async () => {
        const dbName = `al-storage-reset-store-schema-${crypto.randomUUID()}`;
        const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(dbName);
            request.onupgradeneeded = () => {
                request.result.createObjectStore('legacy', { keyPath: 'id' });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
        });
        legacy.close();

        const events: ALStorageResetEvent[] = [];
        const db = await openIndexedDbAdmissionDatabase({
            dbName,
            storeName: STORE_NAME,
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: (event) => events.push(event)
        });
        try {
            expect(events).toEqual([{
                dbName,
                previousSchemaId: undefined,
                schemaId: AL_ADMISSION_SCHEMA_ID,
                reason: 'store-schema-mismatch'
            }]);
            expect([...db.objectStoreNames].sort()).toEqual([AL_ADMISSION_WORK_STORE_NAME, STORE_NAME].sort());
        }
        finally {
            db.close();
        }
    });
});

function assertNoStorageReset(): never {
    throw new Error('Unexpected AL storage reset');
}

function putRow(db: IDBDatabase, row: object): Promise<void> {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).put(row);
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB write aborted'));
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB write failed'));
    });
}

function getRow(db: IDBDatabase, key: string): Promise<IDBRequest['result']> {
    return new Promise((resolve, reject) => {
        const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'));
    });
}
