import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { ALCheckpointDirtySet } from '@shared/alm/checkpoint/al-checkpoint-dirty-set.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import {
    CHECKPOINT_TEST_TYPE_ID,
    createCheckpointTestEntry,
    toCheckpointTestKey
} from './checkpoint-test-entry.ts';

interface DirtySetFixture {
    readonly backend: InMemoryAdmissionBackend;
    readonly dirty: ALCheckpointDirtySet;
    readonly clock: { nowMs: number; };
}

function createFixture(): DirtySetFixture {
    const clock = { nowMs: 1_000 };
    const queue = new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(clock.nowMs));
    const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(queue), () => clock.nowMs);
    return { backend, dirty: new ALCheckpointDirtySet({ backend, nowMs: () => clock.nowMs }), clock };
}

describe('ALCheckpointDirtySet', () => {
    it('marks each admission row and queue entry once, at the revision of its latest change', async () => {
        const { backend, dirty } = createFixture();

        await backend.write(async (tx) => {
            await tx.set('row-a', '1', 60_000);
            await tx.set('row-b', '2', 60_000);
        });
        await backend.workQueue.enqueue(createCheckpointTestEntry('work'));
        await backend.workQueue.reserveEntries({
            typeIds: new Set([CHECKPOINT_TEST_TYPE_ID]),
            statusIds: new Set([EntityStatus.NEW]),
            reservationInput: 1
        });

        expect(dirty.getSnapshot()).toEqual({
            marks: [
                { space: 'admission', key: 'row-a', revision: 1 },
                { space: 'admission', key: 'row-b', revision: 2 },
                { space: 'queue', key: toCheckpointTestKey('work'), revision: 4 }
            ],
            takenAtMs: 1_000
        });
    });

    it('clears only the keys whose captured revision is still the latest', async () => {
        const { backend, dirty, clock } = createFixture();
        await backend.write(async (tx) => {
            await tx.set('saved', '1', 60_000);
            await tx.set('changed-during-write', '1', 60_000);
        });
        clock.nowMs = 2_000;
        const snapshot = dirty.getSnapshot();
        clock.nowMs = 2_500;
        await backend.write(async (tx) => {
            await tx.set('changed-during-write', '2', 60_000);
        });

        dirty.clearSaved(snapshot);

        expect(dirty.getSnapshot().marks).toEqual([{ space: 'admission', key: 'changed-during-write', revision: 3 }]);
        // The newer change happened after the capture started, so it is unsaved since then at the latest.
        expect(dirty.getOldestDirtiedAtMs()).toBe(2_000);
    });

    it('reads clean and ageless until a change, and tells its listener of every mark', async () => {
        const { backend, dirty, clock } = createFixture();
        let marked = 0;
        dirty.onMarkedDo(() => {
            marked += 1;
        });

        expect(dirty.isClean()).toBe(true);
        expect(dirty.getOldestDirtiedAtMs()).toBeUndefined();
        clock.nowMs = 1_500;
        await backend.write(async (tx) => {
            await tx.set('row', '1', 60_000);
        });
        clock.nowMs = 1_800;
        await backend.workQueue.enqueue(createCheckpointTestEntry('work'));

        expect(dirty.isClean()).toBe(false);
        expect(dirty.getOldestDirtiedAtMs()).toBe(1_500);
        expect(marked).toBe(2);
    });

    it('marks nothing once disposed', async () => {
        const { backend, dirty } = createFixture();

        dirty.dispose();
        await backend.write(async (tx) => {
            await tx.set('row', '1', 60_000);
        });
        await backend.workQueue.enqueue(createCheckpointTestEntry('work'));

        expect(dirty.isClean()).toBe(true);
    });
});
