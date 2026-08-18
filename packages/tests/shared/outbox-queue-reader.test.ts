import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';
import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import type { OnMessageCallback } from '@shared/services/InboxOutboxContracts.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';

describe('OutboxQueueReader', () => {
    it('dispatches app outbox messages using the APP_OUTBOX queue type', async () => {
        const queue = new InMemoryQueueBox();
        const reader = new OutboxQueueReader(queue);
        const onMessage = vi.fn<OnMessageCallback['onMessage']>(async () => undefined);
        const message = createAppMessage('RTC_TOPOLOGY_RECOMPUTE', 'outbox');

        reader.onOutboxMessageDo('RTC_TOPOLOGY_RECOMPUTE', { onMessage });
        const enqueued = await reader.enqueueIfAbsent(message);
        await reader.dequeueOutbox(
            OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
            createResilience(),
        );

        expect(enqueued.typeId).toBe(EnqueuedType.APP_OUTBOX);
        expect(onMessage).toHaveBeenCalledOnce();
        expect(onMessage.mock.calls[0][0]).toEqual(message);
        expect(readEntries(queue)[0]?.status).toBe(EntityStatus.COMPLETED);
    });

    it('does not reserve APP_INBOX work', async () => {
        const queue = new InMemoryQueueBox();
        const inbox = new InboxQueueReader(queue);
        const outbox = new OutboxQueueReader(queue);
        const onInbox = vi.fn(async () => undefined);
        const onOutbox = vi.fn(async () => undefined);

        inbox.onInboxMessageDo('group-state.create.v1', { onMessage: onInbox });
        outbox.onOutboxMessageDo('group-state.create.v1', { onMessage: onOutbox });
        await inbox.enqueueIfAbsent(createAppMessage('group-state.create.v1', 'inbox'));
        await outbox.dequeueOutbox(
            OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
            createResilience(),
        );

        expect(onOutbox).not.toHaveBeenCalled();
        expect(onInbox).not.toHaveBeenCalled();
        expect(readEntries(queue)[0]?.status).toBe(EntityStatus.NEW);

        await inbox.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );

        expect(onInbox).toHaveBeenCalledOnce();
    });

    it('does not reserve APP_OUTBOX work from the inbox reader', async () => {
        const queue = new InMemoryQueueBox();
        const inbox = new InboxQueueReader(queue);
        const outbox = new OutboxQueueReader(queue);
        const onInbox = vi.fn(async () => undefined);
        const onOutbox = vi.fn(async () => undefined);

        inbox.onInboxMessageDo('RTC_TOPOLOGY_RECOMPUTE', { onMessage: onInbox });
        outbox.onOutboxMessageDo('RTC_TOPOLOGY_RECOMPUTE', { onMessage: onOutbox });
        await outbox.enqueueIfAbsent(
            createAppMessage('RTC_TOPOLOGY_RECOMPUTE', 'outbox'),
        );
        await inbox.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );

        expect(onInbox).not.toHaveBeenCalled();
        expect(onOutbox).not.toHaveBeenCalled();
        expect(readEntries(queue)[0]?.status).toBe(EntityStatus.NEW);

        await outbox.dequeueOutbox(
            OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
            createResilience(),
        );

        expect(onOutbox).toHaveBeenCalledOnce();
    });
});

function createAppMessage(typeId: string, direction: string) {
    return newALUntargetedMessage(
        'api-v1',
        newALRoute(`app-${direction}.work`, 'group-1', crypto.randomUUID()),
        typeId,
        { requestId: crypto.randomUUID() },
    );
}

function createResilience(): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(10, duration, duration, duration),
        1,
        10,
        1,
        1,
    );
}

function readEntries(queue: InMemoryQueueBox): readonly ResourceEntry[] {
    const data = (
        queue as unknown as { data: Map<string, ResourceEntry> }
    ).data;
    return [...data.values()];
}
