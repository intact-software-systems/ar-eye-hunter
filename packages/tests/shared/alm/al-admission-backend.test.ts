// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';

import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend,
    PersistenceProviderAdmissionBackend,
    type ALAdmissionBackend
} from '@shared/alm/al-admission-backend.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { openIndexedDbWithStore } from '@shared/persistence/openIndexedDb.ts';
import { InMemoryPersistenceProvider } from '@shared/persistence/PersistenceProvider.ts';

import '../../setup-browser-indexeddb.ts';

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

    it('validates expired IndexedDB payloads before cleanup', async () => {
        const backend = new IndexedDbAdmissionBackend(`admission-expired-${crypto.randomUUID()}`, 'entries', Date.now);
        await backend.write((tx) => tx.set('version:bad', false, 1));
        const corruption = { name: 'ALAdmissionCorruptionError', key: 'version:bad' };
        await expect(backend.read('version:bad', decodeVersion)).rejects.toMatchObject(corruption);
        await expect(backend.list('version:', decodeVersion)).rejects.toMatchObject(corruption);
    });

    it('rejects malformed IndexedDB envelopes on direct and listed reads', async () => {
        const databaseName = `admission-corrupt-${crypto.randomUUID()}`;
        const backend = new IndexedDbAdmissionBackend(databaseName, 'entries', Date.now);
        const database = await openIndexedDbWithStore(databaseName, { name: 'entries', keyPath: 'key' });
        try {
            const transaction = database.transaction('entries', 'readwrite');
            transaction.objectStore('entries').put({ key: 'version:bad', value: '7', expireAtTimestamp: NaN });
            await new Promise<void>((resolve, reject) => {
                transaction.oncomplete = () => resolve();
                transaction.onabort = () => reject(transaction.error);
            });
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
});

function decodeVersion(value: unknown): number {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
        throw new TypeError('Version must contain decimal digits');
    }
    return Number(value);
}
