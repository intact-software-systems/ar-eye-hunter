import '../../setup-browser-indexeddb.ts';

import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import type { ALAdmissionWorkBackend } from '@shared/alm/al-admission-work-backend.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import {
    AL_ADMISSION_WORK_STORE_NAME,
    openIndexedDbAdmissionDatabase
} from '@shared/alm/open-indexed-db-admission-database.ts';
import { readIndexedDbAdmissionSnapshot } from '@shared/alm/read-indexed-db-admission-snapshot.ts';
import {
    computeIndexedDbAdmissionRevisionWrite,
    writeIndexedDbAdmissionMutations,
    type WriteIndexedDbAdmissionMutationsInput
} from '@shared/alm/write-indexed-db-admission-mutations.ts';
import { IndexedDbConnection } from '@shared/persistence/open-indexed-db.ts';
import { computeIndexedDbQueuePut } from '@shared/queuebox/indexed-db-queue-box-entry.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/indexed-db-queue-box.ts';
import { EntityStatus, NEVER_EXPIRE_TS, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

const admissionStore = 'admission';

describe('atomic admission and QueueBox work', () => {
    it.each(['memory', 'indexeddb'] as const)('records QueueBox work through the %s admission write context', async (storage) => {
        const backend = createWorkBackend(storage);
        const entry = createEntry('backend-work');
        await backend.write(async (transaction) => {
            expect(await transaction.readWork(entry.key)).toBeUndefined();
            await transaction.set('admitted', 'accepted');
            transaction.writeWork(entry);
            expect(await transaction.readWork(entry.key)).toMatchObject({ resource: 'backend-work' });
        });
        expect(await backend.read('admitted', (value) => value)).toBe('accepted');
        const reserved = await backend.workQueue.reserveEntries(new Set(['alm-work']), new Set([EntityStatus.NEW]), 1);
        expect([...reserved.values()]).toMatchObject([{ key: entry.key, resource: 'backend-work', status: EntityStatus.RESERVED }]);
    });

    it.each(['memory', 'indexeddb'] as const)('rolls back %s admission when a queue insertion loses its observed empty slot', async (storage) => {
        const backend = createWorkBackend(storage);
        const entry = createEntry('raced-work');
        await expect(backend.write(async (transaction) => {
            expect(await transaction.readWork(entry.key)).toBeUndefined();
            await backend.workQueue.enqueueIfAbsent({ ...entry, resource: 'winner' });
            await transaction.set('admitted', 'loser');
            transaction.writeWork(entry);
        })).rejects.toMatchObject({ name: 'ALAdmissionBackendConflictError' });
        expect(await backend.read('admitted', (value) => value)).toBeUndefined();
        expect((await backend.workQueue.getItem(entry.key))?.resource).toBe('winner');
    });

    it.each(['memory', 'indexeddb'] as const)('keeps neither state nor work after a rejected %s admission', async (storage) => {
        const backend = createWorkBackend(storage);
        const entry = createEntry('rejected');
        await expect(backend.write(async (transaction) => {
            await transaction.readWork(entry.key);
            await transaction.set('admitted', 'rejected');
            transaction.writeWork(entry);
            throw new Error('Admission rejected');
        })).rejects.toThrow('Admission rejected');
        expect(await backend.read('admitted', (value) => value)).toBeUndefined();
        expect(await backend.workQueue.getItem(entry.key)).toBeUndefined();
    });

    it.each(['memory', 'indexeddb'] as const)('reuses observed terminal %s work for a later repair', async (storage) => {
        const backend = createWorkBackend(storage);
        const entry = createEntry('repair');
        await backend.workQueue.enqueue({ ...entry, status: EntityStatus.COMPLETED });
        await backend.write(async (transaction) => {
            const observed = await transaction.readWork(entry.key);
            expect(observed?.status).toBe(EntityStatus.COMPLETED);
            transaction.writeWork(entry);
            await transaction.set('admitted', 'repair');
        });
        expect(await backend.read('admitted', (value) => value)).toBe('repair');
        expect(await backend.workQueue.getItem(entry.key)).toMatchObject(entry);
    });

    it.each(['memory', 'indexeddb'] as const)('cannot overwrite a %s reservation made after the admission read', async (storage) => {
        const backend = createWorkBackend(storage);
        const entry = createEntry('reserved');
        await backend.workQueue.enqueue(entry);
        await expect(backend.write(async (transaction) => {
            await transaction.readWork(entry.key);
            await backend.workQueue.reserveEntries(new Set(['alm-work']), new Set([EntityStatus.NEW]), 1);
            transaction.writeWork({ ...entry, resource: 'stale-repair' });
            await transaction.set('admitted', 'stale');
        })).rejects.toMatchObject({ name: 'ALAdmissionBackendConflictError' });
        expect(await backend.read('admitted', (value) => value)).toBeUndefined();
        expect(await backend.workQueue.getItem(entry.key)).toMatchObject({
            status: EntityStatus.RESERVED,
            resource: 'reserved',
            dequeueAudit: { attempts: 1 }
        });
    });

    it.each(['memory', 'indexeddb'] as const)('owns %s admission work values across reads and computed writes', async (storage) => {
        const backend = createWorkBackend(storage);
        const entry = createEntry('owned');
        await backend.workQueue.enqueue({ ...entry, status: EntityStatus.COMPLETED });
        await backend.write(async (transaction) => {
            const observed = await transaction.readWork(entry.key);
            observed!.status = EntityStatus.FAILED;
            expect((await transaction.readWork(entry.key))?.status).toBe(EntityStatus.COMPLETED);
            transaction.writeWork(entry);
            const pending = await transaction.readWork(entry.key);
            Object.assign(pending!.dequeueAudit, { attempts: 99 });
            Object.assign(entry.audit, { createdBy: 'mutated-after-write' });
            Object.assign(entry.key, { resourceId: 'mutated-key' });
        });
        expect(await backend.workQueue.getItem(createEntry('owned').key)).toMatchObject(createEntry('owned'));
    });

    it.each(['memory', 'indexeddb'] as const)('rejects a %s decision when a read-only queue observation changes', async (storage) => {
        const backend = createWorkBackend(storage);
        const entry = createEntry('observed-work');
        await backend.workQueue.enqueue(entry);
        await expect(backend.write(async (transaction) => {
            expect((await transaction.readWork(entry.key))?.status).toBe(EntityStatus.NEW);
            await backend.workQueue.reserveEntries(new Set(['alm-work']), new Set([EntityStatus.NEW]), 1);
            await transaction.set('admitted', 'stale-decision');
        })).rejects.toMatchObject({ name: 'ALAdmissionBackendConflictError' });
        expect(await backend.read('admitted', (value) => value)).toBeUndefined();
        expect((await backend.workQueue.getItem(entry.key))?.status).toBe(EntityStatus.RESERVED);
    });

    it.each(['memory', 'indexeddb'] as const)('guards an observed empty %s queue slot even without a queued write', async (storage) => {
        const backend = createWorkBackend(storage);
        const entry = createEntry('observed-empty');
        await expect(backend.write(async (transaction) => {
            expect(await transaction.readWork(entry.key)).toBeUndefined();
            await backend.workQueue.enqueueIfAbsent(entry);
        })).rejects.toMatchObject({ name: 'ALAdmissionBackendConflictError' });
        expect(await backend.workQueue.getItem(entry.key)).toMatchObject(entry);
    });

    it.each(['memory', 'indexeddb'] as const)('commits a %s decision without rewriting unchanged observed work', async (storage) => {
        const backend = createWorkBackend(storage);
        const entry = createEntry('unchanged-work');
        await backend.workQueue.enqueue(entry);
        const observed = await backend.workQueue.getItem(entry.key);
        await backend.write(async (transaction) => {
            expect(await transaction.readWork(entry.key)).toEqual(observed);
            await transaction.set('admitted', 'accepted');
        });
        expect(await backend.read('admitted', (value) => value)).toBe('accepted');
        expect(await backend.workQueue.getItem(entry.key)).toEqual(observed);
    });

    it.each(['memory', 'indexeddb'] as const)('fences an old %s worker after completed work is reused at the same key', async (storage) => {
        const queue = createWorkBackend(storage).workQueue;
        const entry = createEntry('reused');
        await queue.enqueue(entry);
        const [old] = (await queue.reserveEntries(new Set(['alm-work']), new Set([EntityStatus.NEW]), 1)).values();
        await queue.releaseEntries([old], { status: EntityStatus.COMPLETED, delayMs: null });
        await queue.enqueue({ ...entry, resource: 'later-work' });
        const [current] = (await queue.reserveEntries(new Set(['alm-work']), new Set([EntityStatus.NEW]), 1)).values();
        expect(old.dequeueAudit.attempts).toBe(current.dequeueAudit.attempts);
        await expect(queue.releaseEntries([old], { status: EntityStatus.COMPLETED, delayMs: null }))
            .rejects.toMatchObject({ code: 'resource-inbox-lost-reservation' });
        expect(await queue.getItem(entry.key)).toEqual(current);
    });

    it('records admission and work together, then reserves work through the existing QueueBox', async () => {
        const { db, queue } = await createStorage();
        const entry = createEntry('message');
        const write = createWrite(db, entry);
        Object.freeze(write.queueMutations);
        Object.freeze(write.mutations);
        Object.freeze(write);
        expect(await writeIndexedDbAdmissionMutations(write)).toBe(true);
        expect((await readIndexedDbAdmissionSnapshot(db, admissionStore, { kind: 'key', key: 'admitted' })).stored)
            .toHaveLength(1);
        const reserved = await queue.reserveEntries(new Set(['alm-work']), new Set([EntityStatus.NEW]), 1);
        expect([...reserved.values()]).toMatchObject([{ key: entry.key, resource: entry.resource, status: EntityStatus.RESERVED }]);
        expect(write.queueMutations[0]).toMatchObject({ kind: 'put', value: { status: EntityStatus.NEW } });
    });

    it('rolls back queued work when the admission revision changed after the read', async () => {
        const { db, queue } = await createStorage();
        const stale = createWrite(db, createEntry('stale'));
        const winner = createWrite(db, createEntry('winner'));
        expect(await writeIndexedDbAdmissionMutations(winner)).toBe(true);
        expect(await writeIndexedDbAdmissionMutations(stale)).toBe(false);
        expect(await queue.getItem(createEntry('stale').key)).toBeUndefined();
        expect(await queue.getItem(createEntry('winner').key)).toBeDefined();
        expect((await readIndexedDbAdmissionSnapshot(db, admissionStore, { kind: 'key', key: 'admitted' })).stored[0].value)
            .toBe('winner');
    });

    it('rolls back admission when another queue writer won the same key', async () => {
        const { db, queue } = await createStorage();
        const entry = createEntry('message');
        const computed = createWrite(db, entry);
        await queue.enqueueIfAbsent({ ...entry, resource: 'winner' });
        expect(await writeIndexedDbAdmissionMutations(computed)).toBe(false);
        expect((await readIndexedDbAdmissionSnapshot(db, admissionStore, { kind: 'key', key: 'admitted' })).stored)
            .toEqual([]);
        expect((await queue.getItem(entry.key))?.resource).toBe('winner');
        expect((await readIndexedDbAdmissionSnapshot(db, admissionStore, { kind: 'revision' })).revision).toBe(0);
    });

    it('preserves neither admission nor work after a native transaction abort', async () => {
        const { db, queue } = await createStorage();
        const entry = createEntry('aborted');
        const transaction = db.transaction.bind(db);
        const failure = vi.spyOn(db, 'transaction').mockImplementation((...args) => {
            const tx = transaction(...args);
            if (args[1] === 'readwrite') {
                queueMicrotask(() => tx.abort());
            }
            return tx;
        });
        try {
            await expect(writeIndexedDbAdmissionMutations(createWrite(db, entry))).rejects.toThrow();
        }
        finally {
            failure.mockRestore();
        }
        expect((await readIndexedDbAdmissionSnapshot(db, admissionStore, { kind: 'key', key: 'admitted' })).stored).toEqual([]);
        expect(await queue.getItem(entry.key)).toBeUndefined();
    });

    it('rejects two mutations for one queue key before committing admission', async () => {
        const { db, queue } = await createStorage();
        const entry = createEntry('duplicate');
        const computed = createWrite(db, entry);
        await expect(writeIndexedDbAdmissionMutations({
            ...computed,
            queueMutations: [...computed.queueMutations, ...computed.queueMutations]
        })).rejects.toThrow('duplicate queue key');
        expect((await readIndexedDbAdmissionSnapshot(db, admissionStore, { kind: 'key', key: 'admitted' })).stored).toEqual([]);
        expect(await queue.getItem(entry.key)).toBeUndefined();
    });

    it('rejects invalid queue values before opening the joint write transaction', async () => {
        const { db, queue } = await createStorage();
        const entry = createEntry('invalid');
        const computed = createWrite(db, entry);
        const transaction = vi.spyOn(db, 'transaction');
        try {
            await expect(writeIndexedDbAdmissionMutations({
                ...computed,
                queueMutations: [{ ...computed.queueMutations[0], keyString: 'another-key' }]
            })).rejects.toThrow('mutation key differs');
            expect(transaction).not.toHaveBeenCalled();
        }
        finally {
            transaction.mockRestore();
        }
        expect(await queue.getItem(entry.key)).toBeUndefined();
    });
});

interface AdmissionQueueStorage {
    readonly db: IDBDatabase;
    readonly queue: IndexedDbQueueBox;
}

function createWorkBackend(storage: 'memory' | 'indexeddb'): ALAdmissionWorkBackend {
    return storage === 'memory'
        ? new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now)
        : new IndexedDbAdmissionBackend(`backend-work-${crypto.randomUUID()}`, admissionStore, Date.now);
}

async function createStorage(): Promise<AdmissionQueueStorage> {
    const db = await openIndexedDbAdmissionDatabase(`alm-queue-commit-${crypto.randomUUID()}`, admissionStore);
    onTestFinished(() => db.close());
    const queue = new IndexedDbQueueBox({
        connection: new IndexedDbConnection(async () => db),
        storeName: AL_ADMISSION_WORK_STORE_NAME
    });
    return { db, queue };
}

function createWrite(db: IDBDatabase, entry: ResourceEntry): WriteIndexedDbAdmissionMutationsInput {
    return {
        db,
        storeName: admissionStore,
        expectedRevision: 0,
        mutations: [{
            kind: 'set' as const,
            stored: {
                key: 'admitted',
                value: entry.key.resourceId,
                expireAtTimestamp: Number.MAX_SAFE_INTEGER,
                writeToken: crypto.randomUUID()
            }
        }],
        queueMutations: [computeIndexedDbQueuePut(undefined, entry)],
        revisionWrite: computeIndexedDbAdmissionRevisionWrite(0)
    };
}

function createEntry(resourceId: string): ResourceEntry {
    return {
        key: { topicId: 'alm-work', resourceId, contextId: 'session' },
        typeId: 'alm-work',
        resource: resourceId,
        status: EntityStatus.NEW,
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'sender',
            createdTs: Temporal.PlainDateTime.from('2026-09-06T12:00:00'),
            expiryTs: NEVER_EXPIRE_TS
        },
        dequeueAudit: { attempts: 0 }
    };
}
