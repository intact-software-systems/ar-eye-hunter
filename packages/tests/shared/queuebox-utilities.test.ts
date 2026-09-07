import { Temporal } from '@js-temporal/polyfill';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { NotReadyException } from '@shared/queuebox/resource-inbox/not-ready-exception.ts';
import type { ResourceInboxAttemptReleaseTelemetry } from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { EntityStatus, NEVER_EXPIRE_TS, toResourceEntry, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { SlidingWindowCounter } from '@shared/resilience/Resilience.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('QueueBoxUtilities', () => {
    it('keeps readiness neutral for processing attempts, adaptive controls, and release telemetry', async () => {
        const errors: string[] = [];
        vi.spyOn(console, 'error').mockImplementation((message) => {
            errors.push(String(message));
        });
        const duration = Temporal.Duration.from({ seconds: 10 });
        const resilience = ResourceInboxResilience.createDefault({
            circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
            initialRate: 2,
            maxRate: 10,
            concurrencyIncreaseStep: 1,
            concurrencyReduceStep: 1
        });
        const queue = new InMemoryQueueBox();
        const entry = toResourceEntry('waiting', { ok: true });
        await queue.enqueue(entry);
        const events: ResourceInboxAttemptReleaseTelemetry[] = [];
        await QueueBoxUtilities.defaultDequeue({
            qbox: queue,
            typesToDequeue: new Set(['waiting']),
            resilience,
            onDequeuedDo: async () => {
                throw new NotReadyException(1_000);
            },
            options: { onAttemptReleaseTelemetry: (event) => events.push(event) }
        });
        expect((await queue.getItem(entry.key))?.dequeueAudit.attempts).toBe(0);
        expect(SlidingWindowCounter.sumInWindowWithNow(resilience.rateAdjuster.slidingWindow, Date.now())).toBe(0);
        expect(SlidingWindowCounter.sumInWindowWithNow(resilience.circuitBreaker.slidingWindow, Date.now())).toBe(0);
        expect(events).toEqual([expect.objectContaining({ attempt: 0, classification: 'not-ready', retryDelayMs: 1_000, failure: { kind: 'none' } })]);
        expect(errors).toEqual([]);
    });
    it('retains actual failure accounting alongside neutral readiness and successful work', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const duration = Temporal.Duration.from({ seconds: 10 });
        const resilience = ResourceInboxResilience.createDefault({
            circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
            initialRate: 2,
            maxRate: 10,
            concurrencyIncreaseStep: 1,
            concurrencyReduceStep: 1
        });
        const failure = vi.spyOn(resilience, 'failure');
        const success = vi.spyOn(resilience, 'success');
        const queue = new InMemoryQueueBox();
        const waiting = toResourceEntry('waiting', {});
        const broken = toResourceEntry('broken', {});
        const working = toResourceEntry('working', {});
        for (const entry of [waiting, broken, working]) {
            await queue.enqueue(entry);
        }
        await QueueBoxUtilities.defaultDequeue({
            qbox: queue,
            typesToDequeue: new Set(['waiting', 'broken', 'working']),
            resilience,
            onDequeuedDo: async (entry) => {
                if (entry.typeId === 'waiting') {
                    throw new NotReadyException(1_000);
                }
                if (entry.typeId === 'broken') {
                    throw new Error('actual failure');
                }
            },
            options: { jitterUnit: () => 0.5 }
        });
        expect(failure).toHaveBeenCalledTimes(1);
        expect(success).toHaveBeenCalledTimes(1);
        expect((await queue.getItem(waiting.key))?.dequeueAudit.attempts).toBe(0);
        expect((await queue.getItem(broken.key))?.dequeueAudit.attempts).toBe(1);
        expect((await queue.getItem(working.key))?.status).toBe(EntityStatus.COMPLETED);
    });

    it.each([0, -1, NaN, Infinity, 1.5])('rejects malformed readiness delay %s as nonretryable', async (delayMs) => {
        const duration = Temporal.Duration.from({ seconds: 10 });
        const resilience = ResourceInboxResilience.createDefault({
            circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
            initialRate: 2,
            maxRate: 10,
            concurrencyIncreaseStep: 1,
            concurrencyReduceStep: 1
        });
        const queue = new InMemoryQueueBox();
        const entry = toResourceEntry('waiting', {});
        await queue.enqueue(entry);
        await QueueBoxUtilities.defaultDequeue({
            qbox: queue,
            typesToDequeue: new Set(['waiting']),
            resilience,
            onDequeuedDo: async () => {
                throw new NotReadyException(delayMs);
            },
            options: {}
        });
        expect((await queue.getItem(entry.key))?.status).toBe(EntityStatus.NON_RETRYABLE);
        expect((await queue.getItem(entry.key))?.dequeueAudit.attempts).toBe(1);
    });

    it('exhausts the unchanged processing budget only after failures following repeated readiness', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const duration = Temporal.Duration.from({ seconds: 10 });
        const resilience = ResourceInboxResilience.createDefault({
            circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
            initialRate: 2,
            maxRate: 10,
            concurrencyIncreaseStep: 1,
            concurrencyReduceStep: 1,
            retryPolicy: { ...DEFAULT_RESOURCE_INBOX_RETRY_POLICY, maxAttempts: 2 }
        });
        const queue = new InMemoryQueueBox();
        const entry = toResourceEntry('waiting', {});
        await queue.enqueue(entry);
        const attempts: number[] = [];
        let ready = false;
        const process = async () => {
            await QueueBoxUtilities.defaultDequeue({
                qbox: queue,
                typesToDequeue: new Set(['waiting']),
                resilience,
                onDequeuedDo: async () => {
                    if (!ready) {
                        throw new NotReadyException(1_000);
                    }
                    throw new Error('Actual processing failed');
                },
                options: { jitterUnit: () => 0.5, onAttemptReleaseTelemetry: (event) => attempts.push(event.attempt) }
            });
        };
        for (let cycle = 0; cycle < 3; cycle += 1) {
            await process();
            vi.setSystemTime((await queue.getItem(entry.key))!.dequeueAudit.nextTs!.epochMilliseconds + 1);
        }
        ready = true;
        await process();
        expect((await queue.getItem(entry.key))?.status).toBe(EntityStatus.RETRY);
        vi.setSystemTime((await queue.getItem(entry.key))!.dequeueAudit.nextTs!.epochMilliseconds + 1);
        await process();
        expect((await queue.getItem(entry.key))?.status).toBe(EntityStatus.FAILED);
        expect((await queue.getItem(entry.key))?.dequeueAudit.attempts).toBe(2);
        expect(attempts).toEqual([0, 0, 0, 1, 2]);
    });

    it('does not manufacture adaptive successes when the queue has no work', async () => {
        const duration = Temporal.Duration.from({ seconds: 10 });
        const resilience = ResourceInboxResilience.createDefault({
            circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
            initialRate: 2,
            maxRate: 10,
            concurrencyIncreaseStep: 1,
            concurrencyReduceStep: 1
        });
        await QueueBoxUtilities.defaultDequeue({
            qbox: new InMemoryQueueBox(),
            typesToDequeue: new Set(['waiting']),
            resilience,
            onDequeuedDo: async () => {
                throw new Error('Empty queue must not deliver work');
            },
            options: {}
        });
        expect(SlidingWindowCounter.sumInWindowWithNow(resilience.rateAdjuster.slidingWindow, Date.now())).toBe(0);
        expect(resilience.rateAdjuster.status.get().rate).toBe(2);
    });
    it('maps AL messages to resource entries using the route as the queue key', () => {
        const expiresAtMs = Date.UTC(2026, 0, 1, 0, 0, 30);
        const msg = {
            ...newALUnicastMessage(
                'sender-1',
                {
                    topicId: 'chat',
                    resourceId: 'msg-1',
                    contextId: 'conversation-1'
                },
                'peer-1',
                'chat.private-text.v1',
                {
                    text: 'hello'
                },
                { ttlMs: 30_000 }
            ),
            constraints: {
                expiresAtMs
            },
            audit: {
                createdBy: 'alice',
                createdTs: 123
            }
        };

        const entry = QueueBoxUtilities.toResourceEntryFromMsg(msg, 'ws.outbox');

        expect(entry.key).toEqual(msg.route);
        expect(entry.typeId).toBe('ws.outbox');
        expect(entry.audit.createdBy).toBe('alice');
        expect(entry.audit.expiryTs.epochMilliseconds).toBe(expiresAtMs);
        expect(JSON.parse(entry.resource)).toMatchObject({
            id: {
                msgId: msg.id.msgId
            },
            route: msg.route
        });
    });

    it('preserves an absent message deadline without turning queue retention into a delivery TTL', () => {
        const msg = newALUnicastMessage('sender', { topicId: 'chat', contextId: 'room', resourceId: 'message' }, 'peer', 'chat.v1', {});
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox');
        expect(entry.audit.expiryTs.equals(NEVER_EXPIRE_TS)).toBe(true);
        expect(JSON.parse(entry.resource)).not.toHaveProperty('constraints');
    });

    it.each([
        { callerTtlMs: 500, expectedTtlMs: 500 },
        { callerTtlMs: 2_000, expectedTtlMs: 1_000 }
    ])('preserves the earliest caller/freshness bound when caller TTL is $callerTtlMs', ({ callerTtlMs, expectedTtlMs }) => {
        const msg: ALMessage = Object.freeze({
            ...newALUnicastMessage('sender', { topicId: 'chat', contextId: 'room', resourceId: 'message' }, 'peer', 'chat.v1', {}, { ttlMs: callerTtlMs }),
            qos: Object.freeze({ expiry: Object.freeze({ algo: 'fresh-until', opts: Object.freeze({ maxStalenessMs: 1_000 }) }) })
        });
        const serialized = JSON.stringify(msg);
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox');
        expect(entry.audit.expiryTs.epochMilliseconds).toBe(msg.id.ts + expectedTtlMs);
        expect(entry.resource).toBe(serialized);
        expect(JSON.stringify(msg)).toBe(serialized);
    });

    it('short-circuits defaultDequeue when resilience blocks dequeuing', async () => {
        const warnings: string[] = [];
        const warn = vi.spyOn(console, 'warn').mockImplementation((message) => {
            warnings.push(String(message));
        });

        try {
            const queue = new InMemoryQueueBox();
            const entry = toResourceEntry('demo', { ok: true });
            const dequeuedEntries: ResourceEntry[] = [];
            const onDequeued = async (dequeued: ResourceEntry) => {
                dequeuedEntries.push(dequeued);
            };

            await queue.enqueue(entry);
            const duration = Temporal.Duration.from({ seconds: 10 });
            const resilience = ResourceInboxResilience.createDefault({
                circuitBreakerPolicy: new CircuitBreakerPolicy(1, duration, duration, duration),
                initialRate: 1,
                maxRate: 1,
                concurrencyIncreaseStep: 1,
                concurrencyReduceStep: 1
            });
            resilience.circuitBreaker.failureCount(2);

            await QueueBoxUtilities.defaultDequeue(
                { qbox: queue, typesToDequeue: new Set(['demo']), resilience: resilience, onDequeuedDo: onDequeued, options: {} }
            );

            expect(dequeuedEntries).toEqual([]);
            expect(warnings).toHaveLength(1);
        }
        finally {
            warn.mockRestore();
        }
    });
});
