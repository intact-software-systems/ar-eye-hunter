import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { createQueueMessage, createQueueResilience, seedRetry } from './fair-service-fixture.ts';

describe('AppInbox fair service', () => {
    it('keeps unrelated type sets and outboxes on their existing drain defaults', async () => {
        const queue = new InMemoryQueueBox();
        const inbox = new InboxQueueReader(queue);
        const outbox = new OutboxQueueReader(queue);
        const delivered: string[] = [];
        const callback = {
            onMessage: async (message: ReturnType<typeof createQueueMessage>) => {
                delivered.push(message.route.resourceId);
            }
        };
        inbox.onInboxMessageDo('test.fair-service', callback);
        outbox.onOutboxMessageDo('test.fair-service', callback);
        await inbox.enqueueIfAbsent(createQueueMessage('inbox-a'));
        await inbox.enqueueIfAbsent(createQueueMessage('inbox-b'));
        await outbox.enqueueIfAbsent(createQueueMessage('outbox-a'));
        await outbox.enqueueIfAbsent(createQueueMessage('outbox-b'));
        await inbox.dequeueInbox(new Set([InboxQueueReader.INBOX_ENQUEUE_TYPE, 'other-type']), createQueueResilience());
        await outbox.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, createQueueResilience());
        expect(delivered).toEqual(['inbox-a', 'inbox-b', 'outbox-a', 'outbox-b']);
    });

    it('completes an overdue retry before trailing NEW work is consumed', async () => {
        let now = Date.now();
        const queue = new InMemoryQueueBox(new Map(), () => Temporal.Instant.fromEpochMilliseconds(now));
        const reader = new InboxQueueReader(queue, { nowEpochMs: () => now });
        const resilience = createQueueResilience();
        const retry = await seedRetry(queue, 'retry');
        const first = await reader.enqueueIfAbsent(createQueueMessage('first'));
        const trailing = await reader.enqueueIfAbsent(createQueueMessage('trailing'));
        const delivered: string[] = [];
        let trailingStatusAtRetry: EntityStatus | undefined;
        reader.onInboxMessageDo('test.fair-service', {
            onMessage: async (message) => {
                delivered.push(message.route.resourceId);
                if (message.route.resourceId === first.key.resourceId) {
                    now += DEFAULT_RESOURCE_INBOX_RETRY_POLICY.staleDueThresholdMs + 2;
                }
                if (message.route.resourceId === retry.key.resourceId) {
                    trailingStatusAtRetry = (await queue.getItem(trailing.key))?.status;
                }
            }
        });

        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience);

        expect(trailingStatusAtRetry).toBe(EntityStatus.NEW);
        expect(delivered).toEqual(['first', 'retry']);
        expect(await queue.getItem(retry.key)).toMatchObject({
            status: EntityStatus.COMPLETED,
            dequeueAudit: { attempts: 2 }
        });
    });
});
