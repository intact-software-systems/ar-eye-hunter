import { Temporal } from '@js-temporal/polyfill';
import assert from 'node:assert/strict';

import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { AppInboxType, type AppInboxEnqueueInput } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import { CLIENT_STATE_APP_INBOX_TOPIC } from '@shared-server/rallar-system/app-inbox/app-inbox-topics.ts';
import { createAppInboxClientRuntime } from '@shared-server/rallar-system/app-inbox/client/create-app-inbox-client-runtime.ts';
import { computeAppInboxCompletion } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-completion-computation.ts';
import { createAppInboxHandlerRuntime } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-handler-runtime.ts';
import { registerApplicationQueueReaderTasks } from '@shared-server/rallar-system/middleware/rallar-middleware-queue-registration.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import {
    createAppInboxCompletionRelay,
    installAppInboxCompletionNoticeSubscriber,
    type AppInboxCompletionNoticeChannel
} from '@shared-server/rallar-system/queue-pubsub/app-inbox-completion-notice.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { ResourceInboxCompletionNotifications } from '@shared/queuebox/resource-inbox/resource-inbox-completion-notifications.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import type { ApiV1DatabaseNotificationPort } from '../../src/db/api-v1-database-lifecycle.ts';
import { createApiV1AppInboxCompletionNotices } from '../../src/db/create-postgres-app-inbox-completion-notice-transport.ts';
import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';
import { createApiV1TestMiddlewareResilience } from '../api-v1-test-queue-resilience.ts';
import { waitForPGliteQueueRow } from './pglite-app-inbox-test-runtime.ts';
import { withPGliteSql } from './pglite-auth-test-harness.ts';

const REQUEST_ID = 'remote-completion-request-0001';
/** Well below the waiter's one-second safety tick: only a relayed wake returns this early. */
const REMOTE_WAKE_ALLOWANCE_MS = 300;

interface ServerRuntime {
    readonly client: ReturnType<typeof createAppInboxClientRuntime>;
    readonly engine: InboxOutboxEngine;
}

/** A WebSocket connect is awaited by its upgrade route, so its completion is relayed like any other awaited type. */
for (const type of [AppInboxType.CLIENT_PRINCIPAL_UPSERT, AppInboxType.CLIENT_AUTHORISED_WS_CONNECT] as const) {
    Deno.test(`PGlite AppInbox ${type} waiter on one server returns promptly when another server handles its entry`, async () => {
        await verifyRemoteCompletion(type, (client, command) => client.commandClient.enqueueAndWait(command));
    });
}

/** A winner waits for its wake before its first read, so only the relayed wake can return it before the safety tick. */
Deno.test('PGlite AppInbox reservation winner on one server returns promptly when another server handles its entry', async () => {
    await verifyRemoteCompletion(AppInboxType.CLIENT_AUTHORISED_WS_CONNECT, (client, received) => {
        const command = { ...received, topicId: CLIENT_STATE_APP_INBOX_TOPIC };
        return client.commandClient.reserveMaterializedAndWaitForResult(
            { received: command, placeholder: command, materialize: async () => command },
            (value) => value
        );
    });
});

async function verifyRemoteCompletion(
    type: AppInboxType,
    waitForCommand: (client: ServerRuntime['client'], command: AppInboxEnqueueInput) => Promise<Either<AppInboxFailure, JsonWireValue>>
): Promise<void> {
    await withPGliteSql(async (sql) => {
        const notification = createMemoryNotificationPort();
        const waiterNotices = createCompletionNotices(notification, 'server-a');
        const handlerNotices = createCompletionNotices(notification, 'server-b');
        const waiterNotifications = createRelayedNotifications(waiterNotices);
        const handlerNotifications = createRelayedNotifications(handlerNotices);
        const waiterServer = createServerRuntime(sql, 'server-a', waiterNotifications, type);
        const handlerServer = createServerRuntime(sql, 'server-b', handlerNotifications, type);
        await installAppInboxCompletionNoticeSubscriber({ ...waiterNotices, notifications: waiterNotifications });
        await installAppInboxCompletionNoticeSubscriber({ ...handlerNotices, notifications: handlerNotifications });

        const waited = waitForCommand(waiterServer.client, {
            type,
            resourceId: REQUEST_ID,
            contextId: 'remote-completion-client',
            data: { requestId: REQUEST_ID }
        });
        await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
        await new Promise((resolve) => setTimeout(resolve, 20));
        const handledAt = performance.now();
        await handlerServer.engine.executeOnce();
        const result = await waited;
        const returnedAfterMs = performance.now() - handledAt;
        await handlerServer.engine.stop();
        await waiterServer.engine.stop();

        assert.deepEqual(result.right, { accepted: true });
        assert.ok(
            returnedAfterMs < REMOTE_WAKE_ALLOWANCE_MS,
            `the waiter returned ${Math.round(returnedAfterMs)} ms after the remote handler`
        );
    });
}

function createCompletionNotices(
    notification: ApiV1DatabaseNotificationPort,
    publisherId: string
): AppInboxCompletionNoticeChannel {
    const notices = createApiV1AppInboxCompletionNotices({ mode: 'postgres', notification, publisherId });
    assert.ok(notices);
    return notices;
}

function createRelayedNotifications(notices: AppInboxCompletionNoticeChannel): ResourceInboxCompletionNotifications {
    return ResourceInboxCompletionNotifications.createDefault(createAppInboxCompletionRelay(notices));
}

/** PostgreSQL NOTIFY semantics: a JSON payload delivered asynchronously to every listener, the publisher included. */
function createMemoryNotificationPort(): ApiV1DatabaseNotificationPort {
    const listeners = new Map<string, Array<(payload: string) => void | Promise<void>>>();
    return {
        notify: (channel, message) => {
            const payload = JSON.stringify(message);
            for (const listener of listeners.get(channel) ?? []) {
                setTimeout(() => void listener(payload), 0);
            }
            return Promise.resolve();
        },
        listen: (channel, onMessage) => {
            listeners.set(channel, [...(listeners.get(channel) ?? []), onMessage]);
            return Promise.resolve();
        }
    };
}

function createServerRuntime(
    sql: PGliteSql,
    serviceId: string,
    completionNotifications: ResourceInboxCompletionNotifications,
    type: AppInboxType
): ServerRuntime {
    const queueInbox = createPSqlResourceInboxRepository(sql, () => new Date());
    const inboxQueueReader = new InboxQueueReader(new PSqlQueueBox(queueInbox, Temporal.Now.instant), {
        laneBudgetPolicy: 'fixed-retry-two',
        newLaneConcurrency: 1,
        completionNotifications
    });
    const client = createAppInboxClientRuntime({
        inboxQueueReader,
        resourceInboxRepository: queueInbox.entries,
        resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
        serviceId,
        defaultTopicId: CLIENT_STATE_APP_INBOX_TOPIC
    });
    const handlerRuntime = createAppInboxHandlerRuntime({
        inboxQueueReader,
        resultRepository: new ResourceInboxResultsRepository(sql),
        database: sql,
        serviceId
    });
    handlerRuntime.registry.registerHandler<JsonWireValue, JsonWireValue>({
        type,
        decodeCommand: (value) => value,
        encodeResult: (result) => result,
        handle: async (_command, context) =>
            await handlerRuntime.transactionWriter.writeComputedMutation(
                context,
                computeAppInboxCompletion({
                    ...handlerRuntime.transactionWriter.readCompletionFacts(context),
                    status: EntityStatus.COMPLETED,
                    durableResult: { accepted: true }
                }),
                async () => {}
            )
    });
    const resilience = createApiV1TestMiddlewareResilience();
    const engine = new InboxOutboxEngine();
    registerApplicationQueueReaderTasks({
        engine,
        nowEpochMs: Date.now,
        inboxQueueReader,
        outboxQueueReader: new OutboxQueueReader(new InMemoryQueueBox()),
        appInboxResilience: resilience.inbox,
        appOutboxResilience: resilience.appOutbox
    });
    return { client, engine };
}
