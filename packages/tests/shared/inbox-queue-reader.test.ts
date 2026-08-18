import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';
import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import type { OnMessageCallback } from '@shared/services/InboxOutboxContracts.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

describe('InboxQueueReader', () => {
    it('dispatches app inbox messages to the registered payload type callback', async () => {
        const queue = new InMemoryQueueBox();
        const reader = new InboxQueueReader(queue);
        const onMessage = vi.fn<OnMessageCallback['onMessage']>(async () => undefined);
        const message = createAppInboxMessage('group-state.create.v1');

        reader.onInboxMessageDo('group-state.create.v1', { onMessage });
        await reader.enqueueIfAbsent(message);
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        expect(onMessage).toHaveBeenCalledOnce();
        expect(onMessage.mock.calls[0][0]).toEqual(message);
        expect(readOnlyEntry(queue)?.status).toBe(EntityStatus.COMPLETED);
    });

    it('keeps the queue entry retryable when no payload type callback is registered', async () => {
        const queue = new InMemoryQueueBox();
        const reader = new InboxQueueReader(queue);
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            await reader.enqueueIfAbsent(createAppInboxMessage('group-state.create.v1'));
            await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        } finally {
            consoleError.mockRestore();
        }

        expect(readOnlyEntry(queue)?.status).toBe(EntityStatus.RETRY);
    });
});

function createAppInboxMessage(typeId: string) {
    return newALUntargetedMessage(
        'api-v1',
        newALRoute('app-inbox.group-state', 'group-1', crypto.randomUUID()),
        typeId,
        {
            requestId: crypto.randomUUID(),
        },
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

function readOnlyEntry(queue: InMemoryQueueBox): ResourceEntry | undefined {
    const data = (
        queue as unknown as {
            data: Map<string, ResourceEntry>;
        }
    ).data;

    return data.values().next().value;
}
