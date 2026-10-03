// @vitest-environment happy-dom

import '../../../setup-browser-indexeddb.ts';

import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, onTestFinished } from 'vitest';

import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { ALCheckpointDirtySet } from '@shared/alm/checkpoint/al-checkpoint-dirty-set.ts';
import { computeALCheckpointMutations } from '@shared/alm/checkpoint/compute-al-checkpoint-mutations.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { EMPTY_INDEXED_DB_ADMISSION_FENCE } from '@shared/alm/indexed-db-admission-fence.ts';
import {
    AL_ADMISSION_SCHEMA_ID,
    openIndexedDbAdmissionDatabase
} from '@shared/alm/open-indexed-db-admission-database.ts';
import { writeIndexedDbAdmissionMutations } from '@shared/alm/write-indexed-db-admission-mutations.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { encodeStoredResourceEntry } from '@shared/queuebox/indexed-db-queue-box-entry-codec.ts';

import { createCheckpointTestEntry, toCheckpointTestKey } from './checkpoint-test-entry.ts';

interface CaptureFixture {
    readonly backend: InMemoryAdmissionBackend;
    readonly dirty: ALCheckpointDirtySet;
}

function createFixture(): CaptureFixture {
    const queue = new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(1_000));
    const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(queue), () => 1_000);
    return { backend, dirty: new ALCheckpointDirtySet({ backend, nowMs: () => 1_000 }) };
}

function captureFrom(fixture: CaptureFixture, writeToken: string) {
    return computeALCheckpointMutations({
        snapshot: fixture.dirty.getSnapshot(),
        peekAdmission: (key) => fixture.backend.peek(key),
        peekQueueEntry: (key) => fixture.backend.workQueue.peek(key),
        writeToken
    });
}

describe('computeALCheckpointMutations', () => {
    it('writes the current value of each dirty row once, in the existing row formats', async () => {
        const fixture = createFixture();
        const work = createCheckpointTestEntry('work');
        await fixture.backend.write(async (tx) => {
            await tx.set('row', '1', 60_000);
        });
        await fixture.backend.write(async (tx) => {
            await tx.set('row', '2', 60_000);
        });
        await fixture.backend.workQueue.enqueue(work);

        expect(captureFrom(fixture, 'checkpoint-token')).toEqual({
            mutations: [{
                kind: 'set',
                stored: { key: 'row', value: '2', expireAtTimestamp: 60_000, writeToken: 'checkpoint-token', revision: 1 }
            }],
            queueMutations: [{
                kind: 'put-unconditionally',
                keyString: toCheckpointTestKey('work'),
                value: encodeStoredResourceEntry(work, 0)
            }]
        });
    });

    it('writes a delete for a row removed since it was dirtied', async () => {
        const fixture = createFixture();
        await fixture.backend.write(async (tx) => {
            await tx.set('row', '1', 60_000);
        });
        await fixture.backend.workQueue.enqueue(createCheckpointTestEntry('work'));
        await fixture.backend.write(async (tx) => {
            await tx.remove('row');
        });
        await fixture.backend.workQueue.removeItem(createCheckpointTestEntry('work').key);

        expect(captureFrom(fixture, 'checkpoint-token')).toEqual({
            mutations: [{ kind: 'remove', key: 'row' }],
            queueMutations: [{ kind: 'delete-unconditionally', keyString: toCheckpointTestKey('work') }]
        });
    });

    it('lands, rewritten in place, as rows the durable backend reads as its own', async () => {
        const fixture = createFixture();
        const dbName = `checkpoint-capture-${crypto.randomUUID()}`;
        const db = await openIndexedDbAdmissionDatabase({
            dbName,
            storeName: 'entries',
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: () => {}
        });
        onTestFinished(() => db.close());
        const write = async (writeToken: string) => {
            const capture = captureFrom(fixture, writeToken);
            return await writeIndexedDbAdmissionMutations({
                db,
                storeName: 'entries',
                fence: EMPTY_INDEXED_DB_ADMISSION_FENCE,
                mutations: capture.mutations,
                queueMutations: capture.queueMutations
            });
        };
        await fixture.backend.write(async (tx) => {
            await tx.set('checkpoint:row', '1', 60_000);
        });
        await fixture.backend.workQueue.enqueue(createCheckpointTestEntry('work'));
        expect(await write('first')).toBe(true);
        await fixture.backend.write(async (tx) => {
            await tx.set('checkpoint:row', '2', 60_000);
        });
        await fixture.backend.workQueue.enqueue({ ...createCheckpointTestEntry('work'), resource: 'rewritten' });
        expect(await write('second')).toBe(true);
        const durable = new IndexedDbAdmissionBackend({
            dbName,
            storeName: 'entries',
            nowMs: () => 1_000,
            newWriteToken: () => 'unused',
            observer: createPassThroughIndexedDbOperationObserver(),
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: () => {}
        });

        expect(await durable.list('checkpoint:', (value) => value)).toEqual([{ key: 'checkpoint:row', value: '2' }]);
        expect(await durable.workQueue.getItem(createCheckpointTestEntry('work').key))
            .toMatchObject({ key: createCheckpointTestEntry('work').key, resource: 'rewritten' });
    });
});
