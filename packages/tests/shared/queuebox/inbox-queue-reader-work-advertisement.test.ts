import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { newALRoute, newALUntargetedMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { hasAdvertisedDequeueWork, Reservator } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import type { DequeueResourceEntryOptions } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type { ResourceInboxAttempt } from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { createQueueMessage, createQueueResilience, seedRetry } from '../app-inbox/fair-service-fixture.ts';

interface ObservedReader {
    readonly queue: InMemoryQueueBox;
    readonly reader: InboxQueueReader;
    readonly events: string[];
    readonly claimed: ResourceInboxAttempt[];
    advanceNow(milliseconds: number): void;
}

describe('InboxQueueReader work advertisement', () => {
    it('claims a new command on the NEW lane after a probe that advertised only that lane', async () => {
        const observed = createObservedReader();
        await observed.reader.enqueueIfAbsent(createQueueMessage('fresh'));
        const resilience = createQueueResilience();

        const advertisedLanes = await observed.reader.readWorkAdvertisement(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience);
        expect(advertisedLanes).toEqual({ FINALIZATION: false, NEW: true, RETRY: false, FAIRNESS: false, TIMEOUT: false });
        expect(await observed.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience, advertisedLanes)).toBe(1);

        expect(observed.claimed.map((attempt) => [attempt.entry.key.resourceId, attempt.telemetry.selectedLane])).toEqual([['fresh', Reservator.NEW]]);
        expect(observed.events).toEqual([
            'probe-started',
            'probe-finished:NEW',
            'pass-started',
            'handler-started:fresh',
            'handler-finished:fresh',
            'pass-finished'
        ]);
    });

    it('claims an overdue retry on the FAIRNESS lane and a due retry on the RETRY lane', async () => {
        const observed = createObservedReader();
        await seedRetry(observed.queue, 'overdue');
        observed.advanceNow(31_000);
        await seedRetry(observed.queue, 'due');
        observed.advanceNow(2);
        const resilience = createQueueResilience();

        const advertisedLanes = await observed.reader.readWorkAdvertisement(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience);
        expect(advertisedLanes).toEqual({ FINALIZATION: false, NEW: false, RETRY: true, FAIRNESS: true, TIMEOUT: false });
        expect(await observed.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience, advertisedLanes)).toBe(2);

        expect(observed.claimed.map((attempt) => [attempt.entry.key.resourceId, attempt.telemetry.selectedLane]))
            .toEqual([['overdue', Reservator.FAIRNESS], ['due', Reservator.RETRY]]);
    });

    it('claims an overdue retry on the FAIRNESS lane on every pass, probed or not, with no selection limiter in play', async () => {
        const observed = createObservedReader();
        const resilience = createQueueResilience();
        const passes = ResourceInboxResilience.MAX_NUM_DEQUEUE_IN_WINDOW + 1;

        for (let pass = 0; pass < passes; pass += 1) {
            await seedOverdueRetry(observed, `overdue-${pass}`);
            const advertisedLanes = pass % 2 === 0
                ? await observed.reader.readWorkAdvertisement(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience)
                : undefined;
            expect(await observed.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience, advertisedLanes)).toBe(1);
        }

        expect(observed.claimed.map((attempt) => attempt.telemetry.selectedLane)).toEqual(Array(passes).fill(Reservator.FAIRNESS));
        expect(observed.claimed.every((attempt) => attempt.telemetry.dueAgeMs >= 30_000)).toBe(true);
    });

    it('recovers every timed-out reservation within as many passes as there are reservations, then idles', async () => {
        const observed = createObservedReader();
        const resilience = createQueueResilience();
        await seedReservations(observed, 5);
        observed.advanceNow(resilience.reservationLeaseMs + 1);

        const recovered = await runPasses(observed, resilience, 5);

        expect(recovered.lanesPerPass).toEqual(['TIMEOUT', 'TIMEOUT', 'TIMEOUT', 'TIMEOUT', 'TIMEOUT']);
        expect(observed.claimed.map((attempt) => attempt.telemetry.selectedLane)).toEqual(Array(5).fill(Reservator.TIMEOUT));
        expect(hasAdvertisedDequeueWork(await observed.reader.readWorkAdvertisement(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience))).toBe(false);
    });

    it('finalizes every stale exhausted reservation within as many passes as there are reservations, then idles', async () => {
        const finalized: string[] = [];
        const queueHolder: { queue?: ObservedReader['queue']; } = {};
        const observed = createObservedReader({
            onRetryExhaustionRecovery: async (recovery) => {
                finalized.push(recovery.entry.key.resourceId);
                const [failed] = (await queueHolder.queue!.releaseEntries([
                    { entry: recovery.entry, disposition: { status: EntityStatus.FAILED, delayMs: null } }
                ])).values();
                return failed;
            }
        });
        queueHolder.queue = observed.queue;
        const resilience = createQueueResilience(1);
        await seedReservations(observed, 5);
        observed.advanceNow(ResourceInboxResilience.FINALIZATION_STALE_AFTER_MS + 1);

        const recovered = await runPasses(observed, resilience, 5);

        expect(recovered.lanesPerPass).toEqual(Array(5).fill('FINALIZATION'));
        expect(finalized).toHaveLength(5);
        expect(hasAdvertisedDequeueWork(await observed.reader.readWorkAdvertisement(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience))).toBe(false);
    });

    it('refuses a second dequeue-pass observer: the reader owner installs the one observer', () => {
        const observed = createObservedReader();

        expect(() =>
            observed.reader.onDequeuePassDo({
                onProbeStarted: () => undefined,
                onProbeFinished: () => undefined,
                onPassStarted: () => undefined,
                onPassFinished: () => undefined,
                onEntryClaimed: () => undefined,
                onHandlerStarted: () => undefined,
                onHandlerFinished: () => undefined
            })
        ).toThrow('A dequeue-pass observer is already installed on this queue reader');
    });

    it('advertises nothing for an empty queue and runs no pass for it', async () => {
        const observed = createObservedReader();

        const advertisedLanes = await observed.reader.readWorkAdvertisement(InboxQueueReader.INBOX_DEQUEUE_TYPES, createQueueResilience());

        expect(hasAdvertisedDequeueWork(advertisedLanes)).toBe(false);
        expect(observed.events).toEqual(['probe-started', 'probe-finished:']);
    });

    it('lets the outbox reader probe and dequeue by the same advertisement without an observer', async () => {
        const queue = new InMemoryQueueBox();
        const reader = new OutboxQueueReader(queue);
        const delivered: string[] = [];
        reader.onOutboxMessageDo('test.fair-service', { onMessage: async (message) => void delivered.push(message.route.resourceId) });
        await reader.enqueueIfAbsent(createQueueMessage('outbound'));
        const resilience = createQueueResilience();

        const advertisedLanes = await reader.readWorkAdvertisement(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, resilience);
        expect(advertisedLanes.NEW).toBe(true);
        expect(await reader.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, resilience, advertisedLanes)).toBe(1);
        expect(delivered).toEqual(['outbound']);
    });
});

function createObservedReader(dequeueOptions: DequeueResourceEntryOptions = {}): ObservedReader {
    let now = Temporal.Now.instant();
    const queue = new InMemoryQueueBox(new Map(), () => now);
    const reader = new InboxQueueReader(queue, {
        ...dequeueOptions,
        laneBudgetPolicy: 'adaptive-retry',
        newLaneConcurrency: 1,
        nowEpochMs: () => Number(now.epochMilliseconds)
    });
    const events: string[] = [];
    const claimed: ResourceInboxAttempt[] = [];
    reader.onDequeuePassDo({
        onProbeStarted: () => void events.push('probe-started'),
        onProbeFinished: (advertisedLanes) => void events.push(`probe-finished:${Object.values(Reservator).filter((lane) => advertisedLanes[lane]).join(',')}`),
        onPassStarted: () => void events.push('pass-started'),
        onEntryClaimed: () => undefined,
        onHandlerStarted: (attempt) => {
            claimed.push(attempt);
            events.push(`handler-started:${attempt.entry.key.resourceId}`);
        },
        onHandlerFinished: (attempt) => void events.push(`handler-finished:${attempt.entry.key.resourceId}`),
        onPassFinished: () => void events.push('pass-finished')
    });
    reader.onInboxMessageDo('test.fair-service', { onMessage: async () => undefined });
    return {
        queue,
        reader,
        events,
        claimed,
        advanceNow: (milliseconds) => {
            now = now.add({ milliseconds });
        }
    };
}

/** A command that outlives the lease, the stale-finalization window and a run of overdue passes: an expired row is never claimed. */
function createLongLivedQueueMessage(resourceId: string): ALMessage {
    return newALUntargetedMessage(
        'api-v1',
        newALRoute('app-inbox.fair-service', 'test-scope', resourceId),
        'test.fair-service',
        { resourceId },
        { ttlMs: 3_600_000 }
    );
}

async function seedReservations(observed: ObservedReader, count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
        await observed.reader.enqueueIfAbsent(createLongLivedQueueMessage(`reserved-${index}`));
    }
    const reserved = await observed.queue.reserveEntries({
        typeIds: new Set([EnqueuedType.APP_INBOX]),
        statusIds: new Set([EntityStatus.NEW]),
        reservationInput: count
    });
    expect(reserved.size).toBe(count);
}

/** Probe then pass, as the engine does, once per requested pass; the lanes each probe advertised. */
async function runPasses(
    observed: ObservedReader,
    resilience: ResourceInboxResilience,
    passes: number
): Promise<{ lanesPerPass: string[]; }> {
    const lanesPerPass: string[] = [];
    for (let pass = 0; pass < passes; pass += 1) {
        const advertisedLanes = await observed.reader.readWorkAdvertisement(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience);
        lanesPerPass.push(Object.values(Reservator).filter((lane) => advertisedLanes[lane]).join(','));
        await observed.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience, advertisedLanes);
    }
    return { lanesPerPass };
}

/** One retry whose due time is past the overdue threshold on the queue's clock after this call. */
async function seedOverdueRetry(observed: ObservedReader, resourceId: string): Promise<void> {
    const entry = await observed.reader.enqueueIfAbsent(createLongLivedQueueMessage(resourceId));
    const [claimed] = (await observed.queue.reserveEntries({
        typeIds: new Set([EnqueuedType.APP_INBOX]),
        statusIds: new Set([EntityStatus.NEW]),
        reservationInput: 1,
        observedEntries: [await observed.queue.getItem(entry.key) ?? entry]
    })).values();
    expect(claimed?.key.resourceId).toBe(resourceId);
    await observed.queue.releaseEntries([{ entry: claimed!, disposition: { status: EntityStatus.RETRY, delayMs: 1 } }]);
    observed.advanceNow(31_000);
}
