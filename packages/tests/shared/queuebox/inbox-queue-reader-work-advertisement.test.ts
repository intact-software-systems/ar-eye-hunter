import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { hasAdvertisedDequeueWork, Reservator } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import type { ResourceInboxAttempt } from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
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

    it('claims an overdue retry on the FAIRNESS lane after a probe even when the fairness selection limiter is exhausted', async () => {
        const observed = createObservedReader();
        await seedRetry(observed.queue, 'overdue');
        observed.advanceNow(31_000);
        const resilience = createQueueResilience();
        while (resilience.checkFairness.lockEntryRateLimiter.allow()) {
            continue;
        }

        const advertisedLanes = await observed.reader.readWorkAdvertisement(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience);
        expect(await observed.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience, advertisedLanes)).toBe(1);

        expect(observed.claimed.map((attempt) => [attempt.entry.key.resourceId, attempt.telemetry.selectedLane]))
            .toEqual([['overdue', Reservator.FAIRNESS]]);
        expect(observed.claimed[0]?.telemetry.dueAgeMs).toBeGreaterThanOrEqual(30_000);
    });

    it('lets the exhausted limiter hold the overdue scan only for a pass that no probe preceded', async () => {
        const observed = createObservedReader();
        await seedRetry(observed.queue, 'overdue');
        observed.advanceNow(31_000);
        const resilience = createQueueResilience();
        while (resilience.checkFairness.lockEntryRateLimiter.allow()) {
            continue;
        }

        expect(await observed.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience)).toBe(1);

        expect(observed.claimed.map((attempt) => [attempt.entry.key.resourceId, attempt.telemetry.selectedLane]))
            .toEqual([['overdue', Reservator.RETRY]]);
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

function createObservedReader(): ObservedReader {
    let now = Temporal.Now.instant();
    const queue = new InMemoryQueueBox(new Map(), () => now);
    const reader = new InboxQueueReader(queue, { nowEpochMs: () => Number(now.epochMilliseconds) });
    const events: string[] = [];
    const claimed: ResourceInboxAttempt[] = [];
    reader.onDequeuePassDo({
        onProbeStarted: () => void events.push('probe-started'),
        onProbeFinished: (advertisedLanes) => void events.push(`probe-finished:${Object.values(Reservator).filter((lane) => advertisedLanes[lane]).join(',')}`),
        onPassStarted: () => void events.push('pass-started'),
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
