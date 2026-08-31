import { Temporal } from '@js-temporal/polyfill';
import { newALRoute, newALUntargetedMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import type { OnMessageCallback } from '@shared/services/queue-message-callbacks.ts';
import { describe, expect, it, vi } from 'vitest';

describe('InboxQueueReader', () => {
    it('dispatches app inbox messages to the registered payload type callback', async () => {
        const queue = new InMemoryQueueBox();
        const reader = new InboxQueueReader(queue);
        const dispatched: ALMessage[] = [];
        const onMessage: OnMessageCallback['onMessage'] = async (dispatchedMessage) => {
            dispatched.push(dispatchedMessage);
        };
        const message = createAppInboxMessage('group-state.create.v1');

        reader.onInboxMessageDo('group-state.create.v1', { onMessage });
        const enqueued = await reader.enqueueIfAbsent(message);
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        expect(dispatched).toEqual([message]);
        expect((await queue.getItem(enqueued.key))?.status).toBe(EntityStatus.COMPLETED);
    });

    it('keeps a malformed persisted envelope out of application callbacks', async () => {
        const queue = new InMemoryQueueBox();
        const reader = new InboxQueueReader(queue);
        const delivered: ALMessage[] = [];
        reader.onInboxMessageDo('group-state.create.v1', {
            onMessage: async (message) => {
                delivered.push(message);
            }
        });
        const message = createAppInboxMessage('group-state.create.v1');
        const enqueued = await reader.enqueueIfAbsent(message);
        await queue.setItem(enqueued.key, { ...enqueued, resource: JSON.stringify({ ...message, id: { ...message.id, v: 1 } }) }, {
            expireAtTimestamp: enqueued.audit.expiryTs.epochMilliseconds
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        }
        finally {
            consoleError.mockRestore();
        }
        expect(delivered).toEqual([]);
        expect((await queue.getItem(enqueued.key))?.status).toBe(EntityStatus.RETRY);
    });

    it('keeps the queue entry retryable when no payload type callback is registered', async () => {
        const queue = new InMemoryQueueBox();
        const reader = new InboxQueueReader(queue);
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const enqueued = await reader.enqueueIfAbsent(createAppInboxMessage('group-state.create.v1'));
        try {
            await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        }
        finally {
            consoleError.mockRestore();
        }

        expect((await queue.getItem(enqueued.key))?.status).toBe(EntityStatus.RETRY);
    });
});

function createAppInboxMessage(typeId: string): ALMessage {
    return newALUntargetedMessage(
        'api-v1',
        newALRoute('app-inbox.group-state', 'group-1', crypto.randomUUID()),
        typeId,
        {
            requestId: crypto.randomUUID()
        }
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
