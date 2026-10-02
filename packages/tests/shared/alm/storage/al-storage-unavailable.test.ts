import * as FakeIndexedDb from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import {
    AL_ADMISSION_SCHEMA_ID,
    ALStorageResetBlockedError,
    openIndexedDbAdmissionDatabase
} from '@shared/alm/open-indexed-db-admission-database.ts';
import {
    ALStorageUnavailableError,
    toALStorageUnavailable
} from '@shared/alm/storage/al-storage-unavailable.ts';
import { readIndexedDbRequest } from '@shared/persistence/indexed-db-request.ts';
import { PersistenceWriteExpiredError } from '@shared/persistence/persistence-write-deadline.ts';
import { IndexedDbQueueWriteConflictError } from '@shared/queuebox/indexed-db-queue-write-conflict-error.ts';
import { toError } from '@shared/resilience/to-error.ts';

const STORE_NAME = 'entries';

describe('toALStorageUnavailable', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('reads missing when the admission database is opened without IndexedDB', async () => {
        vi.stubGlobal('indexedDB', undefined);

        const error = await readOpenFailure(`al-storage-missing-${crypto.randomUUID()}`);

        expect(error).toBeInstanceOf(ALStorageUnavailableError);
        expect(toALStorageUnavailable(error)).toEqual({
            cause: 'missing',
            detail: 'IndexedDB is not available in this environment'
        });
    });

    // The open request itself fails: a VersionError from asking for an older version than the stored one.
    it('reads open-failed when the open request of the admission database fails', async () => {
        const factory = new FakeIndexedDb.IDBFactory();
        vi.stubGlobal('indexedDB', factory);
        const dbName = `al-storage-open-failed-${crypto.randomUUID()}`;
        await createDatabaseAtVersion(factory, dbName, 2);
        const open = factory.open.bind(factory);
        vi.spyOn(factory, 'open').mockImplementation((name: string) => open(name, 1));

        const error = await readOpenFailure(dbName);

        expect(error).toMatchObject({
            name: 'ALStorageUnavailableError',
            cause: { name: 'VersionError' }
        });
        expect(toALStorageUnavailable(error)).toEqual({
            cause: 'open-failed',
            detail: expect.stringMatching(
                new RegExp(`^IndexedDB open of "${dbName}" failed: VersionError: `)
            )
        });
    });

    // The delete that stays blocked is pinned against the real database in browser-al-storage-reset.test.ts;
    // it waits the 5 s timeout in real time, so the classification reads a constructed error.
    it('reads reset-blocked from the blocked reset error', () => {
        const error = new ALStorageResetBlockedError('al-runtime');

        expect(error.name).toBe('ALStorageResetBlockedError');
        expect(toALStorageUnavailable(error)).toEqual({
            cause: 'reset-blocked',
            detail: 'IndexedDB database "al-runtime" delete is blocked by an open connection'
        });
    });

    // fake-indexeddb has no storage quota, so the classification reads a constructed DOMException.
    it('reads quota from a QuotaExceededError', () => {
        expect(
            toALStorageUnavailable(
                new DOMException('The quota has been exceeded.', 'QuotaExceededError')
            )
        )
            .toEqual({
                cause: 'quota',
                detail: 'QuotaExceededError: The quota has been exceeded.'
            });
    });

    it('reads closed when a transaction starts on a connection that was closed', async () => {
        vi.stubGlobal('indexedDB', new FakeIndexedDb.IDBFactory());
        const db = await openIndexedDbAdmissionDatabase({
            dbName: `al-storage-closed-${crypto.randomUUID()}`,
            storeName: STORE_NAME,
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: () => {}
        });
        db.close();

        const error = readThrown(() => db.transaction(STORE_NAME, 'readonly'));

        expect(toALStorageUnavailable(error)).toEqual({
            cause: 'closed',
            detail: expect.stringMatching(/^InvalidStateError: /)
        });
    });

    // The database vanishing under an open document is detected on reopen, which raises this error.
    it('reads evicted from the error that carries it', () => {
        const error = new ALStorageUnavailableError({
            cause: 'evicted',
            detail: 'al-runtime was recreated'
        });

        expect(toALStorageUnavailable(error)).toEqual({
            cause: 'evicted',
            detail: 'al-runtime was recreated'
        });
    });

    it('reads transaction-failed from a request the abort of its transaction failed', async () => {
        vi.stubGlobal('indexedDB', new FakeIndexedDb.IDBFactory());
        const db = await openIndexedDbAdmissionDatabase({
            dbName: `al-storage-aborted-${crypto.randomUUID()}`,
            storeName: STORE_NAME,
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: () => {}
        });
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const written = readIndexedDbRequest(
            transaction.objectStore(STORE_NAME).put({
                key: 'row',
                value: '1',
                expireAtTimestamp: 0
            })
        );
        transaction.abort();

        const error = await written.then(() => undefined, toError);
        db.close();

        expect(error?.name).toBe('AbortError');
        expect(toALStorageUnavailable(error!)).toEqual({
            cause: 'transaction-failed',
            detail: expect.stringMatching(/^AbortError: /)
        });
    });

    // fake-indexeddb raises no UnknownError, so the classification reads a constructed DOMException.
    it('reads transaction-failed from an UnknownError', () => {
        expect(toALStorageUnavailable(new DOMException('Internal error.', 'UnknownError')))
            .toEqual({ cause: 'transaction-failed', detail: 'UnknownError: Internal error.' });
    });

    it('leaves a write deadline, a corrupt row, a conflict and a code defect unclassified', async () => {
        vi.stubGlobal('indexedDB', new FakeIndexedDb.IDBFactory());
        const constraint = await readConstraintError(
            `al-storage-constraint-${crypto.randomUUID()}`
        );

        expect(constraint.name).toBe('ConstraintError');
        for (
            const error of [
                new PersistenceWriteExpiredError(),
                new ALAdmissionCorruptionError('row', new Error('bad row')),
                new ALAdmissionBackendConflictError('moved'),
                new IndexedDbQueueWriteConflictError('moved'),
                constraint,
                new DOMException('Bad key.', 'DataError'),
                new Error('IndexedDB transaction failed')
            ]
        ) {
            expect(toALStorageUnavailable(error)).toBeUndefined();
        }
    });
});

async function readOpenFailure(dbName: string): Promise<Error> {
    return await openIndexedDbAdmissionDatabase({
        dbName,
        storeName: STORE_NAME,
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {}
    }).then(
        (db) => {
            db.close();
            throw new Error('the open was expected to fail');
        },
        toError
    );
}

async function createDatabaseAtVersion(
    factory: IDBFactory,
    dbName: string,
    version: number
): Promise<void> {
    const request = factory.open(dbName, version);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
    (await readIndexedDbRequest(request)).close();
}

function readThrown(run: () => void): Error {
    try {
        run();
    }
    catch (error) {
        return toError(error);
    }
    throw new Error('the call was expected to throw');
}

async function readConstraintError(dbName: string): Promise<Error> {
    const db = await openIndexedDbAdmissionDatabase({
        dbName,
        storeName: STORE_NAME,
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {}
    });
    const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
    store.add({ key: 'row', value: '1', expireAtTimestamp: 0 });
    const error = await readIndexedDbRequest(
        store.add({ key: 'row', value: '2', expireAtTimestamp: 0 })
    )
        .then(() => new Error('the second add was expected to fail'), toError);
    db.close();
    return error;
}
