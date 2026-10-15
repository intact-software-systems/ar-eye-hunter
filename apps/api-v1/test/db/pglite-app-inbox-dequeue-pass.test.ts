import { Temporal } from '@js-temporal/polyfill';
import assert from 'node:assert/strict';

import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { createAppInboxRetryFinalizer } from '@shared-server/rallar-system/app-inbox/app-inbox-retry-finalization.ts';
import { CLIENT_STATE_APP_INBOX_TOPIC } from '@shared-server/rallar-system/app-inbox/app-inbox-topics.ts';
import { createAppInboxClientRuntime } from '@shared-server/rallar-system/app-inbox/client/create-app-inbox-client-runtime.ts';
import {
    computeAppInboxCompletion,
    validateAppInboxCompletion
} from '@shared-server/rallar-system/app-inbox/handler/app-inbox-completion-computation.ts';
import { AppInboxDequeuePassTiming } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-dequeue-pass-timing.ts';
import { createAppInboxHandlerRuntime } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-handler-runtime.ts';
import { registerApplicationQueueReaderTasks } from '@shared-server/rallar-system/middleware/rallar-middleware-queue-registration.ts';
import { nowMs, type RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { ResourceInboxCompletionNotifications } from '@shared/queuebox/resource-inbox/resource-inbox-completion-notifications.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';
import { createApiV1TestMiddlewareResilience } from '../api-v1-test-queue-resilience.ts';
import { waitForPGliteQueueRow } from './pglite-app-inbox-test-runtime.ts';
import { withPGliteSql } from './pglite-auth-test-harness.ts';

const SERVICE_ID = 'pglite-dequeue-pass';
const REQUEST_ID = 'dequeue-pass-request-000001';
const OVERDUE_REQUEST_ID = 'dequeue-pass-overdue-000001';

/**
 * One NEW item through the registered engine pass on its own executor: the inbox probe is one statement, the
 * NEW claim is one statement and a handler-finalized item needs no release. The outbox task probes an
 * in-memory queue here so its probe does not land on the counted executor during the pass.
 */
const EXPECTED_PASS_STATEMENTS_OUTSIDE_HANDLER = 2;
const EXPECTED_HANDLER_STATEMENTS = 3;
/**
 * An overdue row is also a due row, so the probe advertises RETRY beside FAIRNESS: the probe, the FAIRNESS
 * lane's select and start, the RETRY lane's one-statement claim that then finds nothing, and the retry
 * pressure page read the advertised RETRY lane asks for once per second.
 */
const EXPECTED_OVERDUE_PASS_STATEMENTS_OUTSIDE_HANDLER = 5;

interface DequeuePassRuntime {
    readonly timing: RallarTimingEvent[];
    readonly engine: InboxOutboxEngine;
    readonly queueInbox: ReturnType<typeof createPSqlResourceInboxRepository>;
    readonly resilience: ReturnType<typeof createApiV1TestMiddlewareResilience>;
    enqueue(resourceId: string): ReturnType<ReturnType<typeof createAppInboxClientRuntime>['queueEntryWriter']['enqueue']>;
}

Deno.test('PGlite AppInbox dequeue pass reports its statements outside the handler per claimed item and the handler reports its own', async () => {
    await withPGliteSql(async (sql) => {
        const runtime = createDequeuePassRuntime(sql);
        const { timing, engine, queueInbox } = runtime;

        const enqueued = await runtime.enqueue(REQUEST_ID);
        await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
        const countersBeforePass = sql.getExecutorCounters?.();
        await engine.executeOnce();
        await engine.stop();
        const countersAfterPass = sql.getExecutorCounters?.();

        assert.equal((await queueInbox.entries.findAnyByKey(enqueued.key))?.status, EntityStatus.COMPLETED);
        const passLines = timing.filter((event) => event.component === 'app-inbox-phase' && event.operation === 'dequeue-pass');
        const handlerAction = timing.find((event) => event.component === 'app-inbox-phase' && event.operation === 'handler-action');
        const transaction = timing.find((event) => event.component === 'app-inbox-phase' && event.operation === 'transaction');
        assert.equal(passLines.length, 1, JSON.stringify(timing.map((event) => event.operation)));
        assert.deepEqual(passLines[0]?.details, {
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            topicId: CLIENT_STATE_APP_INBOX_TOPIC,
            contextId: 'dequeue-pass-client',
            resourceId: REQUEST_ID,
            senderId: handlerAction?.details?.senderId,
            attempt: 1,
            selectedLane: 'NEW',
            queueAgeMs: passLines[0]?.details?.queueAgeMs,
            dueAgeMs: passLines[0]?.details?.dueAgeMs,
            statements: EXPECTED_PASS_STATEMENTS_OUTSIDE_HANDLER,
            executorWaitMs: passLines[0]?.details?.executorWaitMs,
            lanesProbed: 'NEW',
            claimedInPass: 1
        });
        assert.equal(passLines[0]?.requestId, REQUEST_ID);
        assert.equal(handlerAction?.details?.statements, EXPECTED_HANDLER_STATEMENTS, 'the handler read plus its two-statement transaction');
        assert.equal(transaction?.details?.statements, 2, 'reservation finish and result replacement');
        assert.ok(typeof passLines[0]?.details?.executorWaitMs === 'number' && passLines[0].details.executorWaitMs >= 0);
        assert.equal(
            (countersAfterPass?.statements ?? 0) - (countersBeforePass?.statements ?? 0),
            EXPECTED_PASS_STATEMENTS_OUTSIDE_HANDLER + EXPECTED_HANDLER_STATEMENTS,
            'the whole pass is the probe, the claim and the handler'
        );
    });
});

Deno.test('PGlite AppInbox dequeue pass claims an overdue retry on the FAIRNESS lane', async () => {
    await withPGliteSql(async (sql) => {
        const runtime = createDequeuePassRuntime(sql);
        const { timing, engine, queueInbox } = runtime;
        const enqueued = await runtime.enqueue(OVERDUE_REQUEST_ID);
        await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
        await sql`
            update resource_inbox
            set ri_status = 'RETRY', ri_attempts = 1,
                start_ts = (now() at time zone 'UTC') - interval '40 seconds',
                end_ts = (now() at time zone 'UTC') - interval '39 seconds',
                next_ts = (now() at time zone 'UTC') - interval '31 seconds'
            where ri_resource_id = ${OVERDUE_REQUEST_ID}
        `;

        await engine.executeOnce();
        await engine.stop();

        assert.equal((await queueInbox.entries.findAnyByKey(enqueued.key))?.status, EntityStatus.COMPLETED);
        const transaction = timing.find((event) => event.component === 'app-inbox-phase' && event.operation === 'transaction');
        const passLine = timing.find((event) => event.component === 'app-inbox-phase' && event.operation === 'dequeue-pass');
        assert.equal(transaction?.details?.selectedLane, 'FAIRNESS');
        assert.equal(transaction?.details?.attempt, 2);
        assert.equal(transaction?.details?.resourceId, OVERDUE_REQUEST_ID);
        assert.equal(transaction?.details?.type, AppInboxType.CLIENT_PRINCIPAL_UPSERT);
        assert.ok(typeof transaction?.details?.dueAgeMs === 'number' && transaction.details.dueAgeMs >= 30_000, JSON.stringify(transaction?.details));
        assert.equal(passLine?.details?.lanesProbed, 'RETRY,FAIRNESS');
        assert.equal(passLine?.details?.statements, EXPECTED_OVERDUE_PASS_STATEMENTS_OUTSIDE_HANDLER);
    });
});

function createDequeuePassRuntime(sql: PGliteSql): DequeuePassRuntime {
    const timing: RallarTimingEvent[] = [];
    const completionNotifications = ResourceInboxCompletionNotifications.createDefault();
    const queueInbox = createPSqlResourceInboxRepository(sql, () => new Date());
    const queueBox = new PSqlQueueBox(queueInbox, Temporal.Now.instant);
    const finalizeAppInboxRetry = createAppInboxRetryFinalizer({ completionNotifications, database: sql });
    const inboxQueueReader = new InboxQueueReader(queueBox, {
        completionNotifications,
        onRetryExhausted: finalizeAppInboxRetry,
        onRetryExhaustionRecovery: finalizeAppInboxRetry
    });
    inboxQueueReader.onDequeuePassDo(
        new AppInboxDequeuePassTiming({ database: sql, nowMs }, { serviceId: SERVICE_ID, sink: (event) => timing.push(event) })
    );
    const outboxQueueReader = new OutboxQueueReader(new InMemoryQueueBox());
    const queueEntryWriter = createAppInboxClientRuntime({
        inboxQueueReader,
        resourceInboxRepository: queueInbox.entries,
        resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
        serviceId: SERVICE_ID,
        defaultTopicId: CLIENT_STATE_APP_INBOX_TOPIC
    }).queueEntryWriter;
    const handlerRuntime = createAppInboxHandlerRuntime({
        inboxQueueReader,
        resultRepository: new ResourceInboxResultsRepository(sql),
        database: sql,
        serviceId: SERVICE_ID,
        timing: (event) => timing.push(event),
        options: { phaseTiming: true }
    });
    handlerRuntime.registry.registerHandler<JsonWireValue, JsonWireValue>({
        type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
        decodeCommand: (value) => value,
        encodeResult: (result) => result,
        handle: async (_command, context) => {
            await sql`select 1 as handler_read`;
            const completionInput = {
                ...handlerRuntime.transactionWriter.readCompletionFacts(context),
                status: EntityStatus.COMPLETED,
                durableResult: { accepted: true }
            } as const;
            const completion = computeAppInboxCompletion(completionInput);
            assert.deepEqual(validateAppInboxCompletion(completionInput, completion), []);
            return await handlerRuntime.transactionWriter.writeComputedMutation(context, completion, async () => {});
        }
    });
    const resilience = createApiV1TestMiddlewareResilience();
    const engine = new InboxOutboxEngine();
    registerApplicationQueueReaderTasks({
        engine,
        nowEpochMs: Date.now,
        inboxQueueReader,
        outboxQueueReader,
        appInboxResilience: resilience.inbox,
        appOutboxResilience: resilience.appOutbox
    });

    return {
        timing,
        engine,
        queueInbox,
        resilience,
        enqueue: (resourceId) =>
            queueEntryWriter.enqueue({
                type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
                resourceId,
                contextId: 'dequeue-pass-client',
                data: { requestId: resourceId }
            })
    };
}
