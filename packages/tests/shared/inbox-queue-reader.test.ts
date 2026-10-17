import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import {
    newALRoute,
    newALUntargetedMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import type { OnMessageCallback } from '@shared/services/queue-message-callbacks.ts';

describe('InboxQueueReader', () => {
    it('captures precise enqueue time separately from admission time and retains it on replay', async () => {
        const queue = new InMemoryQueueBox();
        let createdAt = Temporal.Instant.from('2026-10-14T01:59:59.123456789+02:00');
        const reader = new InboxQueueReader(queue, { laneBudgetPolicy: 'adaptive-retry', newLaneConcurrency: 1, nowEpochMs: () => 123 }, () => createdAt);
        const message = createAppInboxMessage('group-state.create.v1');
        const first = await reader.enqueueIfAbsent(message);

        createdAt = Temporal.Instant.from('2026-10-15T00:00:00.987654321Z');
        const replay = await reader.enqueueIfAbsent(message);
        const next = await reader.enqueueIfAbsent(createAppInboxMessage('group-state.create.v1'));

        expect(first.audit.createdTs.toString()).toBe('2026-10-13T23:59:59.123456789');
        expect(first.audit.date.toString()).toBe('23:59:59.123456789');
        expect(replay.audit.createdTs.toString()).toBe('2026-10-13T23:59:59.123456789');
        expect(next.audit.createdTs.toString()).toBe('2026-10-15T00:00:00.987654321');
        expect(first.typeId).toBe('APP_INBOX');
        expect(replay.dequeueAudit).toEqual({ attempts: 0 });
    });

    it('dispatches app inbox messages to the registered payload type callback', async () => {
        const queue = new InMemoryQueueBox();
        const reader = new InboxQueueReader(queue, { laneBudgetPolicy: 'fixed-retry-two', newLaneConcurrency: 1 });
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

    it.each(['invalid-version', 'invalid-json'])('fails a persisted %s message without retrying or delivering it', async (corruption) => {
        const queue = new InMemoryQueueBox();
        const reader = new InboxQueueReader(queue, { laneBudgetPolicy: 'fixed-retry-two', newLaneConcurrency: 1 });
        const delivered: ALMessage[] = [];
        reader.onInboxMessageDo('group-state.create.v1', {
            onMessage: async (message) => {
                delivered.push(message);
            }
        });
        const message = createAppInboxMessage('group-state.create.v1');
        const enqueued = await reader.enqueueIfAbsent(message);
        const resource = corruption === 'invalid-json'
            ? '{"private-payload":'
            : JSON.stringify({ ...message, id: { ...message.id, v: 1 } });
        await queue.setItem(enqueued.key, { ...enqueued, resource }, {
            expireAtTimestamp: enqueued.audit.expiryTs.epochMilliseconds
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
            await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        }
        finally {
            consoleError.mockRestore();
        }
        expect(delivered).toEqual([]);
        expect(await queue.getItem(enqueued.key)).toMatchObject({
            status: EntityStatus.NON_RETRYABLE,
            dequeueAudit: { attempts: 1, nextTs: undefined }
        });
    });

    it('keeps the queue entry retryable when no payload type callback is registered', async () => {
        const queue = new InMemoryQueueBox();
        const reader = new InboxQueueReader(queue, { laneBudgetPolicy: 'fixed-retry-two', newLaneConcurrency: 1 });
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

function createResilience(): ResourceInboxResilience {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResourceInboxResilience.createDefault({
        circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
        initialRate: 1,
        maxRate: 10,
        concurrencyIncreaseStep: 1,
        concurrencyReduceStep: 1
    });
}
