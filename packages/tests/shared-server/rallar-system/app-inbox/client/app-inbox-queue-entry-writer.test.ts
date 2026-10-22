import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { AppInboxQueueEntryWriter } from '@shared-server/rallar-system/app-inbox/client/app-inbox-queue-entry-writer.ts';
import type { QueueBoxWrittenIfAbsent } from '@shared/queuebox/queue-box-types.ts';
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
            inboxQueueReader: new InboxQueueReader(queue, { newLaneConcurrency: 1 }, creationNow),
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
        expect(generated.audit.createdTs.toString()).toBe('2026-10-13T23:59:59.123');
        expect(generated.dequeueAudit).toEqual({ attempts: 0 });
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

    it('leaves the wake to the waiter and reports whether its write created the entry', async () => {
        const queue = new TestResourceInbox(new Map());
        let wakeSignals = 0;
        const service = createService(queue, () => {
            wakeSignals += 1;
        });

        const created = await service.writeIfAbsent(COMMAND);
        const replayed = await service.writeIfAbsent(COMMAND);

        expect(created.winner).toBe(true);
        expect(replayed).toEqual({ entry: created.entry, winner: false });
        expect(created.entry).toEqual(await queue.getItem(created.entry.key));
        expect(wakeSignals).toBe(0);
    });

    it('takes whether its write created the entry from the queue, not from the message it serialized', async () => {
        const queue = new TestResourceInbox(new Map());
        const message = createAppInboxQueueMessageFixture({
            key: { topicId: 'app-inbox.client-state', resourceId: COMMAND.resourceId, contextId: COMMAND.contextId },
            enqueue: COMMAND,
            serviceId: 'server-12345678'
        });
        const service = new AppInboxQueueEntryWriter(
            {
                createMessage: () => message,
                newResourceId: crypto.randomUUID.bind(crypto),
                inboxQueueReader: new InboxQueueReader(queue, { newLaneConcurrency: 1 })
            },
            { serviceId: 'server-12345678', defaultTopicId: 'app-inbox.client-state' }
        );

        const created = await service.writeIfAbsent(COMMAND);
        const replayed = await service.writeIfAbsent(COMMAND);

        expect(created.winner).toBe(true);
        expect(replayed).toEqual({ entry: created.entry, winner: false });
    });
});

function createService(
    queue: TestResourceInbox,
    wakeQueue?: () => void
): AppInboxQueueEntryWriter {
    return new AppInboxQueueEntryWriter(
        {
            createMessage: createAppInboxQueueMessageFixture,
            newResourceId: crypto.randomUUID.bind(crypto),
            inboxQueueReader: new InboxQueueReader(queue, { newLaneConcurrency: 1 })
        },
        {
            serviceId: 'server-12345678',
            defaultTopicId: 'app-inbox.client-state',
            wakeOwningQueue: wakeQueue
        }
    );
}

class FailingQueueBox extends TestResourceInbox {
    private readonly failure: Error;

    constructor(failure: Error) {
        super(new Map());
        this.failure = failure;
    }

    override writeIfAbsent(): Promise<QueueBoxWrittenIfAbsent> {
        return Promise.reject(this.failure);
    }
}
