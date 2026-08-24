import { Temporal } from '@js-temporal/polyfill';
import { newALRoute, newALUntargetedMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import type { OnMessageCallback } from '@shared/services/InboxOutboxContracts.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { describe, expect, it, vi } from 'vitest';

describe('OutboxQueueReader', () => {
    it('dispatches app outbox messages using the APP_OUTBOX queue type', async () => {
        const queue = new InMemoryQueueBox();
        const reader = new OutboxQueueReader(queue);
        const dispatched: Parameters<OnMessageCallback['onMessage']>[0][] = [];
        const onMessage: OnMessageCallback['onMessage'] = async (dispatchedMessage) => {
            dispatched.push(dispatchedMessage);
        };
        const message = createAppMessage('RTC_TOPOLOGY_RECOMPUTE', 'outbox');

        reader.onOutboxMessageDo('RTC_TOPOLOGY_RECOMPUTE', { onMessage });
        const enqueued = await reader.enqueueIfAbsent(message);
        await reader.dequeueOutbox(
            OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
            createResilience()
        );

        expect(enqueued.typeId).toBe(EnqueuedType.APP_OUTBOX);
        expect(dispatched).toEqual([message]);
        expect((await queue.getItem(enqueued.key))?.status).toBe(EntityStatus.COMPLETED);
    });

    it('does not reserve APP_INBOX work', async () => {
        const queue = new InMemoryQueueBox();
        const inbox = new InboxQueueReader(queue);
        const outbox = new OutboxQueueReader(queue);
        const inboxMessages: ALMessage[] = [];
        const outboxMessages: ALMessage[] = [];
        const onInbox: OnMessageCallback['onMessage'] = async (message) => {
            inboxMessages.push(message);
        };
        const onOutbox: OnMessageCallback['onMessage'] = async (message) => {
            outboxMessages.push(message);
        };

        inbox.onInboxMessageDo('group-state.create.v1', { onMessage: onInbox });
        outbox.onOutboxMessageDo('group-state.create.v1', { onMessage: onOutbox });
        const message = createAppMessage('group-state.create.v1', 'inbox');
        await inbox.enqueueIfAbsent(message);
        await outbox.dequeueOutbox(
            OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
            createResilience()
        );

        expect(outboxMessages).toEqual([]);
        expect(inboxMessages).toEqual([]);
        expect((await queue.getItem(message.route))?.status).toBe(EntityStatus.NEW);

        await inbox.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience()
        );

        expect(inboxMessages).toHaveLength(1);
    });

    it('does not reserve APP_OUTBOX work from the inbox reader', async () => {
        const queue = new InMemoryQueueBox();
        const inbox = new InboxQueueReader(queue);
        const outbox = new OutboxQueueReader(queue);
        const inboxMessages: ALMessage[] = [];
        const outboxMessages: ALMessage[] = [];
        const onInbox: OnMessageCallback['onMessage'] = async (message) => {
            inboxMessages.push(message);
        };
        const onOutbox: OnMessageCallback['onMessage'] = async (message) => {
            outboxMessages.push(message);
        };

        inbox.onInboxMessageDo('RTC_TOPOLOGY_RECOMPUTE', { onMessage: onInbox });
        outbox.onOutboxMessageDo('RTC_TOPOLOGY_RECOMPUTE', { onMessage: onOutbox });
        const message = createAppMessage('RTC_TOPOLOGY_RECOMPUTE', 'outbox');
        await outbox.enqueueIfAbsent(message);
        await inbox.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience()
        );

        expect(inboxMessages).toEqual([]);
        expect(outboxMessages).toEqual([]);
        expect((await queue.getItem(message.route))?.status).toBe(EntityStatus.NEW);

        await outbox.dequeueOutbox(
            OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
            createResilience()
        );

        expect(outboxMessages).toHaveLength(1);
    });
});

function createAppMessage(typeId: string, direction: string) {
    return newALUntargetedMessage(
        'api-v1',
        newALRoute(`app-${direction}.work`, 'group-1', crypto.randomUUID()),
        typeId,
        { requestId: crypto.randomUUID() }
    );
}

function createResilience(): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(10, duration, duration, duration),
        1,
        10,
        1,
        1
    );
}
