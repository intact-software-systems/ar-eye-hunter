// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend,
    PersistenceProviderAdmissionBackend,
    type ALAdmissionBackend
} from '@shared/alm/al-admission-backend.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import {
    AL_ADMISSION_EXPIRY_INDEX_NAME,
    AL_ADMISSION_REVISION_KEY,
    openIndexedDbAdmissionDatabase
} from '@shared/alm/open-indexed-db-admission-database.ts';
import { readIndexedDbAdmissionSnapshot } from '@shared/alm/read-indexed-db-admission-snapshot.ts';
import {
    computeIndexedDbAdmissionRevisionWrite,
    writeIndexedDbAdmissionMutations
} from '@shared/alm/write-indexed-db-admission-mutations.ts';
import { openIndexedDbWithStore } from '@shared/persistence/open-indexed-db.ts';
import { InMemoryPersistenceProvider } from '@shared/persistence/PersistenceProvider.ts';

import '../../setup-browser-indexeddb.ts';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

interface BackendCase {
    readonly name: string;
    readonly create: () => ALAdmissionBackend;
}

const backends: readonly BackendCase[] = [
    { name: 'memory', create: () => new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now) },
    {
        name: 'IndexedDB',
        create: () => new IndexedDbAdmissionBackend(`admission-decode-${crypto.randomUUID()}`, 'entries', Date.now)
    },
    {
        name: 'provider',
        create: () => new PersistenceProviderAdmissionBackend(new InMemoryPersistenceProvider(), crypto.randomUUID(), Date.now)
    }
];

describe.each(backends)('$name admission reads', ({ create }) => {
    it('decodes values at direct, listed, and transactional read boundaries', async () => {
        const backend = create();
        await backend.write(async (transaction) => {
            await transaction.set('version:peer-a', '7');
        });

        expect(await backend.read('version:peer-a', decodeVersion)).toBe(7);
        expect(await backend.list('version:', decodeVersion)).toEqual([{ key: 'version:peer-a', value: 7 }]);
        expect(
            await backend.write(async (transaction) => ({
                direct: await transaction.read('version:peer-a', decodeVersion),
                listed: await transaction.list('version:', decodeVersion)
            }))
        ).toEqual({ direct: 7, listed: [{ key: 'version:peer-a', value: 7 }] });
    });

    it('rejects corrupt values instead of returning a typed assertion or partial list', async () => {
        const backend = create();
        await backend.write(async (transaction) => {
            await transaction.set('version:good', '7');
            await transaction.set('version:bad', { invalid: true });
        });
        const corruption = { name: 'ALAdmissionCorruptionError', key: 'version:bad' };

        await expect(backend.read('version:bad', decodeVersion)).rejects.toMatchObject(corruption);
        await expect(backend.list('version:', decodeVersion)).rejects.toMatchObject(corruption);
        await expect(backend.write((transaction) => transaction.read('version:bad', decodeVersion)))
            .rejects.toMatchObject(corruption);
        await expect(backend.write((transaction) => transaction.list('version:', decodeVersion)))
            .rejects.toMatchObject(corruption);
    });

    it('does not commit writes made before a corrupt transactional read', async () => {
        const backend = create();
        await backend.write((transaction) => transaction.set('version:bad', false));

        await expect(backend.write(async (transaction) => {
            await transaction.set('version:new', '8');
            await transaction.read('version:bad', decodeVersion);
        })).rejects.toMatchObject({ name: 'ALAdmissionCorruptionError', key: 'version:bad' });

        expect(await backend.read('version:new', decodeVersion)).toBeUndefined();
        await backend.write((transaction) => transaction.set('version:recovered', '9'));
        expect(await backend.read('version:recovered', decodeVersion)).toBe(9);
    });

    it('reads pending replacements and removals rather than the shadowed stored value', async () => {
        const backend = create();
        await backend.write((tx) => tx.set('version:bad', false));
        await backend.write(async (tx) => {
            await tx.set('version:bad', '7');
            expect(await tx.read('version:bad', decodeVersion)).toBe(7);
            expect(await tx.list('version:', decodeVersion)).toEqual([{ key: 'version:bad', value: 7 }]);
            await tx.remove('version:bad');
            expect(await tx.read('version:bad', decodeVersion)).toBeUndefined();
            expect(await tx.list('version:', decodeVersion)).toEqual([]);
        });
        expect(await backend.read('version:bad', decodeVersion)).toBeUndefined();
    });
});

describe('admission storage envelopes', () => {
    it('rejects an existing store without the required revision metadata', async () => {
        const databaseName = `admission-missing-revision-${crypto.randomUUID()}`;
        const existing = await openIndexedDbWithStore(databaseName, {
            name: 'entries',
            keyPath: 'key',
            indexes: [{
                name: AL_ADMISSION_EXPIRY_INDEX_NAME,
                keyPath: 'expireAtTimestamp'
            }]
        });
        existing.close();

        const database = await openIndexedDbAdmissionDatabase(databaseName, 'entries');
        try {
            await expect(readIndexedDbAdmissionSnapshot(
                database,
                'entries',
                { kind: 'revision' }
            )).rejects.toThrow('IndexedDB admission revision row is required');
        }
        finally {
            database.close();
        }
    });

    it('persists a write token on every IndexedDB admission data row', async () => {
        const databaseName = `admission-write-token-${crypto.randomUUID()}`;
        const backend = new IndexedDbAdmissionBackend(databaseName, 'entries', Date.now);
        await backend.write((transaction) => transaction.set('version:peer-a', '7'));
        const database = await openIndexedDbAdmissionDatabase(databaseName, 'entries');
        try {
            const snapshot = await readIndexedDbAdmissionSnapshot(
                database,
                'entries',
                { kind: 'key', key: 'version:peer-a' }
            );
            expect(snapshot.stored[0]?.writeToken).toEqual(expect.any(String));
            expect(await backend.read('version:peer-a', decodeVersion)).toBe(7);
        }
        finally {
            database.close();
        }
    });

    it('rejects a persisted data row without the required write token', async () => {
        const databaseName = `admission-missing-write-token-${crypto.randomUUID()}`;
        const seeded = await openIndexedDbAdmissionDatabase(databaseName, 'entries');
        try {
            await putIndexedDbRows(seeded, 'entries', [{
                key: 'version:missing-token',
                value: '7',
                expireAtTimestamp: Number.MAX_SAFE_INTEGER
            }]);
        }
        finally {
            seeded.close();
        }

        const backend = new IndexedDbAdmissionBackend(databaseName, 'entries', Date.now);
        await expect(backend.read('version:missing-token', decodeVersion)).rejects.toMatchObject({
            name: 'ALAdmissionCorruptionError',
            key: 'version:missing-token'
        });
    });

    it('uses the supplied clock for memory and IndexedDB expiry decisions', async () => {
        let nowMs = 10;
        const clock = () => nowMs;
        const stores = [
            new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), clock),
            new IndexedDbAdmissionBackend(`admission-clock-${crypto.randomUUID()}`, 'entries', clock)
        ];
        for (const backend of stores) {
            await backend.write((tx) => tx.set('version:timed', '7', 20));
            expect(await backend.read('version:timed', decodeVersion)).toBe(7);
        }
        nowMs = 20;
        for (const backend of stores) {
            expect(await backend.read('version:timed', decodeVersion)).toBeUndefined();
        }
    });

    it('rejects a mismatched memory row key on direct, listed, and transactional reads', async () => {
        const state = createInMemoryALAdmissionState();
        const backend = new InMemoryAdmissionBackend(state, Date.now);
        state.data.set('version:bad', { key: 'version:other', value: '7', expireAtTimestamp: Number.MAX_SAFE_INTEGER });
        const corruption = { name: 'ALAdmissionCorruptionError', key: 'version:bad' };
        await expect(backend.read('version:bad', decodeVersion)).rejects.toMatchObject(corruption);
        await expect(backend.list('version:', decodeVersion)).rejects.toMatchObject(corruption);
        await expect(backend.write((transaction) => transaction.read('version:bad', decodeVersion)))
            .rejects.toMatchObject(corruption);
    });

    it('rejects malformed memory expiry instead of silently deleting the row as expired', async () => {
        const state = createInMemoryALAdmissionState();
        const backend = new InMemoryAdmissionBackend(state, Date.now);
        state.data.set('version:bad', { key: 'version:bad', value: '7', expireAtTimestamp: NaN });
        await expect(backend.read('version:bad', decodeVersion))
            .rejects.toMatchObject({ name: 'ALAdmissionCorruptionError', key: 'version:bad' });
        expect(state.data.has('version:bad')).toBe(true);
    });

    it('validates expired memory payloads before cleanup, including transactional lists', async () => {
        const state = createInMemoryALAdmissionState();
        const backend = new InMemoryAdmissionBackend(state, Date.now);
        state.data.set('version:bad', { key: 'version:bad', value: false, expireAtTimestamp: 1 });
        const corruption = { name: 'ALAdmissionCorruptionError', key: 'version:bad' };
        await expect(backend.read('version:bad', decodeVersion)).rejects.toMatchObject(corruption);
        await expect(backend.write((tx) => tx.list('version:', decodeVersion))).rejects.toMatchObject(corruption);
        expect(state.data.has('version:bad')).toBe(true);
    });

    it('keeps IndexedDB writes uncommitted while an asynchronous callback can still fail', async () => {
        const backend = new IndexedDbAdmissionBackend(`admission-async-${crypto.randomUUID()}`, 'entries', Date.now);
        await backend.write((tx) => tx.set('version:bad', false));
        await expect(backend.write(async (tx) => {
            await tx.set('version:new', '8');
            // Deliberately cross a macrotask boundary, where IndexedDB would otherwise auto-commit.
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
            await tx.read('version:bad', decodeVersion);
        })).rejects.toMatchObject({ name: 'ALAdmissionCorruptionError', key: 'version:bad' });
        expect(await backend.read('version:new', decodeVersion)).toBeUndefined();
    });

    it('commits IndexedDB writes after an asynchronous callback succeeds', async () => {
        const backend = new IndexedDbAdmissionBackend(`admission-async-success-${crypto.randomUUID()}`, 'entries', Date.now);
        const result = await backend.write(async (tx) => {
            await tx.set('version:new', '8');
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
            return await tx.read('version:new', decodeVersion);
        });
        expect(result).toBe(8);
        expect(await backend.read('version:new', decodeVersion)).toBe(8);
    });

    it('serializes cooperating writers that share one IndexedDB store revision', async () => {
        const lockTails = new Map<string, Promise<void>>();
        const requestedLockNames: string[] = [];
        const requestLock = async <T>(
            name: string,
            _options: { mode: 'exclusive'; },
            callback: () => Promise<T>
        ): Promise<T> => {
            requestedLockNames.push(name);
            const previous = lockTails.get(name) ?? Promise.resolve();
            const release = Promise.withResolvers<void>();
            const tail = previous.then(() => release.promise);
            lockTails.set(name, tail);
            await previous;
            try {
                return await callback();
            }
            finally {
                release.resolve();
                if (lockTails.get(name) === tail) {
                    lockTails.delete(name);
                }
            }
        };
        vi.stubGlobal('navigator', { locks: { request: requestLock } });
        const databaseName = `admission-cooperating-writers-${crypto.randomUUID()}`;
        const first = new IndexedDbAdmissionBackend(databaseName, 'entries', Date.now);
        const second = new IndexedDbAdmissionBackend(databaseName, 'entries', Date.now);
        const firstEntered = Promise.withResolvers<void>();
        const releaseFirst = Promise.withResolvers<void>();
        const firstWrite = first.write(async (transaction) => {
            firstEntered.resolve();
            await releaseFirst.promise;
            await transaction.set('version:first', '1');
        });
        await firstEntered.promise;
        const secondWrite = second.write((transaction) => transaction.set('version:second', '2'));

        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        releaseFirst.resolve();
        await expect(Promise.all([firstWrite, secondWrite])).resolves.toEqual([undefined, undefined]);
        expect(requestedLockNames).toEqual([
            `rallar:indexed-db-admission:${databaseName}:entries`,
            `rallar:indexed-db-admission:${databaseName}:entries`
        ]);
        expect(await first.read('version:first', decodeVersion)).toBe(1);
        expect(await second.read('version:second', decodeVersion)).toBe(2);
    });

    it('validates expired IndexedDB payloads before cleanup', async () => {
        const backend = new IndexedDbAdmissionBackend(`admission-expired-${crypto.randomUUID()}`, 'entries', Date.now);
        await backend.write((tx) => tx.set('version:bad', false, 1));
        const corruption = { name: 'ALAdmissionCorruptionError', key: 'version:bad' };
        await expect(backend.read('version:bad', decodeVersion)).rejects.toMatchObject(corruption);
        await expect(backend.list('version:', decodeVersion)).rejects.toMatchObject(corruption);
    });

    it.each(['read', 'list'] as const)(
        'does not let %s expiry cleanup delete a concurrent refresh',
        async (operation) => {
            const databaseName = `admission-expiry-race-${operation}-${crypto.randomUUID()}`;
            const backend = new IndexedDbAdmissionBackend(databaseName, 'entries', () => 10);
            await backend.write((transaction) => transaction.set('version:refreshed', '7', 1));
            const transactionImplementation = IDBDatabase.prototype.transaction;
            let refreshWritten = false;
            vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
                this: IDBDatabase,
                ...args: Parameters<IDBDatabase['transaction']>
            ) {
                if (args[1] === 'readwrite' && !refreshWritten) {
                    refreshWritten = true;
                    const refresh = Reflect.apply(transactionImplementation, this, args);
                    refresh.objectStore('entries').put({
                        key: 'version:refreshed',
                        value: '8',
                        expireAtTimestamp: Number.MAX_SAFE_INTEGER,
                        writeToken: 'replacement'
                    });
                }
                return Reflect.apply(transactionImplementation, this, args);
            });

            const operationResult = operation === 'read'
                ? backend.read('version:refreshed', decodeVersion)
                : backend.list('version:', decodeVersion);

            await expect(operationResult).rejects.toMatchObject({
                name: 'ALAdmissionBackendConflictError'
            });
            expect(refreshWritten).toBe(true);
            const database = await openIndexedDbAdmissionDatabase(databaseName, 'entries');
            try {
                const snapshot = await readIndexedDbAdmissionSnapshot(
                    database,
                    'entries',
                    { kind: 'key', key: 'version:refreshed' }
                );
                expect(snapshot.stored).toEqual([{
                    key: 'version:refreshed',
                    value: '8',
                    expireAtTimestamp: Number.MAX_SAFE_INTEGER,
                    writeToken: 'replacement'
                }]);
            }
            finally {
                database.close();
            }
        }
    );

    it('rejects malformed IndexedDB envelopes on direct and listed reads', async () => {
        const databaseName = `admission-corrupt-${crypto.randomUUID()}`;
        const backend = new IndexedDbAdmissionBackend(databaseName, 'entries', Date.now);
        const database = await openIndexedDbAdmissionDatabase(databaseName, 'entries');
        try {
            await putIndexedDbRows(database, 'entries', [{
                key: 'version:bad',
                value: '7',
                expireAtTimestamp: NaN,
                writeToken: 'write-token'
            }]);
            const corruption = { name: 'ALAdmissionCorruptionError', key: 'version:bad' };
            await expect(backend.read('version:bad', decodeVersion)).rejects.toMatchObject(corruption);
            await expect(backend.list('version:', decodeVersion)).rejects.toMatchObject(corruption);
            await expect(backend.write(async (tx) => {
                await tx.set('version:new', '8');
                await tx.list('version:', decodeVersion);
            })).rejects.toMatchObject(corruption);
            expect(await backend.read('version:new', decodeVersion)).toBeUndefined();
        }
        finally {
            database.close();
        }
    });

    it('rejects malformed IndexedDB metadata when reading cleanup rows', async () => {
        const databaseName = `admission-custom-read-corrupt-${crypto.randomUUID()}`;
        const database = await openIndexedDbAdmissionDatabase(databaseName, 'entries');
        try {
            await putIndexedDbRows(database, 'entries', [{
                key: 'version:bad',
                value: '7',
                expireAtTimestamp: NaN,
                writeToken: 'write-token'
            }]);

            await expect(readIndexedDbAdmissionSnapshot(
                database,
                'entries',
                { kind: 'key', key: 'version:bad' }
            )).rejects.toMatchObject({ name: 'ALAdmissionCorruptionError', key: 'version:bad' });
        }
        finally {
            database.close();
        }
    });

    it('rejects a malformed guarded-removal row instead of reporting a write conflict', async () => {
        const databaseName = `admission-guarded-remove-corrupt-${crypto.randomUUID()}`;
        const database = await openIndexedDbAdmissionDatabase(databaseName, 'entries');
        try {
            await putIndexedDbRows(database, 'entries', [{
                key: 'version:bad',
                value: '7',
                expireAtTimestamp: Number.MAX_SAFE_INTEGER,
                writeToken: 7
            }]);

            await expect(writeIndexedDbAdmissionMutations({
                db: database,
                storeName: 'entries',
                expectedRevision: 0,
                mutations: [{
                    kind: 'remove-if-write-token',
                    key: 'version:bad',
                    expectedWriteToken: 'write-token'
                }],
                revisionWrite: computeIndexedDbAdmissionRevisionWrite(0)
            })).rejects.toMatchObject({ name: 'ALAdmissionCorruptionError', key: 'version:bad' });
        }
        finally {
            database.close();
        }
    });

    it('rejects a revision row that does not match the current stored shape', async () => {
        const databaseName = `admission-invalid-revision-${crypto.randomUUID()}`;
        const database = await openIndexedDbAdmissionDatabase(databaseName, 'entries');
        try {
            await putIndexedDbRows(database, 'entries', [{
                key: AL_ADMISSION_REVISION_KEY,
                value: 0,
                expireAtTimestamp: 'invalid-expiry'
            }]);

            await expect(writeIndexedDbAdmissionMutations({
                db: database,
                storeName: 'entries',
                expectedRevision: 0,
                mutations: [],
                revisionWrite: computeIndexedDbAdmissionRevisionWrite(0)
            })).rejects.toMatchObject({
                name: 'ALAdmissionCorruptionError',
                key: AL_ADMISSION_REVISION_KEY
            });
        }
        finally {
            database.close();
        }
    });

    it('lists a matching key whose suffix starts with the maximum UTF-16 code unit', async () => {
        const databaseName = `admission-prefix-bound-${crypto.randomUUID()}`;
        const backend = new IndexedDbAdmissionBackend(databaseName, 'entries', Date.now);
        const key = `version:\ufffftail`;
        await backend.write((transaction) => transaction.set(key, '7'));

        await expect(backend.list('version:', decodeVersion)).resolves.toEqual([
            { key, value: 7 }
        ]);
    });

    it('returns one row when requested prefixes overlap', async () => {
        const databaseName = `admission-overlapping-prefixes-${crypto.randomUUID()}`;
        const backend = new IndexedDbAdmissionBackend(databaseName, 'entries', Date.now);
        await backend.write((transaction) => transaction.set('version:peer-a', '7'));
        const database = await openIndexedDbAdmissionDatabase(databaseName, 'entries');
        try {
            const snapshot = await readIndexedDbAdmissionSnapshot(
                database,
                'entries',
                { kind: 'prefixes', prefixes: ['version:', 'version:peer'] }
            );
            expect(snapshot.stored).toHaveLength(1);
            expect(snapshot.stored[0]?.key).toBe('version:peer-a');
        }
        finally {
            database.close();
        }
    });
});

async function putIndexedDbRows(
    database: IDBDatabase,
    storeName: string,
    rows: readonly object[]
): Promise<void> {
    const transaction = database.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    for (const row of rows) {
        store.put(row);
    }
    await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
    });
}

function decodeVersion(value: unknown): number {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
        throw new TypeError('Version must contain decimal digits');
    }
    return Number(value);
}
