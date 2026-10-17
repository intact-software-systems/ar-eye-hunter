import { describe, expect, it } from 'vitest';

import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import '../../setup-browser-indexeddb.ts';

// Base storage ordering differs by adapter; these keys have the same relative order in both.
describe.each(['memory', 'IndexedDB'] as const)('%s transaction overlay', (kind) => {
    it('lists unshadowed stored rows before last staged puts in first-mutation order', async () => {
        const backend = createBackend(kind);
        await backend.write(async (tx) => {
            await tx.set('row:a', 'old');
            await tx.set('row:b', 'kept');
            await tx.set('row:c', 'removed');
        });
        const result = await backend.write(async (tx) => {
            await tx.set('row:a', 'first');
            await tx.remove('row:c');
            await tx.set('outside', 'excluded');
            await tx.set('row:new', 'new');
            await tx.remove('row:a');
            await tx.set('row:a', 'last');
            return await tx.list('row:', decodeText);
        });
        expect(result).toEqual([
            { key: 'row:b', value: 'kept' },
            { key: 'row:a', value: 'last' },
            { key: 'row:new', value: 'new' }
        ]);
        expect(await backend.read('row:a', decodeText)).toBe('last');
        expect(await backend.read('row:c', decodeText)).toBeUndefined();
    });

    it('keeps an expired pending replacement from exposing a stored value', async () => {
        const backend = createBackend(kind);
        await backend.write((tx) => tx.set('row:key', 'stored'));
        await backend.write(async (tx) => {
            await tx.set('row:key', 'expired', 10);
            expect(await tx.read('row:key', decodeText)).toBeUndefined();
            expect(await tx.list('row:', decodeText)).toEqual([]);
            await tx.set('row:key', false, 10);
            await expect(tx.list('row:', decodeText)).rejects.toMatchObject({
                name: 'ALAdmissionCorruptionError',
                key: 'row:key'
            });
            await tx.remove('row:key');
            expect(await tx.list('row:', decodeText)).toEqual([]);
        });
        expect(await backend.read('row:key', decodeText)).toBeUndefined();
    });
});

it('fences overlapping prefix phantoms even when the original row is shadowed', async () => {
    const backend = createBackend('IndexedDB');
    await backend.write((tx) => tx.set('row:a', 'stored'));
    await expect(backend.write(async (tx) => {
        await tx.remove('row:a');
        expect(await tx.list('row:', decodeText)).toEqual([]);
        expect(await tx.list('row:a', decodeText)).toEqual([]);
        await backend.write((other) => other.set('row:added', 'phantom'));
        await tx.set('dependent', 'loser');
    })).rejects.toMatchObject({ name: 'ALAdmissionBackendConflictError' });
    expect(await backend.read('row:a', decodeText)).toBe('stored');
    expect(await backend.read('row:added', decodeText)).toBe('phantom');
    expect(await backend.read('dependent', decodeText)).toBeUndefined();
});

function createBackend(kind: 'memory' | 'IndexedDB') {
    return kind === 'memory'
        ? new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), () => 10)
        : new IndexedDbAdmissionBackend({
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: () => {},
            dbName: `write-overlay-${crypto.randomUUID()}`,
            storeName: 'entries',
            nowMs: () => 10,
            newWriteToken: crypto.randomUUID.bind(crypto),
            observer: createPassThroughIndexedDbOperationObserver()
        });
}

function decodeText(value: unknown): string {
    if (typeof value !== 'string') {
        throw new TypeError('Expected text');
    }
    return value;
}
