import { Temporal } from '@js-temporal/polyfill';
import assert from 'node:assert/strict';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { writeResourceInboxReservationFinish } from '@shared-server/queuebox/postgres/resource-inbox-reservation-write.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { CLIENT_STATE_APP_INBOX_TOPIC } from '@shared-server/rallar-system/app-inbox/app-inbox-topics.ts';
import { createAppInboxClientRuntime } from '@shared-server/rallar-system/app-inbox/client/create-app-inbox-client-runtime.ts';
import {
    computeAppInboxCompletion,
    validateAppInboxCompletion
} from '@shared-server/rallar-system/app-inbox/handler/app-inbox-completion-computation.ts';
import { createAppInboxHandlerRuntime } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-handler-runtime.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import {
    newALRoute,
    newALUntargetedMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import {
    createApiV1TestMiddlewareResilience,
    createApiV1TestQueueResilience
} from '../api-v1-test-queue-resilience.ts';
import { waitForPGliteQueueRow } from './pglite-app-inbox-test-runtime.ts';
import { withPGliteSql } from './pglite-auth-test-harness.ts';

const SERVICE_ID = 'pglite-reservation-lease';
const REQUEST_ID = 'reservation-lease-request';

Deno.test('PGlite AppInbox reclaims a reservation abandoned past its lease and refuses the stale finisher', async () => {
    await withPGliteSql(async (sql) => {
        const inbox = createPSqlResourceInboxRepository(sql, () => new Date());
        const queueBox = new PSqlQueueBox(inbox, Temporal.Now.instant);
        const inboxQueueReader = new InboxQueueReader(queueBox, { laneBudgetPolicy: 'fixed-retry-two' });
        const results = new ResourceInboxResultsRepository(sql);
        const commandClient = createAppInboxClientRuntime({
            inboxQueueReader,
            resourceInboxRepository: inbox.entries,
            resourceInboxResultsRepository: results,
            serviceId: SERVICE_ID,
            defaultTopicId: CLIENT_STATE_APP_INBOX_TOPIC,
            options: { waitMaxElapsedMsecs: 5_000, waitRetryIntervalMsecs: 1, waitMaxRetryIntervalMsecs: 2, waitJitterRatio: 0 }
        }).commandClient;
        const handlerRuntime = createAppInboxHandlerRuntime({
            inboxQueueReader,
            resultRepository: results,
            database: sql,
            serviceId: SERVICE_ID
        });
        handlerRuntime.registry.registerHandler<JsonWireValue, JsonWireValue>({
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            decodeCommand: (value) => value,
            encodeResult: (result) => result,
            handle: async (_command, context) => {
                const completionInput = {
                    ...handlerRuntime.transactionWriter.readCompletionFacts(context),
                    status: EntityStatus.COMPLETED,
                    durableResult: { reclaimedAttempt: context.entry.dequeueAudit.attempts }
                } as const;
                const completion = computeAppInboxCompletion(completionInput);
                assert.deepEqual(validateAppInboxCompletion(completionInput, completion), []);
                return await handlerRuntime.transactionWriter.writeComputedMutation(context, completion, async () => {});
            }
        });
        const resilience = createApiV1TestQueueResilience();

        const pending = commandClient.enqueueAndWait({
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            resourceId: REQUEST_ID,
            contextId: 'reservation-lease-client',
            data: { requestId: REQUEST_ID }
        });
        await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
        const [enqueued] = await sql<{ ri_topic_id: string; }[]>`
            select ri_topic_id from resource_inbox where ri_resource_id = ${REQUEST_ID}
        `;
        const key = { topicId: enqueued!.ri_topic_id, resourceId: REQUEST_ID, contextId: 'reservation-lease-client' };
        const abandoned = await inbox.reservations.startProcessingEntity((await inbox.entries.findByKey(key))!);
        assert.equal(abandoned.right?.dequeueAudit.attempts, 1);
        await sql`
            update resource_inbox set start_ts = start_ts - interval '61 seconds'
            where ri_resource_id = ${REQUEST_ID}
        `;

        assert.equal(
            await queueBox.isAnyEntryToLock(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience.toWorkAdvertisementOptions()),
            true,
            'A reservation older than the AppInbox lease is advertised as work'
        );
        await inboxQueueReader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience);

        assert.deepEqual((await pending).right, { reclaimedAttempt: 2 });
        const staleFinish = await writeResourceInboxReservationFinish(sql, {
            key,
            expectedAttempts: 1,
            status: EntityStatus.FAILED,
            completedAt: new Date()
        });
        assert.equal(staleFinish, false, 'The abandoned attempt can no longer finish the reclaimed entry');
        const stored = await inbox.entries.findAnyByKey(key);
        assert.equal(stored?.status, EntityStatus.COMPLETED);
        assert.equal(stored?.dequeueAudit.attempts, 2);
    });
});

Deno.test('PGlite composed queue leases keep an AppInbox claim for 60 s and an outbox claim for five minutes', async () => {
    await withPGliteSql(async (sql) => {
        const inbox = createPSqlResourceInboxRepository(sql, () => new Date());
        const queueBox = new PSqlQueueBox(inbox, Temporal.Now.instant);
        const appInboxEntry = await new InboxQueueReader(queueBox, { laneBudgetPolicy: 'fixed-retry-two' }).enqueueIfAbsent(
            toLeaseMessage(AppInboxType.CLIENT_PRINCIPAL_UPSERT, 'lease-app-inbox-request')
        );
        const outboxEntry = await new OutboxQueueReader(queueBox).enqueueIfAbsent(
            toLeaseMessage('lease.app-outbox', 'lease-app-outbox-request')
        );
        for (const enqueued of [appInboxEntry, outboxEntry]) {
            const claim = await inbox.reservations.startProcessingEntity((await inbox.entries.findByKey(enqueued.key))!);
            assert.equal(claim.right?.status, EntityStatus.RESERVED);
        }
        const isAppInboxClaimReclaimable = async () =>
            await queueBox.isAnyEntryToLock(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                createApiV1TestMiddlewareResilience().inbox.toWorkAdvertisementOptions()
            );
        const readOutboxClaimsReclaimable = async () => [
            await queueBox.isAnyEntryToLock(
                OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
                createApiV1TestMiddlewareResilience().appOutbox.toWorkAdvertisementOptions()
            ),
            await queueBox.isAnyEntryToLock(
                OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
                createApiV1TestMiddlewareResilience().outbox.toWorkAdvertisementOptions()
            )
        ];

        await ageReservations(sql, 59);
        assert.equal(await isAppInboxClaimReclaimable(), false, 'A 59 s AppInbox claim is still within its lease');
        await ageReservations(sql, 2);
        assert.equal(await isAppInboxClaimReclaimable(), true);
        assert.deepEqual(await readOutboxClaimsReclaimable(), [false, false], 'A 61 s outbox claim is still within its lease');
        await ageReservations(sql, 240);
        assert.deepEqual(await readOutboxClaimsReclaimable(), [true, true]);
    });
});

function toLeaseMessage(type: string, requestId: string): ALMessage {
    return newALUntargetedMessage(
        SERVICE_ID,
        newALRoute(CLIENT_STATE_APP_INBOX_TOPIC, 'lease-client', requestId),
        type,
        { requestId }
    );
}

async function ageReservations(sql: PSqlSql, seconds: number): Promise<void> {
    await sql`
        update resource_inbox set start_ts = start_ts - make_interval(secs => ${seconds})
        where ri_status = 'RESERVED'
    `;
}
