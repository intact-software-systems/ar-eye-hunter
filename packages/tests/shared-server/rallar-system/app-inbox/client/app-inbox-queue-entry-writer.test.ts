import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { AppInboxQueueEntryWriter } from '@shared-server/rallar-system/app-inbox/client/app-inbox-queue-entry-writer.ts';
import {
    EntityStatus,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { TestResourceInbox } from '../test-support/app-inbox-resource-fixtures.ts';
import { createAppInboxQueueMessageFixture } from '../test-support/create-app-inbox-queue-message-fixture.ts';

const COMMAND = {
    type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
    resourceId: 'durable-command-1',
    contextId: 'app:workspace:principal',
    senderId: 'principal',
    data: { requestId: 'durable-command-1', principalId: 'principal' }
} as const;

describe('AppInbox durable enqueue', () => {
    it('generates one resource ID for a sparse command and preserves supplied IDs', async () => {
        const queue = new TestResourceInbox(new Map());
        const createdAt = Temporal.Instant.from('2026-10-13T23:59:59.123456789Z');
        const creationNow = () => createdAt;
        const newResourceId = vi.fn((): string => {
            throw new Error('A supplied resource ID must not require another generated ID');
        }).mockReturnValueOnce('generated-command');
        const writer = new AppInboxQueueEntryWriter({
            repository: queue,
            inboxQueueReader: new InboxQueueReader(queue, { laneBudgetPolicy: 'fixed-retry-two' }, creationNow),
            creationNow,
            newResourceId,
            createMessage: createAppInboxQueueMessageFixture
        }, { serviceId: 'server', defaultTopicId: 'app-inbox.client-state' });

        const generated = await writer.enqueue({ ...COMMAND, resourceId: undefined });
        const supplied = await writer.enqueue(COMMAND);

        expect(generated.key).toEqual({
            topicId: 'app-inbox.client-state',
            resourceId: 'generated-command',
            contextId: 'app:workspace:principal'
        });
        expect(supplied.key.resourceId).toBe('durable-command-1');
        expect(generated.audit.createdTs.toString()).toBe('2026-10-13T23:59:59.123456789');
        expect(generated.dequeueAudit).toEqual({ attempts: 0 });
    });

    it('captures a new precise replacement instant and resets attempts while leaving an active replay unchanged', async () => {
        const queue = new TestResourceInbox(new Map());
        let createdAt = Temporal.Instant.from('2026-10-13T23:59:59.123456789Z');
        const writer = new AppInboxQueueEntryWriter({
            repository: queue,
            inboxQueueReader: new InboxQueueReader(queue, { laneBudgetPolicy: 'fixed-retry-two' }),
            creationNow: () => createdAt,
            newResourceId: () => 'unused-command',
            createMessage: createAppInboxQueueMessageFixture
        }, { serviceId: 'server', defaultTopicId: 'app-inbox.client-state' });
        const key = await writer.enqueueReplacingTerminal(COMMAND);
        const initial = await queue.getItem(key);
        if (initial === undefined) {
            throw new Error('Expected the inserted AppInbox row.');
        }
        createdAt = Temporal.Instant.from('2026-10-14T00:00:00.987654321Z');
        await writer.enqueueReplacingTerminal(COMMAND);
        expect(await queue.getItem(key)).toEqual(initial);
        await queue.enqueue({ ...initial, status: EntityStatus.COMPLETED, dequeueAudit: { attempts: 15 } });

        await writer.enqueueReplacingTerminal(COMMAND);

        expect((await queue.getItem(key))?.audit.createdTs.toString()).toBe('2026-10-14T00:00:00.987654321');
        expect((await queue.getItem(key))?.dequeueAudit).toEqual({ attempts: 0 });
    });

    it('returns the exact persisted row without waiting for command completion', async () => {
        const queue = new TestResourceInbox(new Map());
        const service = createService(queue);

        const entry = await service.enqueue(COMMAND);

        expect(entry).toEqual(await queue.getItem(entry.key));
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
        const queue = new TestResourceInbox(new Map());
        let wakeSignals = 0;
        const service = createService(queue, () => {
            wakeSignals += 1;
        });

        const first = await service.enqueue(COMMAND);
        const duplicate = await service.enqueue(COMMAND);

        expect(duplicate).toEqual(first);
        expect(wakeSignals).toBe(2);
    });

    it('replaces terminal work and wakes only when the durable row changes', async () => {
        const queue = new TestResourceInbox(new Map());
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
    queue: TestResourceInbox,
    wakeQueue?: () => void
): AppInboxQueueEntryWriter {
    return new AppInboxQueueEntryWriter(
        {
            creationNow: Temporal.Now.instant,
            createMessage: createAppInboxQueueMessageFixture,
            newResourceId: crypto.randomUUID.bind(crypto),
            inboxQueueReader: new InboxQueueReader(queue, { laneBudgetPolicy: 'fixed-retry-two' }),
            repository: queue
        },
        {
            serviceId: 'server-12345678',
            defaultTopicId: 'app-inbox.client-state',
            wakeOwningQueue: wakeQueue
        }
    );
}

class LosingTerminalReplacementQueue extends TestResourceInbox {
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

class FailingQueueBox extends TestResourceInbox {
    private readonly failure: Error;

    constructor(failure: Error) {
        super(new Map());
        this.failure = failure;
    }

    override enqueueIfAbsent(): Promise<ResourceEntry> {
        return Promise.reject(this.failure);
    }
}
