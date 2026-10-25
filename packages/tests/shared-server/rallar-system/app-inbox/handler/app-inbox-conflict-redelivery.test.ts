import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
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
            if (failure === 'conflict') {
                expect(delayMs).toBeLessThanOrEqual(20);
            }
            else if (attempt === 6) {
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
                expect(delayMs).toBeLessThanOrEqual(20);
                now = entry!.dequeueAudit.nextTs!;
            }
        }
        expect(await harness.readEntry()).toMatchObject({ status: EntityStatus.FAILED, dequeueAudit: { attempts: 20 } });
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        expect(attempts).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    });
});
