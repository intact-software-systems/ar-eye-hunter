import { Temporal } from '@js-temporal/polyfill';
import { createLimitedALWorkLeaseRecovery } from '@shared/alm/work/al-work-lease-recovery.ts';
import { createALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import type { ALWorkClaim } from '@shared/alm/work/al-work-queue-port.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { IndexedDbQueueWriteConflictError } from '@shared/queuebox/indexed-db-queue-write-conflict-error.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import { newWorkEntry } from './al-work-test-entries.ts';

afterEach(() => {
    vi.restoreAllMocks();
});

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
            random: () => 0.5,
            leaseRecovery: { kind: 'every-batch' }
        });
        await port.retainIfAbsent(newWorkEntry('AL_TEST', 'w-1'));

        const [claim] = await port.claim({ maxCount: 4, observedEntries: undefined });
        expect(claim.attempts).toBe(1);
        expect(claim.leaseUntilMs).toBe(15_000);

        await port.releaseAll([{ claim: claim, outcome: { status: 'not-ready', readyAtMs: now + 2_000 } }]);
        const notReady = await port.readEntry(claim.entry.key);
        expect(notReady?.status).toBe(EntityStatus.RETRY);
        expect(notReady?.dequeueAudit.attempts).toBe(0);

        now += 2_000;
        const [second] = await port.claim({ maxCount: 4, observedEntries: undefined });
        await port.releaseAll([{ claim: second, outcome: { status: 'retry' } }]);
        const retried = await port.readEntry(second.entry.key);
        expect(retried?.status).toBe(EntityStatus.RETRY);
        expect(retried?.dequeueAudit.attempts).toBe(1);
    });

    it('leases from the reservation the queue stamped, not from the claiming clock', async () => {
        // 9_998.5 ms: behind the port's clock and sub-millisecond, so a JS-clock lease and a
        // truncating one both differ from the readiness a reserved row reports.
        const queueNow = Temporal.Instant.fromEpochNanoseconds(9_998_500_000n);
        const queue = new InMemoryQueueBox(undefined, () => queueNow);
        const port = createALWorkQueuePort({
            queue,
            workTypes: new Set(['AL_TEST']),
            leaseMs: 5_000,
            nowMs: () => 10_000,
            random: () => 0.5,
            leaseRecovery: { kind: 'every-batch' }
        });
        await port.retainIfAbsent(newWorkEntry('AL_TEST', 'w-lease'));

        const [claim] = await port.claim({ maxCount: 1, observedEntries: undefined });

        const startTs = claim.entry.dequeueAudit.startTs;
        expect(startTs?.epochNanoseconds).toBe(9_998_500_000n);
        expect(claim.leaseUntilMs).toBe(
            Number(startTs?.round({ smallestUnit: 'millisecond', roundingMode: 'ceil' }).epochMilliseconds) + 5_000
        );
        expect(claim.leaseUntilMs).toBe(14_999);
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
            random: () => 0.5,
            leaseRecovery: { kind: 'every-batch' }
        });
        await port.retainIfAbsent(newWorkEntry('AL_TEST', 'w-2'));
        await port.retainIfAbsent(newWorkEntry('AL_TEST', 'w-3'));
        const claims = await port.claim({ maxCount: 4, observedEntries: undefined });

        await port.releaseAll([{ claim: claims[0], outcome: { status: 'completed' } }]);
        await port.releaseAll([{ claim: claims[1], outcome: { status: 'non-retryable' } }]);
        expect((await port.readEntry(claims[0].entry.key))?.status).toBe(EntityStatus.COMPLETED);
        expect((await port.readEntry(claims[1].entry.key))?.status).toBe(
            EntityStatus.NON_RETRYABLE
        );
        await expect(port.releaseAll([{ claim: claims[0], outcome: { status: 'completed' } }])).resolves.toBeUndefined();
    });

    it('drops the one reservation another owner recovered and writes the rest of the batch', async () => {
        const now = 10_000;
        const queue = new InMemoryQueueBox(
            undefined,
            () => Temporal.Instant.fromEpochMilliseconds(now)
        );
        const port = createALWorkQueuePort({
            queue,
            workTypes: new Set(['AL_TEST']),
            leaseMs: 5_000,
            nowMs: () => now,
            random: () => 0.5,
            leaseRecovery: { kind: 'every-batch' }
        });
        for (const effectId of ['batch-first', 'batch-lost', 'batch-last']) {
            await port.retainIfAbsent(newWorkEntry('AL_TEST', effectId));
        }
        const claims = await port.claim({ maxCount: 3, observedEntries: undefined });
        const lost = claims[1];
        // Another owner recovers the middle reservation and finalizes it before this batch flushes.
        await queue.releaseEntries([{ entry: lost.entry, disposition: { status: EntityStatus.FAILED, delayMs: null } }]);

        await port.releaseAll(claims.map((claim) => ({ claim, outcome: { status: 'completed' } as const })));

        expect((await port.readEntry(claims[0].entry.key))?.status).toBe(EntityStatus.COMPLETED);
        expect((await port.readEntry(claims[2].entry.key))?.status).toBe(EntityStatus.COMPLETED);
        expect((await port.readEntry(lost.entry.key))?.status).toBe(EntityStatus.FAILED);
    });

    it('degrades a write-conflicting batch to serial releases and surfaces only that conflict', async () => {
        const now = 10_000;
        const queue = new InMemoryQueueBox(
            undefined,
            () => Temporal.Instant.fromEpochMilliseconds(now)
        );
        const port = createALWorkQueuePort({
            queue,
            workTypes: new Set(['AL_TEST']),
            leaseMs: 5_000,
            nowMs: () => now,
            random: () => 0.5,
            leaseRecovery: { kind: 'every-batch' }
        });
        for (const effectId of ['conflict-first', 'conflict-middle', 'conflict-last']) {
            await port.retainIfAbsent(newWorkEntry('AL_TEST', effectId));
        }
        const claims = byEffectId(await port.claim({ maxCount: 3, observedEntries: undefined }));
        const releaseEntries = queue.releaseEntries.bind(queue);
        const conflict = new IndexedDbQueueWriteConflictError('Queue row changed under the release');
        // The middle row's conditional write loses, which fails the batched attempt as a whole and
        // then fails again on its own serial attempt.
        vi.spyOn(queue, 'releaseEntries').mockImplementation(async (releases) => {
            if (
                releases.length > 1 ||
                releases.some((release) => release.entry.key.contextId === 'conflict-middle')
            ) {
                throw conflict;
            }
            return await releaseEntries(releases);
        });

        await expect(port.releaseAll([
            { claim: claims.get('conflict-first')!, outcome: { status: 'completed' } },
            { claim: claims.get('conflict-middle')!, outcome: { status: 'completed' } },
            { claim: claims.get('conflict-last')!, outcome: { status: 'completed' } }
        ])).rejects.toBe(conflict);

        expect((await port.readEntry(claims.get('conflict-first')!.entry.key))?.status)
            .toBe(EntityStatus.COMPLETED);
        expect((await port.readEntry(claims.get('conflict-last')!.entry.key))?.status)
            .toBe(EntityStatus.COMPLETED);
        expect((await port.readEntry(claims.get('conflict-middle')!.entry.key))?.status)
            .toBe(EntityStatus.RESERVED);
    });

    it('computes a batched retry delay per claim, exactly as a one-claim batch does', async () => {
        const now = 10_000;
        const queue = new InMemoryQueueBox(
            undefined,
            () => Temporal.Instant.fromEpochMilliseconds(now)
        );
        const port = createALWorkQueuePort({
            queue,
            workTypes: new Set(['AL_TEST']),
            leaseMs: 5_000,
            nowMs: () => now,
            random: () => 0.5,
            leaseRecovery: { kind: 'every-batch' }
        });
        for (const effectId of ['solo', 'batched', 'filler']) {
            const entry = newWorkEntry('AL_TEST', effectId);
            await port.retainIfAbsent({ ...entry, dequeueAudit: { ...entry.dequeueAudit, attempts: 1 } });
        }
        const claims = byEffectId(await port.claim({ maxCount: 3, observedEntries: undefined }));
        expect(claims.get('solo')!.attempts).toBe(2);

        await port.releaseAll([{ claim: claims.get('solo')!, outcome: { status: 'retry' } }]);
        await port.releaseAll([
            { claim: claims.get('batched')!, outcome: { status: 'retry' } },
            { claim: claims.get('filler')!, outcome: { status: 'completed' } }
        ]);

        const solo = await port.readEntry(claims.get('solo')!.entry.key);
        const batched = await port.readEntry(claims.get('batched')!.entry.key);
        expect(batched?.status).toBe(EntityStatus.RETRY);
        expect(toRetryDelayMs(batched!)).toBe(toRetryDelayMs(solo!));
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
            random: () => 0.5,
            leaseRecovery: { kind: 'every-batch' }
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
            random: () => 0.5,
            leaseRecovery: { kind: 'every-batch' }
        });
        await port.retainIfAbsent(newWorkEntry('AL_TEST_A', 'a-1'));
        await port.retainIfAbsent(newWorkEntry('AL_TEST_B', 'b-1'));

        const staleCursor = { typeId: 'AL_TEST_RETIRED', status: EntityStatus.NEW, position: 'AL_TEST/ns/z' };
        const page = await port.readPage({ status: EntityStatus.NEW, maxToRead: 10, cursor: staleCursor });

        expect(page.entries).toHaveLength(2);
        expect(page.nextCursor).toBeNull();
    });
});

describe('ALWorkQueuePort lease recovery', () => {
    it('sweeps for timed-out leases on its first claim, then at most once per lease of its own clock', async () => {
        let now = 10_000;
        const queue = new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(now));
        const port = createLimitedTestPort(queue, () => now);

        expect(await port.claim({ maxCount: 4, observedEntries: undefined })).toEqual([]);
        now += 5_000;
        await port.retainIfAbsent(newReservedWorkEntry('crashed', { startMs: now - 6_000, attempts: 1 }));
        expect(await port.claim({ maxCount: 4, observedEntries: undefined })).toEqual([]);
        // The limiter counts in quarter-window buckets: the first sweep closes the window for 1.25 leases.
        now = 10_000 + 6_250;
        expect(await port.claim({ maxCount: 4, observedEntries: undefined })).toEqual([]);
        now += 1;
        expect(toEffectIds(await port.claim({ maxCount: 4, observedEntries: undefined }))).toEqual(['crashed']);
    });

    it('spends no timeout allowance on a claim whose reservation filled the page', async () => {
        const now = 10_000;
        const queue = new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(now));
        const port = createLimitedTestPort(queue, () => now);
        await port.retainIfAbsent(newWorkEntry('AL_TEST', 'fills-the-page'));
        await port.retainIfAbsent(newReservedWorkEntry('crashed', { startMs: 0, attempts: 1 }));

        expect(toEffectIds(await port.claim({ maxCount: 1, observedEntries: undefined }))).toEqual(['fills-the-page']);
        // Still inside the first lease: only an allowance the first claim left unspent recovers the row.
        expect(toEffectIds(await port.claim({ maxCount: 1, observedEntries: undefined }))).toEqual(['crashed']);
    });

    it('finalizes exhausted reservations on its first batch, then at most once per lease of its own clock', async () => {
        let now = 10_000;
        const queue = new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(now));
        const port = createLimitedTestPort(queue, () => now);
        await port.retainIfAbsent(newReservedWorkEntry('exhausted-first', { startMs: 0, attempts: 20 }));

        const finalized = await port.finalizeExhausted(4);
        expect(toEffectIds(finalized)).toEqual(['exhausted-first']);
        await port.releaseAll(finalized.map((claim) => ({ claim, outcome: { status: 'non-retryable' } as const })));
        await port.retainIfAbsent(newReservedWorkEntry('exhausted-second', { startMs: 0, attempts: 20 }));
        expect(await port.finalizeExhausted(4)).toEqual([]);
        now = 10_000 + 6_251;
        expect(toEffectIds(await port.finalizeExhausted(4))).toEqual(['exhausted-second']);
    });

    it('keeps claiming and sweeping when its clock steps back behind the limiters it built', async () => {
        let now = 10_000;
        const queue = new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(now));
        const port = createLimitedTestPort(queue, () => now);
        now = 8_000;
        await port.retainIfAbsent(newWorkEntry('AL_TEST', 'after-the-step'));
        await port.retainIfAbsent(newReservedWorkEntry('crashed', { startMs: 0, attempts: 1 }));

        expect(await port.finalizeExhausted(4)).toEqual([]);
        expect(toEffectIds(await port.claim({ maxCount: 4, observedEntries: undefined }))).toEqual([
            'after-the-step',
            'crashed'
        ]);
    });

    it('sweeps on every claim and every batch when configured to', async () => {
        const now = 10_000;
        const queue = new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(now));
        const port = createALWorkQueuePort({
            queue,
            workTypes: new Set(['AL_TEST']),
            leaseMs: 5_000,
            nowMs: () => now,
            random: () => 0.5,
            leaseRecovery: { kind: 'every-batch' }
        });

        for (let batch = 0; batch < 3; batch += 1) {
            await port.retainIfAbsent(newReservedWorkEntry(`exhausted-${batch}`, { startMs: 0, attempts: 20 }));
            await port.retainIfAbsent(newReservedWorkEntry(`crashed-${batch}`, { startMs: 0, attempts: 1 }));
            expect(toEffectIds(await port.finalizeExhausted(4))).toEqual([`exhausted-${batch}`]);
            expect(toEffectIds(await port.claim({ maxCount: 4, observedEntries: undefined }))).toEqual([`crashed-${batch}`]);
        }
    });
});

function createLimitedTestPort(queue: InMemoryQueueBox, nowMs: () => number) {
    return createALWorkQueuePort({
        queue,
        workTypes: new Set(['AL_TEST']),
        leaseMs: 5_000,
        nowMs,
        random: () => 0.5,
        leaseRecovery: createLimitedALWorkLeaseRecovery(5_000, nowMs())
    });
}

/** A reservation an owner took at `startMs` and never released, as a crashed owner leaves it. */
function newReservedWorkEntry(effectId: string, input: { startMs: number; attempts: number; }): ResourceEntry {
    const entry = newWorkEntry('AL_TEST', effectId);
    return {
        ...entry,
        status: EntityStatus.RESERVED,
        dequeueAudit: {
            ...entry.dequeueAudit,
            attempts: input.attempts,
            startTs: Temporal.Instant.fromEpochMilliseconds(input.startMs)
        }
    };
}

function toEffectIds(claims: readonly ALWorkClaim[]): string[] {
    return claims.map((claim) => claim.entry.key.contextId);
}

function byEffectId(claims: readonly ALWorkClaim[]): Map<string, ALWorkClaim> {
    return new Map(claims.map((claim) => [claim.entry.key.contextId, claim]));
}

function toRetryDelayMs(entry: ResourceEntry): number {
    return entry.dequeueAudit.endTs!.until(entry.dequeueAudit.nextTs!).total({ unit: 'milliseconds' });
}
