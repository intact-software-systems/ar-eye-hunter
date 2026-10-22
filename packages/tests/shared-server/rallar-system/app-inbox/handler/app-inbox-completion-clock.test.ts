import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import {
    computeAppInboxCompletion,
    validateAppInboxCompletion
} from '@shared-server/rallar-system/app-inbox/handler/app-inbox-completion-computation.ts';
import { createAppInboxHandlerRuntime } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-handler-runtime.ts';
import { EntityStatus, toKeyAsString } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { TestResourceInbox, TestResourceInboxResults } from '../test-support/app-inbox-resource-fixtures.ts';
import { createAppInboxTestDatabase } from '../test-support/app-inbox-test-database.ts';
import { createAtomicHarness, createResilience } from '../test-support/app-inbox-transaction-test-runtime.ts';

describe('AppInbox completion clock ownership', () => {
    it('persists completion using the default clock selected when the runtime is constructed', async () => {
        const harness = createAtomicHarness();
        const queue = new TestResourceInbox();
        const results = new TestResourceInboxResults();
        const originalDateNow = Date.now;
        Date.now = () => 1_784_721_600_123;
        try {
            const runtime = createAppInboxHandlerRuntime({
                inboxQueueReader: new InboxQueueReader(queue, { newLaneConcurrency: 1 }),
                resultRepository: results,
                database: harness.database.sql,
                serviceId: 'server-1'
            });
            Date.now = () => 1_784_721_609_999;
            const completionInput = {
                ...runtime.transactionWriter.readCompletionFacts(harness.context),
                durableResult: { status: 'accepted', revision: 2 },
                status: EntityStatus.COMPLETED
            } as const;
            const completion = computeAppInboxCompletion(completionInput);
            expect(validateAppInboxCompletion(completionInput, completion)).toEqual([]);

            const result = await runtime.transactionWriter.writeComputedMutation(
                harness.context,
                completion,
                async () => {}
            );

            const key = toKeyAsString(harness.entry.key);
            expect(result).toEqual({ status: 'accepted', revision: 2 });
            expect(JSON.parse(harness.database.state.results.get(key)!.resource)).toEqual({ status: 'accepted', revision: 2 });
            expect(harness.database.state.inbox.get(key)?.dequeueAudit.endTs?.epochMilliseconds).toBe(1_784_721_600_123);
        }
        finally {
            Date.now = originalDateNow;
        }
    });

    it('finalizes malformed queue messages with the configured completion clock selected at construction', async () => {
        const harness = createAtomicHarness();
        const queueNow = () => Temporal.Instant.from('2026-07-22T12:00:00Z');
        const queue = new TestResourceInbox(new Map(), queueNow);
        const results = new TestResourceInboxResults(queueNow);
        const reader = new InboxQueueReader(queue, { newLaneConcurrency: 1, nowEpochMs: () => 1_784_721_600_000 });
        let completionClock = () => 1_784_721_600_456;
        createAppInboxHandlerRuntime({
            inboxQueueReader: reader,
            resultRepository: results,
            database: createAppInboxTestDatabase(queue, results),
            serviceId: 'server-1',
            options: {
                get nowEpochMs() {
                    return completionClock;
                }
            }
        });
        completionClock = () => 1_784_721_609_999;
        await queue.enqueue({
            ...harness.entry,
            resource: '{"private-payload":',
            status: EntityStatus.NEW,
            dequeueAudit: { attempts: 0 }
        });

        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        const entry = await queue.getItem(harness.entry.key);
        const result = await results.findByKey(harness.entry.key);
        expect(entry).toMatchObject({ status: EntityStatus.NON_RETRYABLE, dequeueAudit: { attempts: 1, nextTs: undefined } });
        expect(entry?.dequeueAudit.endTs?.epochMilliseconds).toBe(1_784_721_600_456);
        expect(result?.status).toBe(EntityStatus.NON_RETRYABLE);
        expect(JSON.parse(result!.resource)).toMatchObject({ code: 'app-inbox-malformed-command', status: 400 });
        expect(result?.resource).not.toContain('private-payload');

        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        expect((await queue.getItem(harness.entry.key))?.dequeueAudit.attempts).toBe(1);
    });
});
