import assert from 'node:assert/strict';

import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { AppOutboxType } from '@shared-server/rallar-system/app-outbox/app-outbox-type.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { requiresClientWrite } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import { toClientMutationIssuedSessionAuthority } from '@shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts';
import { toClientMutationCommand } from '@shared-server/rallar-system/client-state/mutation/client-mutation-command.ts';
import { toUpsertClientPrincipalMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-upsert-client-principal-mutation-input.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
import { groupStateEventWorkspaceKey } from '@shared-server/rallar-system/state-events/postgres/group-state-event-workspace-key.ts';
import { PSqlClientStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-repository.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { APP_OUTBOX_RTC_TOPOLOGY_TOPIC } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-entry.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { GROUP_PRESENCE_SUMMARY_TOPIC as APP_OUTBOX_GROUP_PRESENCE_SUMMARY_TOPIC } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { assertGroupPresenceSummaryAppToWsLifecycle } from '../../../../packages/tests/shared-server/rallar-system/app-outbox/postgres/worker-outbox-lifecycle-assertions.ts';
import { toResilienceDto } from '../api-v1-test-queue-resilience.ts';
import { readPGliteAppInboxFailure, waitForPGliteQueueRow } from './pglite-app-inbox-test-runtime.ts';
import { withPGliteSql } from './pglite-auth-test-harness.ts';

const FUTURE_MS = Date.parse('9999-12-31T23:59:59.999Z');
const PAST_MS = Date.parse('2000-01-01T00:00:00.000Z');

interface ResourceInboxStatusRow {
    readonly ri_type_id: string;
    readonly ri_status: string;
}

interface NumericCountRow {
    readonly count: string | number;
}

interface StringCountRow {
    readonly count: string;
}

interface ResourceInboxLifecycleRow {
    readonly ri_resource_id: string;
    readonly ri_topic_id: string;
    readonly ri_type_id: string;
    readonly ri_status: string;
    readonly ri_resource: string;
}

interface ResourceInboxForeignKeyRow {
    readonly ri_topic_id: string;
    readonly ri_resource_id: string;
    readonly fk_ext_bank_id: string;
}

interface ResourceInboxTopicTypeRow {
    readonly ri_topic_id: string;
    readonly ri_type_id: string;
}

interface NumericValueRow {
    readonly value: number;
}

interface StringValueRow {
    readonly value: string;
}

Deno.test(
    'PGlite AppInbox accepts current typed failures and rejects non-current shapes',
    async () => {
        await withPGliteSql(async (sql) => {
            const baseFailure = {
                error: 'Client mutation rejected',
                code: 'client-mutation-rejected',
                message: 'Client mutation rejected',
                status: 422
            } as const;
            const policyDenial = {
                error: 'Forbidden: Invite required.',
                code: 'group-invite-required',
                message: 'Invite required.',
                details: { groupId: 'non-current-room' }
            } as const;
            const canonicalFailure = {
                type: 'app-inbox-failure',
                code: 'client-mutation-rejected',
                status: 422,
                message: 'Canonical validation failed',
                issues: null,
                denial: null,
                retry: null
            } as const;
            const nonCurrentRetryExhaustion = {
                type: 'app-inbox-retry-exhausted',
                commandIdentity: {
                    contextId: 'non-current-context',
                    resourceId: 'non-current-retry',
                    topicId: 'app-inbox.group-state',
                    operation: 'GROUP_CREATE',
                    operationSource: 'command'
                },
                selectedLane: 'retry',
                processingAttempts: 8,
                reservationAttempt: 8,
                lastError: {
                    source: 'processing',
                    code: 'app-inbox-transient',
                    message: 'AppInbox processing encountered a retryable transient failure'
                },
                queueAgeMs: 25,
                dueAgeMs: 5,
                exhaustedAtEpochMs: 1_000
            } as const;
            const nonCurrentRetryRecovery = {
                type: 'app-inbox-retry-exhausted',
                commandIdentity: {
                    contextId: 'non-current-context',
                    resourceId: 'non-current-recovery',
                    topicId: 'app-inbox.group-state',
                    operation: 'GROUP_CREATE',
                    operationSource: 'command'
                },
                selectedLane: 'FINALIZATION',
                processingAttempts: 20,
                reservationAttempt: 22,
                lastError: {
                    source: 'finalization-recovery',
                    code: 'app-inbox-finalization-recovery',
                    message: 'AppInbox retry exhaustion finalization is being recovered'
                },
                queueAgeMs: 60_000,
                dueAgeMs: 300_000,
                selectedDueAtEpochMs: 700,
                finalizedAtEpochMs: 1_000
            } as const;
            const current = await readPGliteAppInboxFailure(
                sql,
                'current-failure',
                canonicalFailure
            );
            assert.deepEqual(current.left, canonicalFailure);

            const nonCurrentCases = [
                {
                    name: 'raw-string',
                    resource: 'non-current raw failure'
                },
                {
                    name: 'base-object',
                    resource: baseFailure
                },
                {
                    name: 'policy-denial',
                    resource: policyDenial
                },
                {
                    name: 'retry-exhaustion',
                    resource: nonCurrentRetryExhaustion
                },
                {
                    name: 'retry-recovery',
                    resource: nonCurrentRetryRecovery
                },
                {
                    name: 'malformed',
                    resource: { error: 'partial impostor', code: 'forged' }
                }
            ] as const;

            for (const testCase of nonCurrentCases) {
                const result = await readPGliteAppInboxFailure(
                    sql,
                    `non-current-failure-${testCase.name}`,
                    testCase.resource
                );
                assert.deepEqual(result.left, {
                    type: 'app-inbox-failure',
                    code: 'app-inbox-persisted-failure-corrupt',
                    status: 500,
                    message: 'Persisted AppInbox failure is corrupt',
                    issues: null,
                    denial: null,
                    retry: null
                }, testCase.name);
            }
        });
    }
);

Deno.test(
    'PGlite AppGroup commits group mutation and summary fan-out through fenced queue transactions',
    async () => {
        await withPGliteSql(async (sql) => {
            const runtime = new PSqlRuntimeStateRepository(sql);
            const resourceInbox = createPSqlResourceInboxRepository(sql);
            const resourceResults = new ResourceInboxResultsRepository(sql);
            const queue = new PSqlQueueBox(resourceInbox);
            const inboxReader = new InboxQueueReader(queue);
            const outboxReader = new OutboxQueueReader(queue);
            const nowEpochMs = Date.parse('2026-07-22T00:00:00.000Z');
            const authority = {
                clientId: 'alice',
                sessionId: 'alice-session',
                accessToken: 'alice-token',
                username: 'alice',
                issuedAtEpochMs: nowEpochMs - 1_000,
                expiresAtEpochMs: FUTURE_MS
            };
            const authSessions = new AuthSessionRepository(runtime);
            await authSessions.putSession(authority);
            const groupState = createGroupStateService({
                readPlannedLayoutIdentity: () => Promise.resolve(null),
                runtimeRepository: runtime,
                groupStateEventStore: new PSqlGroupStateEventRepository(sql),
                authSessionRepository: authSessions,
                serviceId: 'pglite-group-service',
                now: () => nowEpochMs
            });
            const appGroup = new GroupStateInboxService(
                {
                    inboxQueueReader: inboxReader,
                    resourceInboxRepository: resourceInbox.entries,
                    resourceInboxResultsRepository: resourceResults,
                    database: sql,
                    groupStateService: groupState
                },
                {
                    serviceId: 'pglite-group-service',
                    timing: undefined,
                    options: {
                        waitMaxElapsedMsecs: 5_000,
                        waitRetryIntervalMsecs: 1,
                        waitMaxRetryIntervalMsecs: 4,
                        waitJitterRatio: 0,
                        nowEpochMs: () => nowEpochMs
                    }
                }
            );
            const summaryWork = new GroupPresenceSummaryWork({
                outboxQueueReader: outboxReader,
                recomputeDebounceMs: 0,
                runtimeRepository: runtime,
                database: sql,
                serviceId: 'pglite-group-service',
                now: () => nowEpochMs
            });
            outboxReader.onOutboxMessageDo(AppOutboxType.GROUP_PRESENCE_SUMMARY, {
                onMessage: async (message, entry) => await summaryWork.processReservedEntry(message, entry)
            });
            outboxReader.onOutboxMessageDo(
                AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
                { onMessage: () => Promise.resolve() }
            );

            const pending = appGroup.processAuthenticatedGroupEntryUntilCompletion({
                type: AppInboxType.GROUP_CREATE,
                resourceId: 'pglite-app-group-create',
                contextId: 'vertical-app:main:vertical-group',
                senderId: authority.clientId,
                data: {
                    scope: { applicationId: 'vertical-app', workspaceId: 'main' },
                    request: {
                        groupId: 'vertical-group',
                        displayName: 'Vertical Group',
                        kind: 'room',
                        joinMode: 'open',
                        createdByPrincipalId: authority.clientId,
                        actorPrincipalId: authority.clientId,
                        actorSessionId: authority.sessionId,
                        requestId: 'pglite-app-group-create'
                    }
                }
            }, authority);
            await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
            await inboxReader.dequeueInbox(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                toResilienceDto()
            );
            const result = await pending;
            assert.equal(result.right !== undefined, true);

            const ref = {
                applicationId: 'vertical-app',
                workspaceId: 'main',
                groupId: 'vertical-group'
            };
            assert.equal(
                (await new GroupStateRepository(runtime, new PSqlGroupStateEventRepository(runtime.sql)).findGroup(ref))?.displayName,
                'Vertical Group'
            );
            assert.equal((await new PSqlGroupStateEventRepository(sql).listGroupEvents(ref)).length, 1);
            const beforeSummary = await sql<ResourceInboxStatusRow[]>`
      select ri_type_id, ri_status from resource_inbox order by ri_row_id
    `;
            assert.equal(
                beforeSummary.filter((row) =>
                    row.ri_type_id === 'APP_INBOX' &&
                    row.ri_status === 'COMPLETED'
                ).length,
                1
            );
            assert.equal(
                beforeSummary.filter((row) =>
                    row.ri_type_id === 'APP_OUTBOX' &&
                    row.ri_status === 'NEW'
                ).length,
                1
            );
            assert.equal(beforeSummary.filter((row) => row.ri_type_id === 'WS_OUTBOX').length, 0);
            assert.equal(
                Number(
                    (await sql<NumericCountRow[]>`
      select count(*) as count from resource_inbox_results
    `)[0]?.count
                ),
                1
            );

            await outboxReader.dequeueOutbox(
                OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
                toResilienceDto()
            );
            const afterSummary = await sql<ResourceInboxLifecycleRow[]>`
      select ri_resource_id, ri_topic_id, ri_type_id, ri_status, ri_resource
      from resource_inbox order by ri_row_id
    `;
            assertGroupPresenceSummaryAppToWsLifecycle(
                afterSummary,
                afterSummary
                    .filter((row) => row.ri_topic_id === APP_OUTBOX_GROUP_PRESENCE_SUMMARY_TOPIC)
                    .map((row) => row.ri_resource_id)
            );
            assert.equal(
                afterSummary.filter((row) =>
                    row.ri_type_id === 'APP_OUTBOX' &&
                    row.ri_topic_id === APP_OUTBOX_RTC_TOPOLOGY_TOPIC &&
                    row.ri_status === 'COMPLETED'
                ).length,
                1
            );
        });
    }
);

Deno.test(
    'PGlite summary reservation fence rolls back CAS and every downstream row atomically',
    async () => {
        await withPGliteSql(async (sql) => {
            const runtime = new PSqlRuntimeStateRepository(sql);
            const resourceInbox = createPSqlResourceInboxRepository(sql);
            const resourceResults = new ResourceInboxResultsRepository(sql);
            const queue = new PSqlQueueBox(resourceInbox);
            const inboxReader = new InboxQueueReader(queue);
            const nowEpochMs = Date.parse('2026-07-22T00:00:00.000Z');
            const authority = {
                clientId: 'alice',
                sessionId: 'alice-session',
                accessToken: 'alice-token',
                username: 'alice',
                issuedAtEpochMs: nowEpochMs - 1_000,
                expiresAtEpochMs: FUTURE_MS
            };
            const authSessions = new AuthSessionRepository(runtime);
            await authSessions.putSession(authority);
            const groupState = createGroupStateService({
                readPlannedLayoutIdentity: () => Promise.resolve(null),
                runtimeRepository: runtime,
                groupStateEventStore: new PSqlGroupStateEventRepository(sql),
                authSessionRepository: authSessions,
                serviceId: 'pglite-summary-fence',
                now: () => nowEpochMs
            });
            const appGroup = new GroupStateInboxService(
                {
                    inboxQueueReader: inboxReader,
                    resourceInboxRepository: resourceInbox.entries,
                    resourceInboxResultsRepository: resourceResults,
                    database: sql,
                    groupStateService: groupState
                },
                {
                    serviceId: 'pglite-summary-fence',
                    timing: undefined,
                    options: {
                        waitMaxElapsedMsecs: 5_000,
                        waitRetryIntervalMsecs: 1,
                        waitMaxRetryIntervalMsecs: 4,
                        waitJitterRatio: 0,
                        nowEpochMs: () => nowEpochMs
                    }
                }
            );
            const pending = appGroup.processAuthenticatedGroupEntryUntilCompletion({
                type: AppInboxType.GROUP_CREATE,
                resourceId: 'pglite-summary-fence-create',
                contextId: 'fence-app:main:fence-group',
                senderId: authority.clientId,
                data: {
                    scope: { applicationId: 'fence-app', workspaceId: 'main' },
                    request: {
                        groupId: 'fence-group',
                        displayName: 'Fence Group',
                        kind: 'room',
                        joinMode: 'open',
                        createdByPrincipalId: authority.clientId,
                        actorPrincipalId: authority.clientId,
                        actorSessionId: authority.sessionId,
                        requestId: 'pglite-summary-fence-create'
                    }
                }
            }, authority);
            await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
            await inboxReader.dequeueInbox(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                toResilienceDto()
            );
            assert.equal((await pending).right !== undefined, true);

            const [summaryKey] = await sql<ResourceInboxForeignKeyRow[]>`
      select ri_topic_id, ri_resource_id, fk_ext_bank_id
      from resource_inbox
      where ri_topic_id = ${APP_OUTBOX_GROUP_PRESENCE_SUMMARY_TOPIC}
    `;
            assert.ok(summaryKey);
            await sql`
      update resource_inbox
      set ri_status = 'RESERVED', ri_attempts = 1,
          start_ts = now() at time zone 'UTC', end_ts = null, next_ts = null
      where ri_topic_id = ${summaryKey.ri_topic_id}
        and ri_resource_id = ${summaryKey.ri_resource_id}
        and fk_ext_bank_id = ${summaryKey.fk_ext_bank_id}
    `;
            const key = {
                topicId: summaryKey.ri_topic_id,
                resourceId: summaryKey.ri_resource_id,
                contextId: summaryKey.fk_ext_bank_id
            };
            const reserved = await resourceInbox.entries.findAnyByKey(key);
            assert.ok(reserved);
            const message = JSON.parse(reserved.resource) as ALMessage;
            const ref = {
                applicationId: 'fence-app',
                workspaceId: 'main',
                groupId: 'fence-group'
            };
            const repository = new GroupStateRepository(runtime, new PSqlGroupStateEventRepository(runtime.sql));
            const summaryBefore = await repository.findPresenceSummaryEntry(ref);
            const work = new GroupPresenceSummaryWork({
                outboxQueueReader: new OutboxQueueReader(
                    new PSqlQueueBox(createPSqlResourceInboxRepository(sql))
                ),
                recomputeDebounceMs: 0,
                runtimeRepository: runtime,
                database: sql,
                serviceId: 'pglite-summary-fence',
                now: () => nowEpochMs
            });

            await assert.rejects(
                () =>
                    work.processReservedEntry(message, {
                        ...reserved,
                        dequeueAudit: { ...reserved.dequeueAudit, attempts: 2 }
                    }),
                /reservation changed before commit/
            );

            assert.deepEqual(await repository.findPresenceSummaryEntry(ref), summaryBefore);
            const stillReserved = await resourceInbox.entries.findAnyByKey(key);
            assert.equal(stillReserved?.status, EntityStatus.RESERVED);
            assert.equal(stillReserved?.dequeueAudit.attempts, 1);
            const downstream = await sql<ResourceInboxTopicTypeRow[]>`
      select ri_topic_id, ri_type_id
      from resource_inbox
      where ri_type_id in ('WS_OUTBOX', 'APP_OUTBOX')
        and ri_topic_id <> ${APP_OUTBOX_GROUP_PRESENCE_SUMMARY_TOPIC}
    `;
            assert.deepEqual(downstream, []);
        });
    }
);

Deno.test(
    'group event workspace keys encode every required value canonically',
    () => {
        const workspaces = ['_', '%5F', 'main', 'a:b', 'a%3Ab', '＿'];
        const keys = workspaces.map(groupStateEventWorkspaceKey);
        assert.equal(groupStateEventWorkspaceKey('_'), '_');
        assert.equal(groupStateEventWorkspaceKey('main'), 'main');
        assert.equal(new Set(keys).size, workspaces.length);
        assert.throws(() => groupStateEventWorkspaceKey(''));
    }
);

Deno.test(
    'PGlite SQL adapter supports tagged templates, array interpolation, and transactions',
    async () => {
        await withPGliteSql(async (sql) => {
            const scalarRows = await sql<NumericValueRow[]>`
            select ${1}::int as value
        `;

            assert.deepEqual(scalarRows, [{ value: 1 }]);

            const arrayRows = await sql<StringValueRow[]>`
            select value
            from (values ('a'), ('b'), ('c')) as t(value)
            where value in ${sql(['a', 'c'])}
            order by value
        `;

            assert.deepEqual(arrayRows, [{ value: 'a' }, { value: 'c' }]);

            await assert.rejects(
                async () => {
                    await sql.begin(async (tx) => {
                        await tx`
                        insert into runtime_state_store (store_namespace,
                                                         store_key,
                                                         store_value,
                                                         expire_at_ts)
                        values (${'tx'}, ${'rollback'}, ${'value'}, ${new Date(FUTURE_MS)})
                    `;
                        throw new Error('rollback smoke');
                    });
                },
                /rollback smoke/
            );

            const rowsAfterRollback = await sql<StringCountRow[]>`
            select count(*)
            from runtime_state_store
            where store_namespace = ${'tx'}
        `;

            assert.equal(Number(rowsAfterRollback[0].count), 0);
        });
    }
);

Deno.test('PSqlRuntimeStateRepository runs against PGlite SQL adapter', async () => {
    await withPGliteSql(async (sql) => {
        const repository = new PSqlRuntimeStateRepository(sql);

        await repository.upsert('runtime-smoke', 'b', '{"value":2}', FUTURE_MS);
        await repository.upsert('runtime-smoke', 'a', '{"value":1}', FUTURE_MS);
        await repository.upsert('runtime-smoke', 'a', '{"value":3}', FUTURE_MS);

        const entry = await repository.findEntry('runtime-smoke', 'a');
        assert.equal(entry?.value, '{"value":3}');
        assert.equal(entry?.revision, 1);
        assert.match(
            entry?.updatedTimestamp ?? '',
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
        );

        const allEntries = await repository.findAllEntries('runtime-smoke');
        assert.deepEqual(allEntries.map((row) => row.key), ['a', 'b']);

        const prefixedEntries = await repository.findEntriesByPrefix('runtime-smoke', 'a');
        assert.deepEqual(prefixedEntries.map((row) => row.key), ['a']);
        const keyedEntries = await repository.findEntriesByKeys(
            'runtime-smoke',
            ['b', 'missing', 'a', 'b']
        );
        assert.deepEqual(keyedEntries.map((row) => row.key), ['a', 'b']);

        await assert.rejects(
            async () => {
                await repository.begin(async (txRepository) => {
                    await txRepository.upsert('runtime-smoke', 'rollback', 'value', FUTURE_MS);
                    throw new Error('rollback runtime state');
                });
            },
            /rollback runtime state/
        );
        assert.equal(await repository.findEntry('runtime-smoke', 'rollback'), undefined);

        await repository.upsert('runtime-smoke', 'expired', 'expired', PAST_MS);
        assert.equal(await repository.deleteExpired('runtime-smoke'), 1);
        assert.equal(await repository.findEntry('runtime-smoke', 'expired'), undefined);
    });
});

Deno.test(
    'PGlite client write commits state, event, and ResourceInbox rows in one caller transaction',
    async () => {
        await withPGliteSql(async (sql) => {
            const runtime = new PSqlRuntimeStateRepository(sql);
            const authSessions = new AuthSessionRepository(runtime);
            const events = new PSqlClientStateEventRepository(sql);
            const repository = new ClientStateRepository(runtime, events);
            const service = createClientStateService({
                runtimeRepository: runtime,
                clientStateEventStore: events,
                serviceId: 'pglite-client-service'
            });
            const scope = { applicationId: 'pglite-app', workspaceId: 'pglite-workspace' };

            const compute = async (principalId: string, commandId: string) => {
                const authority = {
                    clientId: principalId,
                    accessToken: `${principalId}-token`,
                    username: principalId,
                    sessionId: `${principalId}-session`,
                    issuedAtEpochMs: 1_000,
                    expiresAtEpochMs: FUTURE_MS
                } as const;
                await authSessions.putSession(authority);
                const input = toUpsertClientPrincipalMutationInput({
                    scope,
                    principalId,
                    request: {
                        username: principalId,
                        displayName: principalId,
                        actorPrincipalId: principalId,
                        actorSessionId: authority.sessionId,
                        requestId: commandId
                    },
                    defaultCommandId: commandId
                });
                const command = await toClientMutationCommand(
                    input,
                    {
                        nowEpochMs: 2_000,
                        serviceId: 'pglite-client-service',
                        eventId: `${commandId}-event`,
                        attemptCount: 1,
                        expireAtEpochMs: FUTURE_MS
                    },
                    toClientMutationIssuedSessionAuthority(authority, scope, 'upsertPrincipal')
                );
                const read = await service.read(command);
                const computed = service.compute(command, read);
                service.validate(command, read, computed);
                assert.equal(computed.outcome, 'write');
                if (computed.outcome !== 'write') {
                    throw new Error('Expected applied client write');
                }
                assert.equal(requiresClientWrite(computed), true);
                return computed;
            };

            const committed = await compute('alice', 'pglite-client-commit');
            await sql.begin(async (transaction) => {
                await service.write(transaction, committed);
            });

            assert.equal(
                (await repository.readSnapshot({ ...scope, principalId: 'alice' }))
                    ?.principal.snapshotVersion,
                1
            );
            assert.equal((await events.listClientEvents({ ...scope, principalId: 'alice' })).length, 1);
            const outbox = createPSqlResourceInboxRepository(sql);
            for (const entry of committed.outboxEntries) {
                assert.equal((await outbox.entries.findByKey(entry.key))?.typeId, 'WS_OUTBOX');
            }

            const rolledBack = await compute('bob', 'pglite-client-rollback');
            await assert.rejects(
                async () => {
                    await sql.begin(async (transaction) => {
                        await service.write(transaction, rolledBack);
                        throw new Error('rollback exact client write');
                    });
                },
                /rollback exact client write/
            );
            assert.equal(
                await repository.readSnapshot({ ...scope, principalId: 'bob' }),
                undefined
            );
            assert.equal((await events.listClientEvents({ ...scope, principalId: 'bob' })).length, 0);
            for (const entry of rolledBack.outboxEntries) {
                assert.equal(await outbox.entries.findByKey(entry.key), null);
            }
        });
    }
);
