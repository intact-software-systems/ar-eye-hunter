import { Temporal } from '@js-temporal/polyfill';
import assert from 'node:assert/strict';

import type {
    PSqlParameter,
    PSqlRows,
    PSqlSql
} from '@shared-server/postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
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
import type { ResourceInboxAttemptReleaseTelemetry } from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import { ResourceInboxCompletionNotifications } from '@shared/queuebox/resource-inbox/resource-inbox-completion-notifications.ts';
import { EntityStatus, isKeysEqual } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { createApiV1TestQueueResilience } from '../api-v1-test-queue-resilience.ts';
import { waitForPGliteQueueRow } from './pglite-app-inbox-test-runtime.ts';
import { withPGliteSql } from './pglite-auth-test-harness.ts';

const SERVICE_ID = 'pglite-release-statements';

Deno.test('PGlite AppInbox success committed by its handler transaction updates no inbox row afterwards and notifies its waiter once per finalized entry', async () => {
    await withPGliteSql(async (sql) => {
        const statements: string[] = [];
        const recordingSql = recordStatements(sql, statements);
        const completionNotifications = ResourceInboxCompletionNotifications.createDefault();
        const published: string[] = [];
        const publish = completionNotifications.publish.bind(completionNotifications);
        completionNotifications.publish = (key) => {
            published.push(key.resourceId);
            publish(key);
        };
        const releases: ResourceInboxAttemptReleaseTelemetry[] = [];
        let handlerCommittedAt: number | undefined;
        const queueInbox = createPSqlResourceInboxRepository(recordingSql, () => new Date());
        const inboxQueueReader = new InboxQueueReader(new PSqlQueueBox(queueInbox, Temporal.Now.instant), {
            completionNotifications,
            onAttemptReleaseTelemetry: (release) => {
                releases.push(release);
            }
        });
        const commandClient = createAppInboxClientRuntime({
            inboxQueueReader,
            resourceInboxRepository: createPSqlResourceInboxRepository(sql, () => new Date()).entries,
            resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
            serviceId: SERVICE_ID,
            defaultTopicId: CLIENT_STATE_APP_INBOX_TOPIC,
            options: { waitMaxElapsedMsecs: 5_000, waitRetryIntervalMsecs: 1, waitMaxRetryIntervalMsecs: 2, waitJitterRatio: 0 }
        }).commandClient;
        const handlerRuntime = createAppInboxHandlerRuntime({
            inboxQueueReader,
            resultRepository: new ResourceInboxResultsRepository(recordingSql),
            database: recordingSql,
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
                    durableResult: { accepted: true }
                } as const;
                const completion = computeAppInboxCompletion(completionInput);
                assert.deepEqual(validateAppInboxCompletion(completionInput, completion), []);
                const result = await handlerRuntime.transactionWriter.writeComputedMutation(context, completion, async () => {});
                handlerCommittedAt = statements.length;
                return result;
            }
        });

        const pending = commandClient.enqueueAndWait({
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            resourceId: 'release-statements-request',
            contextId: 'release-statements-group',
            data: { requestId: 'release-statements-request' }
        });
        await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
        await inboxQueueReader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createApiV1TestQueueResilience());

        const result = await pending;
        assert.deepEqual(result.right, { accepted: true }, JSON.stringify(result.left));
        assert.ok(handlerCommittedAt !== undefined);
        assert.deepEqual(
            statements.slice(handlerCommittedAt).filter((statement) => /update\s+resource_inbox\b/i.test(statement)),
            [],
            'The committed handler transaction already finalized the entry'
        );
        assert.equal(releases.length, 1);
        assert.equal(releases[0]?.status, EntityStatus.COMPLETED);
        assert.equal(releases[0]?.classification, 'accepted');
        assert.deepEqual(published, ['release-statements-request'], 'Each finalized entry wakes its waiter exactly once');
        const stored = await queueInbox.entries.findAnyByKey(releases[0]!.key);
        assert.equal(stored?.status, EntityStatus.COMPLETED);
        assert.equal(stored?.dequeueAudit.attempts, 1);
        assert.ok(stored && isKeysEqual(stored.key, releases[0]!.key));
    });
});

function recordStatements(sql: PSqlSql, statements: string[]): PSqlSql {
    const recording = function<Rows extends PSqlRows> (
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: PSqlParameter[]
    ): Promise<Rows> | object {
        if (!isTemplateStringsArray(stringsOrValues)) {
            return sql(stringsOrValues);
        }
        statements.push(stringsOrValues.join('?'));
        return sql<Rows>(stringsOrValues, ...values);
    } as PSqlSql;
    recording.begin = async (write) => {
        statements.push('begin');
        const result = await sql.begin(async (transaction) => await write(recordStatements(transaction, statements)));
        statements.push('commit');
        return result;
    };
    return recording;
}

function isTemplateStringsArray(
    value: TemplateStringsArray | readonly PSqlParameter[]
): value is TemplateStringsArray {
    return Array.isArray(value) && Object.hasOwn(value, 'raw');
}
