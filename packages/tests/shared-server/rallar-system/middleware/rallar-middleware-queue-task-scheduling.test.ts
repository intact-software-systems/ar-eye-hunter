import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { registerApplicationQueueReaderTasks } from '@shared-server/rallar-system/middleware/rallar-middleware-queue-registration.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import type {
    ResourceInboxReservationObservationRequest,
    ResourceInboxReservationObservationResult,
    ResourceInboxReservationRequest
} from '@shared/queuebox/queue-box-types.ts';
import type { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { createQueueMessage, createQueueResilience } from '../../../shared/app-inbox/fair-service-fixture.ts';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

interface QueueTaskSchedulingHarness {
    readonly engine: InboxOutboxEngine;
    readonly queue: InMemoryQueueBox;
    readonly reader: InboxQueueReader;
    readonly startedAtMs: number;
    readonly failures: string[];
}

function createQueueTaskSchedulingHarness(
    queue: InMemoryQueueBox,
    appInboxResilience: ResourceInboxResilience = createQueueResilience()
): QueueTaskSchedulingHarness {
    const failures: string[] = [];
    const startedAtMs = Date.now();
    const engine = new InboxOutboxEngine({
        nowEpochMs: () => Date.now(),
        random: () => 0.5,
        reportTaskFailure: (taskId, error) => {
            failures.push(`${taskId}@${Date.now() - startedAtMs}: ${error.message}`);
            return undefined;
        }
    });
    const reader = new InboxQueueReader(queue, { laneBudgetPolicy: 'adaptive-retry', newLaneConcurrency: 1, nowEpochMs: () => Date.now() });
    registerApplicationQueueReaderTasks({
        engine,
        nowEpochMs: () => Date.now(),
        inboxQueueReader: reader,
        outboxQueueReader: new OutboxQueueReader(new InMemoryQueueBox()),
        appInboxResilience,
        appOutboxResilience: createQueueResilience()
    });
    return { engine, queue, reader, startedAtMs, failures };
}

async function stopEngine(engine: InboxOutboxEngine): Promise<void> {
    const stopped = engine.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    await stopped;
}

function createFakeClockQueue(): InMemoryQueueBox {
    return new InMemoryQueueBox(new Map(), () => Temporal.Instant.fromEpochMilliseconds(Date.now()));
}

class ProbedQueueBox extends InMemoryQueueBox {
    probes = 0;
    failProbes = false;
    failNextReservation = false;

    constructor() {
        super(new Map(), () => Temporal.Instant.fromEpochMilliseconds(Date.now()));
    }

    override async readWorkAdvertisement(
        ...input: Parameters<InMemoryQueueBox['readWorkAdvertisement']>
    ): ReturnType<InMemoryQueueBox['readWorkAdvertisement']> {
        this.probes += 1;
        if (this.failProbes) {
            throw new Error('Readiness probe unavailable');
        }
        return await super.readWorkAdvertisement(...input);
    }

    override reserveEntries(request: ResourceInboxReservationObservationRequest): Promise<ResourceInboxReservationObservationResult>;
    override reserveEntries(request: ResourceInboxReservationRequest): Promise<Map<Key, ResourceEntry>>;
    override async reserveEntries(
        request: ResourceInboxReservationRequest | ResourceInboxReservationObservationRequest
    ): Promise<Map<Key, ResourceEntry> | ResourceInboxReservationObservationResult> {
        if (this.failNextReservation) {
            this.failNextReservation = false;
            throw new Error('Reservation transport unavailable');
        }
        return 'reservationObservation' in request ? await super.reserveEntries(request) : await super.reserveEntries(request);
    }
}

describe('registered AppInbox queue task scheduling', () => {
    it('claims the next command as soon as a long batch that claimed work settles', async () => {
        vi.useFakeTimers();
        const harness = createQueueTaskSchedulingHarness(createFakeClockQueue());
        await harness.reader.enqueueIfAbsent(createQueueMessage('first'));
        await harness.reader.enqueueIfAbsent(createQueueMessage('second'));
        const handlerStartsMs: number[] = [];
        harness.reader.onInboxMessageDo('test.fair-service', {
            onMessage: async () => {
                handlerStartsMs.push(Date.now() - harness.startedAtMs);
                await new Promise((resolve) => setTimeout(resolve, 1_000));
            }
        });

        harness.engine.start();
        try {
            await vi.advanceTimersByTimeAsync(3_000);
            // One zero-delay engine pass separates the settled batch from the next claim.
            expect(handlerStartsMs).toEqual([0, expect.any(Number)]);
            expect(handlerStartsMs[1]).toBeGreaterThanOrEqual(1_000);
            expect(handlerStartsMs[1]).toBeLessThanOrEqual(1_001);
            expect(harness.failures).toEqual([]);
        }
        finally {
            await stopEngine(harness.engine);
        }
    });

    it('advertises no work while its circuit is open and claims at the instant the circuit lets dequeue through', async () => {
        vi.useFakeTimers();
        const resilience = createQueueResilience();
        for (let failure = 0; failure < 11; failure += 1) {
            resilience.failure();
        }
        expect(resilience.isNotAllowedThroughToDequeue()).toBe(true);
        const queue = new ProbedQueueBox();
        const harness = createQueueTaskSchedulingHarness(queue, resilience);
        await harness.reader.enqueueIfAbsent(createQueueMessage('after-reopen'));
        const deliveredAtMs: number[] = [];
        harness.reader.onInboxMessageDo('test.fair-service', {
            onMessage: async () => {
                deliveredAtMs.push(Date.now() - harness.startedAtMs);
            }
        });

        harness.engine.start();
        try {
            await vi.advanceTimersByTimeAsync(9_999);
            expect(queue.probes).toBe(0);
            expect(deliveredAtMs).toEqual([]);
            await vi.advanceTimersByTimeAsync(2);
            expect(deliveredAtMs).toEqual([10_001]);
        }
        finally {
            await stopEngine(harness.engine);
        }
    });

    it('releases its slot after a failed reservation and claims again when the failure backoff elapses', async () => {
        vi.useFakeTimers();
        const queue = new ProbedQueueBox();
        const harness = createQueueTaskSchedulingHarness(queue);
        await harness.reader.enqueueIfAbsent(createQueueMessage('after-failure'));
        const deliveredAtMs: number[] = [];
        harness.reader.onInboxMessageDo('test.fair-service', {
            onMessage: async () => {
                deliveredAtMs.push(Date.now() - harness.startedAtMs);
            }
        });
        queue.failNextReservation = true;
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        harness.engine.start();
        try {
            await vi.advanceTimersByTimeAsync(1);
            expect(harness.failures).toEqual(['APP_INBOX@0: Reservation transport unavailable']);
            const probesAfterFailure = queue.probes;
            await vi.advanceTimersByTimeAsync(998);
            expect(queue.probes).toBe(probesAfterFailure);
            expect(deliveredAtMs).toEqual([]);
            await vi.advanceTimersByTimeAsync(2);
            expect(deliveredAtMs).toEqual([1_000]);
        }
        finally {
            await stopEngine(harness.engine);
        }
    });

    it('probes a failing readiness check once per failure backoff step while a sibling task keeps the engine busy', async () => {
        vi.useFakeTimers();
        const queue = new ProbedQueueBox();
        queue.failProbes = true;
        const harness = createQueueTaskSchedulingHarness(queue);
        harness.engine.includeTask('busy-sibling', {
            name: 'busy-sibling',
            maxConcurrency: () => 1,
            isWork: async () => true,
            runnable: async () => {},
            ongoingTasks: []
        });

        harness.engine.start();
        try {
            await vi.advanceTimersByTimeAsync(7_500);
            expect(queue.probes).toBe(4);
            expect(harness.failures.filter((failure) => failure.startsWith('APP_INBOX@'))).toHaveLength(4);
        }
        finally {
            await stopEngine(harness.engine);
        }
    });
});
