import '../../setup-browser-indexeddb.ts';

import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

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

describe('atomic IndexedDB admission and QueueBox work', () => {
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
