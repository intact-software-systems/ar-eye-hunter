import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import {
    createRegisteredHandlerHarness,
    createResilience
} from '../test-support/app-inbox-transaction-test-runtime.ts';

describe('AppInbox conflict redelivery', () => {
    it.each(['conflict', 'transient'] as const)('re-enters the handler on fresh state with bounded %s backoff', async (failure) => {
        let now = Temporal.Instant.from('2026-07-22T12:00:00Z');
        let currentValue = 0;
        const observedValues: number[] = [];
        const harness = createRegisteredHandlerHarness({ now: () => now });
        harness.service.onStateMessage(AppInboxType.GROUP_CREATE, async (_data, context) => {
            const value = currentValue;
            observedValues.push(value);
            return await harness.service.commit(context, { value }, async () => {
                if (value < 6) {
                    throw failure === 'conflict'
                        ? new RuntimeStateWriteConflictError()
                        : Object.assign(new Error('Temporary database failure'), { code: 'app-inbox-transient' });
                }
            });
        });
        const pending = harness.service.enqueueAndWait(harness.enqueue);
        for (let attempt = 1; attempt <= 6; attempt += 1) {
            await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
            const retry = await harness.readEntry();
            expect(retry).toMatchObject({ status: EntityStatus.RETRY, dequeueAudit: { attempts: attempt } });
            expect(observedValues).toHaveLength(attempt);
            expect(harness.results.entries.size).toBe(0);
            const delayMs = Number(retry!.dequeueAudit.nextTs!.epochMilliseconds - retry!.dequeueAudit.endTs!.epochMilliseconds);
            expect(delayMs).toBeGreaterThan(0);
            if (attempt === 6) {
                expect(delayMs).toBeGreaterThanOrEqual(800);
                expect(delayMs).toBeLessThanOrEqual(1200);
            }
            // A competing writer changes the read state between outer deliveries.
            currentValue += 1;
            now = retry!.dequeueAudit.nextTs!;
        }
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        await expect(pending).resolves.toMatchObject({ right: { value: 6 } });
        expect(observedValues).toEqual([0, 1, 2, 3, 4, 5, 6]);
        expect(await harness.readEntry()).toMatchObject({ status: EntityStatus.COMPLETED, dequeueAudit: { attempts: 7 } });
    });

    it.each(['conflict', 'transient'] as const)('applies configured delay and attempt bounds to persisted %s redelivery', async (failure) => {
        let now = Temporal.Instant.from('2026-07-22T12:00:00Z');
        let attempts = 0;
        const harness = createRegisteredHandlerHarness({ now: () => now, appInboxOptions: { conflictRetryMaxDelayMs: 75 } });
        const resilience = ResourceInboxResilience.create({
            circuitBreakerPolicy: createResilience().circuitBreaker.policy,
            reservationLeaseMs: 60_000,
            retryPolicy: { ...DEFAULT_RESOURCE_INBOX_RETRY_POLICY, maxAttempts: 8, maxDelayMs: 400 }
        });
        harness.service.onStateMessage(AppInboxType.GROUP_CREATE, async (_data, context) => {
            attempts += 1;
            return await harness.service.commit(context, { accepted: true }, async () => {
                throw failure === 'conflict'
                    ? new RuntimeStateWriteConflictError()
                    : Object.assign(new Error('Temporary database failure'), { code: 'app-inbox-transient' });
            });
        });
        harness.service.enqueueWithoutWaiting(harness.enqueue);
        for (let attempt = 1; attempt <= 8; attempt += 1) {
            await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience);
            const entry = (await harness.readEntry())!;
            expect(attempts).toBe(attempt);
            expect(entry.dequeueAudit.attempts).toBe(attempt);
            if (attempt < 8) {
                expect(entry.status).toBe(EntityStatus.RETRY);
                const delayMs = Number(entry.dequeueAudit.nextTs!.epochMilliseconds - entry.dequeueAudit.endTs!.epochMilliseconds);
                if (attempt >= 6) {
                    if (failure === 'conflict') {
                        expect(delayMs).toBe(75);
                    }
                    else {
                        expect(delayMs).toBeGreaterThanOrEqual(320);
                        expect(delayMs).toBeLessThanOrEqual(480);
                    }
                }
                now = entry.dequeueAudit.nextTs!;
            }
        }
        expect(await harness.readEntry()).toMatchObject({ status: EntityStatus.FAILED, dequeueAudit: { attempts: 8 } });
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience);
        expect(attempts).toBe(8);
    });

    it.each([0, -1, 1.5, 2_592_000_001, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
        'rejects invalid explicit conflict delay %s during construction',
        (conflictRetryMaxDelayMs) => {
            expect(() => createRegisteredHandlerHarness({ appInboxOptions: { conflictRetryMaxDelayMs } }))
                .toThrow('AppInbox conflict retry maximum delay must be a positive safe integer');
        }
    );

    it('survives a bounded conflict window without exhausting the delivery budget', async () => {
        const startedAt = Temporal.Instant.from('2026-07-22T12:00:00Z');
        let now = startedAt;
        const observedTimes: number[] = [];
        const harness = createRegisteredHandlerHarness({ now: () => now });
        harness.service.onStateMessage(AppInboxType.GROUP_CREATE, async (_data, context) => {
            const elapsedMs = Number(now.epochMilliseconds - startedAt.epochMilliseconds);
            observedTimes.push(elapsedMs);
            return await harness.service.commit(context, { accepted: true }, async () => {
                if (elapsedMs < 500) {
                    throw new RuntimeStateWriteConflictError();
                }
            });
        });
        harness.service.enqueueWithoutWaiting(harness.enqueue);
        for (let attempt = 1; attempt <= 20; attempt += 1) {
            await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
            const entry = await harness.readEntry();
            if (entry?.status !== EntityStatus.RETRY) {
                break;
            }
            now = entry.dequeueAudit.nextTs!;
        }
        expect(await harness.readEntry()).toMatchObject({ status: EntityStatus.COMPLETED });
        expect(observedTimes.at(-1)).toBeGreaterThanOrEqual(500);
        expect(observedTimes.length).toBeLessThan(20);
        expect(harness.results.entries.size).toBe(1);
    });

    it('exhausts twenty conflicting deliveries without an inner retry or another mutation attempt', async () => {
        let now = Temporal.Instant.from('2026-07-22T12:00:00Z');
        const attempts: number[] = [];
        const harness = createRegisteredHandlerHarness({ now: () => now });
        harness.service.onStateMessage(AppInboxType.GROUP_CREATE, async (_data, context) => {
            attempts.push(context.entry.dequeueAudit.attempts);
            return await harness.service.commit(context, { accepted: true }, async () => {
                throw new RuntimeStateWriteConflictError();
            });
        });
        harness.service.enqueueWithoutWaiting(harness.enqueue);
        for (let attempt = 1; attempt <= 20; attempt += 1) {
            await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
            const entry = await harness.readEntry();
            expect(attempts).toHaveLength(attempt);
            expect(entry?.dequeueAudit.attempts).toBe(attempt);
            if (attempt < 20) {
                expect(entry?.status).toBe(EntityStatus.RETRY);
                const delayMs = Number(entry!.dequeueAudit.nextTs!.epochMilliseconds - entry!.dequeueAudit.endTs!.epochMilliseconds);
                expect(delayMs).toBeGreaterThan(0);
                expect(delayMs).toBeLessThanOrEqual(1200);
                if (attempt >= 7) {
                    expect(delayMs).toBe(1200);
                }
                now = entry!.dequeueAudit.nextTs!;
            }
        }
        expect(await harness.readEntry()).toMatchObject({ status: EntityStatus.FAILED, dequeueAudit: { attempts: 20 } });
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        expect(attempts).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    });
});
