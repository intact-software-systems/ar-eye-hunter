import { describe, expect, it, vi } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { AppInboxQueueClient, SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-client.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

const COMMAND = {
    type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
    resourceId: 'durable-command-1',
    contextId: 'app:workspace:principal',
    senderId: 'principal',
    data: { requestId: 'durable-command-1', principalId: 'principal' }
} as const;

class DurableEnqueueQueue extends InMemoryQueueBox {
    async isEntryWithStatus(key: Key, statuses: EntityStatus[]): Promise<boolean> {
        const entry = await this.getItem(key);
        return entry !== undefined && statuses.includes(entry.status);
    }
}

describe('AppInbox durable enqueue', () => {
    it('returns the exact persisted row without waiting for command completion', async () => {
        const queue = new DurableEnqueueQueue(new Map());
        const service = createService(queue);

        const entry = await service.enqueue(COMMAND);

        expect(entry).toBe(await queue.getItem(entry.key));
        expect(entry.key).toEqual({
            topicId: SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
            resourceId: COMMAND.resourceId,
            contextId: COMMAND.contextId
        });
        expect(JSON.parse(entry.resource)).toMatchObject({
            payload: {
                typeId: AppInboxType.CLIENT_PRINCIPAL_UPSERT
            }
        });
    });

    it('propagates durable storage failure to the transport owner', async () => {
        const failure = new Error('durable enqueue unavailable');
        const queue = new FailingQueueBox(failure);
        const service = createService(queue);

        await expect(service.enqueue(COMMAND)).rejects.toBe(failure);
    });

    it('wakes the owning queue after durable enqueue and idempotent reuse', async () => {
        const queue = new DurableEnqueueQueue(new Map());
        let wakeSignals = 0;
        const service = createService(queue, () => {
            wakeSignals += 1;
        });

        const first = await service.enqueue(COMMAND);
        const duplicate = await service.enqueue(COMMAND);

        expect(duplicate).toBe(first);
        expect(wakeSignals).toBe(2);
    });
});

function createService(queue: DurableEnqueueQueue, wakeQueue?: () => void): AppInboxQueueClient {
    const results = {
        replace: async (entry: ResourceEntry) => entry,
        findByKey: (_key: Key) => Promise.resolve(undefined)
    };
    return new AppInboxQueueClient(
        {
            inboxQueueReader: new InboxQueueReader(queue),
            resourceInboxRepository: queue,
            resourceInboxResultsRepository: results
        },
        {
            serviceId: 'server-12345678',
            defaultTopicId: SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
            wakeOwningQueue: wakeQueue
        }
    );
}

class FailingQueueBox extends DurableEnqueueQueue {
    private readonly failure: Error;

    constructor(failure: Error) {
        super(new Map());
        this.failure = failure;
    }

    override enqueueIfAbsent(): Promise<ResourceEntry> {
        return Promise.reject(this.failure);
    }
}
