import { Temporal } from '@js-temporal/polyfill';
import {
    newALRoute,
    newALUntargetedMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { NotReadyException } from '@shared/queuebox/resource-inbox/not-ready-exception.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import type { OnMessageCallback } from '@shared/services/queue-message-callbacks.ts';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

describe('OutboxQueueReader', () => {
    it('dispatches app outbox messages using the APP_OUTBOX queue type', async () => {
        const queue = new InMemoryQueueBox();
        const reader = new OutboxQueueReader(queue);
        const dispatched: ALMessage[] = [];
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
        const inbox = new InboxQueueReader(queue, { newLaneConcurrency: 1 });
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
        const inbox = new InboxQueueReader(queue, { newLaneConcurrency: 1 });
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

    it('tells its dequeue-pass observer about the probe, the pass, each claim and each claimed handler', async () => {
        const queue = new InMemoryQueueBox();
        const outbox = new OutboxQueueReader(queue);
        const observed: string[] = [];
        outbox.onDequeuePassDo({
            onProbeStarted: () => observed.push('probe-started'),
            onProbeFinished: (advertisedLanes) => observed.push(`probe-finished:${advertisedLanes.NEW}`),
            onPassStarted: () => observed.push('pass-started'),
            onEntryClaimed: (attempt) => observed.push(`claimed:${attempt.entry.key.resourceId}`),
            onHandlerStarted: (attempt) => observed.push(`handler-started:${attempt.entry.key.resourceId}`),
            onHandlerFinished: (attempt) => observed.push(`handler-finished:${attempt.entry.key.resourceId}`),
            onPassFinished: () => observed.push('pass-finished')
        });
        outbox.onOutboxMessageDo('observed.work', { onMessage: async () => {} });
        const message = createAppMessage('observed.work', 'outbox');
        await outbox.enqueueIfAbsent(message);

        const advertisedLanes = await outbox.readWorkAdvertisement(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, createResilience());
        await outbox.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, createResilience(), advertisedLanes);

        expect(observed).toEqual([
            'probe-started',
            'probe-finished:true',
            'pass-started',
            `claimed:${message.route.resourceId}`,
            `handler-started:${message.route.resourceId}`,
            `handler-finished:${message.route.resourceId}`,
            'pass-finished'
        ]);
        expect(() => outbox.onDequeuePassDo({} as never)).toThrow(/already installed/u);
    });

    it('resolves with the number of entries it claimed, whether their handlers succeeded, failed or were not ready', async () => {
        vi.useFakeTimers({ now: Date.parse('2026-01-01T00:00:00Z') });
        const queue = new InMemoryQueueBox(new Map(), () => Temporal.Instant.fromEpochMilliseconds(Date.now()));
        const outbox = new OutboxQueueReader(queue);
        outbox.onOutboxMessageDo('claim.succeeds', { onMessage: async () => {} });
        outbox.onOutboxMessageDo('claim.fails', {
            onMessage: async () => await Promise.reject(new Error('handler failed'))
        });
        outbox.onOutboxMessageDo('claim.not-ready', {
            onMessage: async () => await Promise.reject(new NotReadyException(60_000))
        });
        for (const type of ['claim.succeeds', 'claim.fails', 'claim.not-ready']) {
            await outbox.enqueueIfAbsent(createAppMessage(type, 'outbox'));
        }

        try {
            await expect(outbox.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, createResilience())).resolves.toBe(3);
            await expect(outbox.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, createResilience())).resolves.toBe(0);
            vi.advanceTimersByTime(2);
            await expect(outbox.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, createResilience())).resolves.toBe(1);
        }
        finally {
            vi.useRealTimers();
        }
    });
});

function createAppMessage(typeId: string, direction: string): ALMessage {
    return newALUntargetedMessage(
        'api-v1',
        newALRoute(`app-${direction}.work`, 'group-1', crypto.randomUUID()),
        typeId,
        { requestId: crypto.randomUUID() }
    );
}

function createResilience(): ResourceInboxResilience {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResourceInboxResilience.createDefault({
        circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration)
    });
}
