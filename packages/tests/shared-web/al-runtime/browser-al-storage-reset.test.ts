import 'fake-indexeddb/auto';
import {
    describe,
    expect,
    it
} from 'vitest';

import {
    AL_ADMISSION_SCHEMA_ID,
    AL_ADMISSION_SCHEMA_KEY,
    ALStorageSchemaMismatchError,
    openIndexedDbAdmissionDatabase,
    openIndexedDbAdmissionStorage,
    type ALStorageResetEvent,
    type OpenIndexedDbAdmissionDatabaseInput
} from '@shared/alm/open-indexed-db-admission-database.ts';
import { readIndexedDbRequest } from '@shared/persistence/indexed-db-request.ts';

const STORE_NAME = 'entries';

function createDefaultAdmissionStorageInput(dbName: string, events: ALStorageResetEvent[]): OpenIndexedDbAdmissionDatabaseInput {
    return { dbName, storeName: STORE_NAME, schemaId: AL_ADMISSION_SCHEMA_ID, onStorageReset: (event: ALStorageResetEvent) => events.push(event) };
}

describe('browser ALM observed storage lifecycle', () => {
    it('creates absent storage and reopens current storage without a reset event', async () => {
        const events: ALStorageResetEvent[] = [];
        const input = createDefaultAdmissionStorageInput(`al-created-${crypto.randomUUID()}`, events);
        const first = await openIndexedDbAdmissionStorage(input);
        expect(first.opening).toEqual({ kind: 'created' });
        first.db.close();
        const second = await openIndexedDbAdmissionStorage(input);
        expect(second.opening).toEqual({ kind: 'existing' });
        expect(events).toEqual([]);
        second.db.close();
    });

    it('observes an independent external deletion after versionchange and reports recreation', async () => {
        const events: ALStorageResetEvent[] = [];
        const input = createDefaultAdmissionStorageInput(`al-external-reset-${crypto.randomUUID()}`, events);
        const first = await openIndexedDbAdmissionStorage(input);
        await readIndexedDbRequest(indexedDB.deleteDatabase(input.dbName));
        expect(() => first.db.transaction(STORE_NAME)).toThrow();
        const recreated = await openIndexedDbAdmissionStorage(input);
        expect(recreated.opening).toEqual({ kind: 'reset', reason: 'other-context' });
        expect(events).toEqual([{ dbName: input.dbName, previousSchemaId: undefined, schemaId: AL_ADMISSION_SCHEMA_ID, reason: 'other-context' }]);
        expect(await readIndexedDbRequest(recreated.db.transaction(STORE_NAME).objectStore(STORE_NAME).get(AL_ADMISSION_SCHEMA_KEY)))
            .toMatchObject({ value: 'rallar-alm-2026-10-roster-fence' });
        recreated.db.close();
    });

    it('observes eviction without versionchange without claiming a schema reset', async () => {
        const events: ALStorageResetEvent[] = [];
        const input = createDefaultAdmissionStorageInput(`al-external-eviction-${crypto.randomUUID()}`, events);
        (await openIndexedDbAdmissionDatabase(input)).close();
        await readIndexedDbRequest(indexedDB.deleteDatabase(input.dbName));
        const recreated = await openIndexedDbAdmissionStorage(input);
        expect(recreated.opening).toEqual({ kind: 'evicted' });
        expect(events).toEqual([]);
        recreated.db.close();
    });

    it('refuses both concurrent incompatible opens while preserving the existing schema identity', async () => {
        const events: ALStorageResetEvent[] = [];
        const input = createDefaultAdmissionStorageInput(`al-concurrent-refusal-${crypto.randomUUID()}`, events);
        (await openIndexedDbAdmissionDatabase({ ...input, schemaId: 'older-schema' })).close();
        const outcomes = await Promise.allSettled([openIndexedDbAdmissionStorage(input), openIndexedDbAdmissionStorage(input)]);
        for (const result of outcomes) {
            expect(result.status).toBe('rejected');
            if (result.status === 'rejected') {
                expect(result.reason).toBeInstanceOf(ALStorageSchemaMismatchError);
            }
        }
        const db = await readIndexedDbRequest(indexedDB.open(input.dbName));
        expect(await readIndexedDbRequest(db.transaction(STORE_NAME).objectStore(STORE_NAME).get(AL_ADMISSION_SCHEMA_KEY)))
            .toMatchObject({ value: 'older-schema' });
        expect(events).toEqual([]);
        db.close();
    });
});
