import {
    describe,
    expect,
    it
} from 'vitest';

import { validateAppInboxCommandIdentity } from '@shared-server/rallar-system/app-inbox/app-inbox-command-identity.ts';
import { AppInboxIdempotencyConflictError, type AppInboxEnqueueInput } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { createAppInboxClientRuntime } from '@shared-server/rallar-system/app-inbox/client/create-app-inbox-client-runtime.ts';
import { createAppInboxHandlerRuntime } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-handler-runtime.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import {
    createAppInboxTestResilience,
    TestResourceInbox,
    TestResourceInboxResults
} from './test-support/app-inbox-resource-fixtures.ts';
import { createAppInboxTestDatabase } from './test-support/app-inbox-test-database.ts';
import { TEST_APP_INBOX_FINISHED_RETENTION_MS } from './test-support/test-app-inbox-finished-retention.ts';

const COMMAND = {
    type: 'app:inventory:reserve',
    topicId: 'app:inventory:reserve',
    contextId: 'warehouse-1',
    resourceId: 'reservation-1',
    authority: { principalId: 'clerk-1' },
    data: { quantity: 3 }
} satisfies AppInboxEnqueueInput;

describe('app-owned AppInbox operation', () => {
    it('registers, dispatches and returns a durable result while binding authority in generic replay identity', async () => {
        const queue = new TestResourceInbox();
        const results = new TestResourceInboxResults();
        const reader = new InboxQueueReader(queue, { newLaneConcurrency: 1 });
        const database = createAppInboxTestDatabase(queue, results);
        const client = createAppInboxClientRuntime({
            inboxQueueReader: reader,
            resourceInboxRepository: queue,
            resourceInboxResultsRepository: results,
            serviceId: 'inventory-worker',
            defaultTopicId: COMMAND.type
        });
        const runtime = createAppInboxHandlerRuntime({
            inboxQueueReader: reader,
            resultRepository: results,
            database,
            serviceId: 'inventory-worker',
            finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS
        });
        runtime.registry.registerHandler<JsonWireValue, JsonWireValue>({
            type: COMMAND.type,
            decodeCommand: (value) => value,
            encodeResult: (value) => value,
            handle: async (value, context) => ({ accepted: value, actor: context.enqueue.authority ?? null })
        });
        const { entry, winner } = await client.queueEntryWriter.writeIfAbsent(COMMAND);
        expect(validateAppInboxCommandIdentity(entry)).toMatchObject({ valid: true, identity: { operation: COMMAND.type } });

        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));

        expect(await client.resultWaiter.waitForResult({ enqueue: COMMAND, key: entry.key, winner }, (value) => value))
            .toEqual(Either.ofRight({ accepted: { quantity: 3 }, actor: { principalId: 'clerk-1' } }));
        expect((await results.findByKey(entry.key))?.status).toBe('COMPLETED');
        expect((await client.queueEntryWriter.writeIfAbsent(COMMAND)).winner).toBe(false);
        await expect(client.queueEntryWriter.writeIfAbsent({ ...COMMAND, authority: { principalId: 'clerk-2' } }))
            .rejects.toBeInstanceOf(AppInboxIdempotencyConflictError);
        const unsupported = await client.queueEntryWriter.writeIfAbsent({
            ...COMMAND,
            type: 'app:inventory:unknown',
            topicId: 'app:inventory:unknown',
            resourceId: 'unsupported-request',
            contextId: 'another-warehouse'
        });
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
        expect(await results.findByKey(unsupported.entry.key)).toBeUndefined();
        expect(await queue.getItem(unsupported.entry.key)).toMatchObject({ status: 'NEW', dequeueAudit: { attempts: 0 } });
    });

    it.each([
        { type: 'GROUP_UNKNOWN', dispatched: 'GROUP_UNKNOWN', topicId: 'GROUP_UNKNOWN', operationSource: 'unavailable' },
        { type: 'app:inventory:', dispatched: 'app:inventory:', topicId: 'app:inventory:', operationSource: 'unavailable' },
        { type: 'app:inventory:reserve', dispatched: 'app:inventory:release', topicId: 'app:inventory:reserve', operationSource: 'corrupt' },
        { type: 'app:inventory:reserve', dispatched: 'app:inventory:reserve', topicId: 'app-inbox.group-state', operationSource: 'corrupt' },
        { type: 'app:inventory:reserve', dispatched: 'app:inventory:reserve', topicId: 'app:orders:reserve', operationSource: 'corrupt' },
        { type: 'GROUP_CREATE', dispatched: 'GROUP_UPDATE', topicId: 'app-inbox.group-state', operationSource: 'corrupt' },
        {
            type: 'app:inventory:reserve',
            dispatched: 'app:inventory:reserve',
            topicId: 'app:inventory:reserve',
            operationSource: 'corrupt',
            commandTopic: 'app:orders:reserve'
        }
    ])('refuses operation/envelope/topic mismatch $type $dispatched $topicId', async ({ type, dispatched, topicId, operationSource, commandTopic }) => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue, { newLaneConcurrency: 1 });
        const client = createAppInboxClientRuntime({
            inboxQueueReader: reader,
            resourceInboxRepository: queue,
            resourceInboxResultsRepository: new TestResourceInboxResults(),
            serviceId: 'inventory-worker',
            defaultTopicId: COMMAND.type
        });
        const { entry } = await client.queueEntryWriter.writeIfAbsent(COMMAND);
        expect(validateAppInboxCommandIdentity({
            ...entry,
            key: { ...entry.key, topicId },
            resource: JSON.stringify({
                payload: { typeId: dispatched, resource: JSON.stringify({ ...COMMAND, type, topicId: commandTopic ?? COMMAND.topicId }) }
            })
        })).toMatchObject({ valid: false, identity: { operationSource } });
    });
});
