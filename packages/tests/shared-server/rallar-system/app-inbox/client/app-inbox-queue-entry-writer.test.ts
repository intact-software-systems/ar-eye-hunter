import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { AppInboxQueueEntryWriter } from '@shared-server/rallar-system/app-inbox/client/app-inbox-queue-entry-writer.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus, isExpiredResourceEntry, toKeyAsString, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

const COMMAND = {
    type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
    resourceId: 'durable-command-1',
    contextId: 'app:workspace:principal',
    senderId: 'principal',
    data: { requestId: 'durable-command-1', principalId: 'principal' }
} as const;

class DurableEnqueueQueue extends InMemoryQueueBox {
    private readonly materializations = new Map<string, Promise<ResourceEntry>>();

    async isEntryWithStatus(key: Key, statuses: EntityStatus[]): Promise<boolean> {
        const entry = await this.getItem(key);
        return entry !== undefined && statuses.includes(entry.status);
    }

    async writeMaterializedIfAbsentOrReplaceExpired(
        placeholder: ResourceEntry,
        materialize: () => Promise<ResourceEntry>
    ): Promise<ResourceEntry> {
        const key = toKeyAsString(placeholder.key);
        const active = this.materializations.get(key);
        if (active !== undefined) {
            return await active;
        }
        const pending = this.materializeEntry(placeholder, materialize);
        this.materializations.set(key, pending);
        try {
            return await pending;
        }
        finally {
            this.materializations.delete(key);
        }
    }

    private async materializeEntry(
        placeholder: ResourceEntry,
        materialize: () => Promise<ResourceEntry>
    ): Promise<ResourceEntry> {
        const existing = await this.getItem(placeholder.key);
        if (existing !== undefined && !isExpiredResourceEntry(existing)) {
            return existing;
        }
        const materialized = await materialize();
        return await this.enqueueIfAbsent({ ...placeholder, resource: materialized.resource });
    }
}

describe('AppInbox durable enqueue', () => {
    it('returns the exact persisted row without waiting for command completion', async () => {
        const queue = new DurableEnqueueQueue(new Map());
        const service = createService(queue);

        const entry = await service.enqueue(COMMAND);

        expect(entry).toBe(await queue.getItem(entry.key));
        expect(entry.key).toEqual({
            topicId: 'app-inbox.client-state',
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

    it('replaces terminal work and wakes only when the durable row changes', async () => {
        const queue = new DurableEnqueueQueue(new Map());
        let wakeSignals = 0;
        const service = createService(queue, () => {
            wakeSignals += 1;
        });

        const firstKey = await service.enqueueReplacingTerminal(COMMAND);
        const activeKey = await service.enqueueReplacingTerminal({
            ...COMMAND,
            data: { ...COMMAND.data, principalId: 'replacement' }
        });
        const active = await queue.getItem(firstKey);
        if (active === undefined) {
            throw new Error('Expected coalesced AppInbox entry');
        }
        await queue.enqueue({ ...active, status: EntityStatus.COMPLETED });
        const completedKey = await service.enqueueReplacingTerminal({
            ...COMMAND,
            data: { ...COMMAND.data, principalId: 'replacement' }
        });

        expect(activeKey).toEqual(firstKey);
        expect(completedKey).toEqual(firstKey);
        expect(wakeSignals).toBe(2);
        expect(JSON.parse((await queue.getItem(firstKey))?.resource ?? '')).toMatchObject({
            payload: {
                resource: expect.stringContaining('replacement')
            }
        });
    });

    it('preserves a concurrent winner and does not wake after a terminal replacement CAS loss', async () => {
        const queue = new LosingTerminalReplacementQueue(new Map());
        let wakeSignals = 0;
        const service = createService(queue, () => {
            wakeSignals += 1;
        });
        const key = await service.enqueueReplacingTerminal(COMMAND);
        const current = await queue.getItem(key);
        if (current === undefined) {
            throw new Error('Expected terminal replacement fixture entry');
        }
        await queue.enqueue({ ...current, status: EntityStatus.COMPLETED });

        await service.enqueueReplacingTerminal({
            ...COMMAND,
            data: { ...COMMAND.data, principalId: 'loser' }
        });

        expect((await queue.getItem(key))?.resource).toBe(
            LosingTerminalReplacementQueue.WINNER_RESOURCE
        );
        expect(wakeSignals).toBe(1);
    });
});

function createService(
    queue: DurableEnqueueQueue,
    wakeQueue?: () => void
): AppInboxQueueEntryWriter {
    return new AppInboxQueueEntryWriter(
        {
            inboxQueueReader: new InboxQueueReader(queue),
            repository: queue
        },
        {
            serviceId: 'server-12345678',
            defaultTopicId: 'app-inbox.client-state',
            wakeOwningQueue: wakeQueue
        }
    );
}

class LosingTerminalReplacementQueue extends DurableEnqueueQueue {
    static readonly WINNER_RESOURCE = JSON.stringify({ winner: true });

    override async replaceIfObserved(
        expected: ResourceEntry,
        replacement: ResourceEntry
    ): Promise<ResourceEntry | null> {
        await this.enqueue({
            ...replacement,
            resource: LosingTerminalReplacementQueue.WINNER_RESOURCE
        });
        return await super.replaceIfObserved(expected, replacement);
    }
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
