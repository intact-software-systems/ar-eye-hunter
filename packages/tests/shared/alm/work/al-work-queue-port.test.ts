import { Temporal } from '@js-temporal/polyfill';
import { createALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';
import { newWorkEntry } from './al-work-test-entries.ts';

describe('ALWorkQueuePort', () => {
    it('claims new work, decides retry once, and refunds a not-ready release', async () => {
        let now = 10_000;
        const queue = new InMemoryQueueBox(
            undefined,
            () => Temporal.Instant.fromEpochMilliseconds(now)
        );
        const port = createALWorkQueuePort({
            queue,
            workTypes: new Set(['AL_TEST']),
            leaseMs: 5_000,
            nowMs: () => now,
            random: () => 0.5
        });
        await port.retainIfAbsent(newWorkEntry('AL_TEST', 'w-1'));

        const [claim] = await port.claim({ maxCount: 4, observedEntries: undefined });
        expect(claim.attempts).toBe(1);
        expect(claim.leaseUntilMs).toBe(15_000);

        await port.release(claim, { status: 'not-ready', readyAtMs: now + 2_000 });
        const notReady = await port.readEntry(claim.entry.key);
        expect(notReady?.status).toBe(EntityStatus.RETRY);
        expect(notReady?.dequeueAudit.attempts).toBe(0);

        now += 2_000;
        const [second] = await port.claim({ maxCount: 4, observedEntries: undefined });
        await port.release(second, { status: 'retry' });
        const retried = await port.readEntry(second.entry.key);
        expect(retried?.status).toBe(EntityStatus.RETRY);
        expect(retried?.dequeueAudit.attempts).toBe(1);
    });

    it('completes and rejects work and tolerates a lost reservation', async () => {
        let now = 10_000;
        const queue = new InMemoryQueueBox(
            undefined,
            () => Temporal.Instant.fromEpochMilliseconds(now)
        );
        const port = createALWorkQueuePort({
            queue,
            workTypes: new Set(['AL_TEST']),
            leaseMs: 5_000,
            nowMs: () => now,
            random: () => 0.5
        });
        await port.retainIfAbsent(newWorkEntry('AL_TEST', 'w-2'));
        await port.retainIfAbsent(newWorkEntry('AL_TEST', 'w-3'));
        const claims = await port.claim({ maxCount: 4, observedEntries: undefined });

        await port.release(claims[0], { status: 'completed' });
        await port.release(claims[1], { status: 'non-retryable' });
        expect((await port.readEntry(claims[0].entry.key))?.status).toBe(EntityStatus.COMPLETED);
        expect((await port.readEntry(claims[1].entry.key))?.status).toBe(
            EntityStatus.NON_RETRYABLE
        );
        await expect(port.release(claims[0], { status: 'completed' })).resolves.toBeUndefined();
    });

    it('merges and caps readPage across every configured type, then resumes past a drained type', async () => {
        const now = 10_000;
        const queue = new InMemoryQueueBox(
            undefined,
            () => Temporal.Instant.fromEpochMilliseconds(now)
        );
        const port = createALWorkQueuePort({
            queue,
            workTypes: new Set(['AL_TEST_A', 'AL_TEST_B']),
            leaseMs: 5_000,
            nowMs: () => now,
            random: () => 0.5
        });
        await port.retainIfAbsent(newWorkEntry('AL_TEST_A', 'a-1'));
        await port.retainIfAbsent(newWorkEntry('AL_TEST_A', 'a-2'));
        await port.retainIfAbsent(newWorkEntry('AL_TEST_B', 'b-1'));
        await port.retainIfAbsent(newWorkEntry('AL_TEST_B', 'b-2'));

        const full = await port.readPage({ status: EntityStatus.NEW, maxToRead: 10, cursor: null });
        expect(full.entries).toHaveLength(4);
        expect(full.nextCursor).toBeNull();
        expect(full.entries.map((entry) => entry.typeId).sort()).toEqual([
            'AL_TEST_A',
            'AL_TEST_A',
            'AL_TEST_B',
            'AL_TEST_B'
        ]);

        const capped = await port.readPage({ status: EntityStatus.NEW, maxToRead: 3, cursor: null });
        expect(capped.entries).toHaveLength(3);
        expect(capped.entries.filter((entry) => entry.typeId === 'AL_TEST_A')).toHaveLength(2);
        expect(capped.entries.filter((entry) => entry.typeId === 'AL_TEST_B')).toHaveLength(1);
        expect(capped.nextCursor?.typeId).toBe('AL_TEST_B');

        const resumed = await port.readPage({
            status: EntityStatus.NEW,
            maxToRead: 3,
            cursor: capped.nextCursor
        });
        expect(resumed.entries).toHaveLength(1);
        expect(resumed.entries[0].typeId).toBe('AL_TEST_B');
        expect(resumed.nextCursor).toBeNull();
    });

    it('restarts readPage from the first type when the given cursor names a type no longer configured', async () => {
        const now = 10_000;
        const queue = new InMemoryQueueBox(
            undefined,
            () => Temporal.Instant.fromEpochMilliseconds(now)
        );
        const port = createALWorkQueuePort({
            queue,
            workTypes: new Set(['AL_TEST_A', 'AL_TEST_B']),
            leaseMs: 5_000,
            nowMs: () => now,
            random: () => 0.5
        });
        await port.retainIfAbsent(newWorkEntry('AL_TEST_A', 'a-1'));
        await port.retainIfAbsent(newWorkEntry('AL_TEST_B', 'b-1'));

        const staleCursor = { typeId: 'AL_TEST_RETIRED', status: EntityStatus.NEW, position: 'AL_TEST/ns/z' };
        const page = await port.readPage({ status: EntityStatus.NEW, maxToRead: 10, cursor: staleCursor });

        expect(page.entries).toHaveLength(2);
        expect(page.nextCursor).toBeNull();
    });
});
