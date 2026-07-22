import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { configureRttRepository } from '@shared/repository/rtt-repository.ts';
import {
  AppTopics,
  ConnectionContext,
  InMemoryQueueBox,
  JsonWebSocketServer,
  newALBroadcastMessage,
  newALEventRoute,
  WsQueueBoxServerService,
} from '@shared/mod.ts';
import { configureSharedGraphRepositories } from '@shared-graph/repository/configure-shared-graph-repositories.ts';
import { Temporal } from '@js-temporal/polyfill';
import { PSqlAppDataRepository } from '@shared-server/postgres/app-data/PSqlAppDataRepository.ts';
import { PSqlCrdtLogRepository } from '@shared-server/postgres/crdt/PSqlCrdtLogRepository.ts';
import {
  ResourceInboxInvariantCorruptionError,
  ResourceInboxRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import {
  ResourceInboxResultsRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import {
  isRuntimeStateGuardedBatchRepositoryLike,
  type RuntimeStateGuardedBatch,
  type RuntimeStateGuardedBatchResult,
} from '@shared-server/runtime-state/RuntimeStateGuardedBatch.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import {
  AuthSessionRepository,
  type IssuedAuthSession,
} from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/repositories/RtcRttRepository.ts';
import { toRtcTopologyPublicationId } from '@shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts';
import {
  createGroupStateService,
  type GroupMutationDescriptor,
  type GroupMutationPreparation,
  type GroupStateService,
  mutationDescriptor,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import {
  createClientStateService,
  requiresClientWrite,
  toClientMutationCommand,
  toClientMutationIssuedSessionAuthority,
  toUpsertInstanceCommandInput,
  toUpsertPrincipalCommandInput,
} from '@shared-server/rallar-system/services/client-state-service.ts';
import { GroupTopologyManagementService } from '@shared-server/rallar-system/services/group-topology-management-service.ts';
import { materializeRtcOverlayTopologyBroadcastMessage } from '@shared-server/rallar-system/services/group-topology-management-service.ts';
import type { GroupTopologyConfigMutationCommand } from '@shared-server/rallar-system/services/group-topology-config-mutations.ts';
import { hashStateMutationCommand } from '@shared-server/rallar-system/repositories/StateMutationOutboxRepository.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import {
  groupStateGroupStorageKey,
  groupStateMemberStorageKey,
  groupStatePresenceSessionStorageKey,
} from '@shared-server/rallar-system/group-state-storage-keys.ts';
import { CoalescedAppOutboxWorkService } from '@shared-server/rallar-system/services/CoalescedAppOutboxWorkService.ts';
import { AppOutboxType } from '@shared-server/rallar-system/services/AppOutboxService.ts';
import {
  ClientStateEventCollisionError,
  PSqlClientStateEventRepository,
  PSqlGroupStateEventRepository,
} from '@shared-server/postgres/rallar-system/PSqlStateEventRepository.ts';
import { groupEventWorkspaceKey } from '@shared-server/postgres/rallar-system/group-event-workspace-key.ts';
import { createGroupStateEventRepository } from '@shared-server/postgres/rallar-system/createStateRepositories.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type {
  AuditStamp,
  Group,
  GroupEvent,
  GroupRef,
  GroupSnapshot,
} from '@shared/api/group-types.ts';
import {
  RALLAR_CRDT_OPERATION_VERSION,
  RALLAR_CRDT_PROTOCOL_VERSION,
  type RallarCrdtDocumentRef,
  type RallarCrdtOperationBatch,
  type RallarCrdtSnapshotEnvelope,
  type RallarCrdtUpdateEnvelope,
  toRallarCrdtDocumentKey,
} from '@shared/crdt/mod.ts';
import {
  EntityStatus,
  type ResourceEntry,
  toResourceEntryWithUpdatedResource,
} from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import {
  AppGroupInboxService,
  type GroupCreateAppInboxPayload,
  type TopologyAppInboxCommand,
  type TopologyAppInboxRequestPayload,
  toTopologyAppInboxCommand,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import {
  AppInboxService,
  AppInboxType,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import { initRallarSystemWsTopics } from '@shared-server/rallar-system/ws-system-topics.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/services/GroupPresenceSummaryWork.ts';
import {
  APP_OUTBOX_GROUP_PRESENCE_SUMMARY_TOPIC,
} from '@shared-server/rallar-system/services/group-state-mutations.ts';
import {
  APP_OUTBOX_RTC_TOPOLOGY_TOPIC,
  createRtcTopologyOutboxPublisher,
  createRtcTopologyWorkHandler,
  writeRtcTopologyOutbox,
} from '@shared-server/rallar-system/services/RtcTopologyOutboxWork.ts';
import { computeRtcTopologyPublicationOutbox } from '@shared-server/rallar-system/services/rtc-topology-ws-outbox-entry.ts';
import { toResilienceDto } from '../../src/middleware-resilience.ts';
import { createApiV1SqlClient } from '../../src/db/db.ts';
import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';
import * as graphTopologyRoutes from '../../src/routes/graph-topology-routes.ts';

const FUTURE_MS = Date.parse('9999-12-31T23:59:59.999Z');
const PAST_MS = Date.parse('2000-01-01T00:00:00.000Z');
const FUTURE_INSTANT = Temporal.Instant.from('9999-12-31T23:59:59.999Z');
const PAST_INSTANT = Temporal.Instant.from('2000-01-01T00:00:00.000Z');
const CREATED_TS = Temporal.PlainDateTime.from('2026-06-01T12:00:00');

Deno.test('PGlite AppInbox decodes exact legacy failure versions without weakening canonical rows', async () => {
  await withPGliteSql(async (sql) => {
    const baseFailure = {
      error: 'Client mutation rejected',
      code: 'client-mutation-rejected',
      message: 'Client mutation rejected',
      status: 422,
    } as const;
    const policyDenial = {
      error: 'Forbidden: Invite required.',
      code: 'group-invite-required',
      message: 'Invite required.',
      details: { groupId: 'legacy-room' },
    } as const;
    const canonicalFailure = {
      type: 'app-inbox-failure',
      code: 'client-mutation-rejected',
      status: 422,
      message: 'Canonical validation failed',
      issues: null,
      denial: null,
      retry: null,
    } as const;
    const legacyRetryExhaustion = {
      type: 'app-inbox-retry-exhausted',
      commandIdentity: {
        contextId: 'legacy-context',
        resourceId: 'legacy-retry',
        topicId: 'app-inbox.group-state',
        operation: 'GROUP_CREATE',
        operationSource: 'command',
      },
      selectedLane: 'retry',
      processingAttempts: 8,
      reservationAttempt: 8,
      lastError: {
        source: 'processing',
        code: 'app-inbox-transient',
        message: 'AppInbox processing encountered a retryable transient failure',
      },
      queueAgeMs: 25,
      dueAgeMs: 5,
      exhaustedAtEpochMs: 1_000,
    } as const;
    const legacyRetryRecovery = {
      type: 'app-inbox-retry-exhausted',
      commandIdentity: {
        contextId: 'legacy-context',
        resourceId: 'legacy-recovery',
        topicId: 'app-inbox.group-state',
        operation: 'GROUP_CREATE',
        operationSource: 'command',
      },
      selectedLane: 'FINALIZATION',
      processingAttempts: 20,
      reservationAttempt: 22,
      lastError: {
        source: 'finalization-recovery',
        code: 'app-inbox-finalization-recovery',
        message: 'AppInbox retry exhaustion finalization is being recovered',
      },
      queueAgeMs: 60_000,
      dueAgeMs: 300_000,
      selectedDueAtEpochMs: 700,
      finalizedAtEpochMs: 1_000,
    } as const;
    const cases = [
      {
        name: 'raw-string',
        resource: 'legacy raw failure',
        version: 'legacy-string.v0',
        code: 'app-inbox-legacy-string',
        status: 500,
        legacy: 'legacy raw failure',
      },
      {
        name: 'base-object',
        resource: baseFailure,
        version: 'legacy-object.v0',
        code: baseFailure.code,
        status: baseFailure.status,
        legacy: JSON.stringify(baseFailure),
      },
      {
        name: 'policy-denial',
        resource: policyDenial,
        version: 'legacy-policy-denial.v0',
        code: policyDenial.code,
        status: 403,
        legacy: JSON.stringify(policyDenial),
      },
      {
        name: 'canonical',
        resource: canonicalFailure,
        version: 'canonical.v1',
        code: canonicalFailure.code,
        status: canonicalFailure.status,
        legacy: JSON.stringify(canonicalFailure),
      },
      {
        name: 'retry-exhaustion',
        resource: legacyRetryExhaustion,
        version: 'legacy-retry-exhausted.v0',
        code: 'app-inbox-retry-exhausted',
        status: 503,
        legacy: JSON.stringify(legacyRetryExhaustion),
      },
      {
        name: 'retry-recovery',
        resource: legacyRetryRecovery,
        version: 'legacy-retry-exhausted.v0',
        code: 'app-inbox-retry-exhausted',
        status: 503,
        legacy: JSON.stringify(legacyRetryRecovery),
      },
      {
        name: 'malformed',
        resource: { error: 'partial impostor', code: 'forged' },
        version: 'malformed.v0',
        code: 'app-inbox-malformed-persisted-failure',
        status: 500,
      },
    ] as const;

    for (const testCase of cases) {
      const result = await readPGliteAppInboxFailure(
        sql,
        `legacy-failure-${testCase.name}`,
        testCase.resource,
      );
      assert.ok(result.typed.left, testCase.name);
      assert.equal(
        (result.typed.left as typeof result.typed.left & { version?: string }).version,
        testCase.version,
        testCase.name,
      );
      assert.equal(result.typed.left.code, testCase.code, testCase.name);
      assert.equal(result.typed.left.status, testCase.status, testCase.name);
      if ('legacy' in testCase) {
        assert.equal(result.legacy.left, testCase.legacy, testCase.name);
      }
      if (testCase.name === 'policy-denial') {
        assert.deepEqual(result.typed.left.denial, {
          code: policyDenial.code,
          message: policyDenial.message,
          details: policyDenial.details,
        });
      }
    }
  });
});

Deno.test('PGlite AppGroup commits group mutation and summary fan-out through fenced queue transactions', async () => {
  await withPGliteSql(async (sql) => {
    const runtime = new PSqlRuntimeStateRepository(sql);
    const resourceInbox = new ResourceInboxRepository(sql);
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
      expiresAtEpochMs: FUTURE_MS,
    };
    const authSessions = new AuthSessionRepository(runtime);
    await authSessions.putSession(authority);
    const groupState = createGroupStateService({
      runtimeRepository: runtime,
      createGroupStateEventStore: createGroupStateEventRepository,
      authSessionRepository: authSessions,
      serviceId: 'pglite-group-service',
      now: () => nowEpochMs,
    });
    const appGroup = new AppGroupInboxService(
      inboxReader,
      resourceInbox,
      resourceResults,
      sql,
      groupState,
      'pglite-group-service',
      undefined,
      {
        waitMaxElapsedMsecs: 5_000,
        waitRetryIntervalMsecs: 1,
        waitMaxRetryIntervalMsecs: 4,
        waitJitterRatio: 0,
        nowEpochMs: () => nowEpochMs,
      },
    );
    const summaryWork = new GroupPresenceSummaryWork({
      runtimeRepository: runtime,
      database: sql,
      serviceId: 'pglite-group-service',
      now: () => nowEpochMs,
    });
    outboxReader.onOutboxMessageDo(AppOutboxType.GROUP_PRESENCE_SUMMARY, {
      onMessage: async (message, entry) => await summaryWork.processReservedEntry(message, entry),
    });
    outboxReader.onOutboxMessageDo(
      AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
      { onMessage: () => Promise.resolve() },
    );

    const pending = appGroup.processAuthenticatedEntryUntilCompletion<
      GroupCreateAppInboxPayload,
      unknown
    >({
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
          requestId: 'pglite-app-group-create',
        },
      },
    }, authority);
    await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
    await inboxReader.dequeueInbox(
      InboxQueueReader.INBOX_DEQUEUE_TYPES,
      toResilienceDto(),
    );
    const result = await pending;
    assert.equal(result.right !== undefined, true);

    const ref = {
      applicationId: 'vertical-app',
      workspaceId: 'main',
      groupId: 'vertical-group',
    };
    assert.equal(
      (await new GroupStateRepository(runtime).findGroup(ref))?.displayName,
      'Vertical Group',
    );
    assert.equal((await new PSqlGroupStateEventRepository(sql).listGroupEvents(ref)).length, 1);
    const beforeSummary = await sql<{ ri_type_id: string; ri_status: string }[]>`
      select ri_type_id, ri_status from resource_inbox order by ri_row_id
    `;
    assert.equal(
      beforeSummary.filter((row) =>
        row.ri_type_id === 'APP_INBOX' &&
        row.ri_status === 'COMPLETED'
      ).length,
      1,
    );
    assert.equal(
      beforeSummary.filter((row) =>
        row.ri_type_id === 'APP_OUTBOX' &&
        row.ri_status === 'NEW'
      ).length,
      1,
    );
    assert.equal(beforeSummary.filter((row) => row.ri_type_id === 'WS_OUTBOX').length, 0);
    assert.equal(
      Number(
        (await sql<{ count: string | number }[]>`
      select count(*) as count from resource_inbox_results
    `)[0]?.count,
      ),
      1,
    );
    assert.equal((await runtime.findAllEntries('state-mutation:outbox')).length, 0);

    await outboxReader.dequeueOutbox(
      OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
      toResilienceDto(),
    );
    const afterSummary = await sql<{
      ri_topic_id: string;
      ri_type_id: string;
      ri_status: string;
    }[]>`
      select ri_topic_id, ri_type_id, ri_status from resource_inbox order by ri_row_id
    `;
    assert.equal(
      afterSummary.filter((row) =>
        row.ri_type_id === 'APP_OUTBOX' &&
        row.ri_topic_id === APP_OUTBOX_GROUP_PRESENCE_SUMMARY_TOPIC &&
        row.ri_status === 'COMPLETED'
      ).length,
      1,
    );
    assert.equal(
      afterSummary.filter((row) =>
        row.ri_type_id === 'WS_OUTBOX' &&
        row.ri_status === 'NEW'
      ).length,
      3,
    );
    assert.equal(
      afterSummary.filter((row) =>
        row.ri_type_id === 'APP_OUTBOX' &&
        row.ri_topic_id === APP_OUTBOX_RTC_TOPOLOGY_TOPIC &&
        row.ri_status === 'COMPLETED'
      ).length,
      1,
    );
  });
});

Deno.test('PGlite summary reservation fence rolls back CAS and every downstream row atomically', async () => {
  await withPGliteSql(async (sql) => {
    const runtime = new PSqlRuntimeStateRepository(sql);
    const resourceInbox = new ResourceInboxRepository(sql);
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
      expiresAtEpochMs: FUTURE_MS,
    };
    const authSessions = new AuthSessionRepository(runtime);
    await authSessions.putSession(authority);
    const groupState = createGroupStateService({
      runtimeRepository: runtime,
      createGroupStateEventStore: createGroupStateEventRepository,
      authSessionRepository: authSessions,
      serviceId: 'pglite-summary-fence',
      now: () => nowEpochMs,
    });
    const appGroup = new AppGroupInboxService(
      inboxReader,
      resourceInbox,
      resourceResults,
      sql,
      groupState,
      'pglite-summary-fence',
      undefined,
      {
        waitMaxElapsedMsecs: 5_000,
        waitRetryIntervalMsecs: 1,
        waitMaxRetryIntervalMsecs: 4,
        waitJitterRatio: 0,
        nowEpochMs: () => nowEpochMs,
      },
    );
    const pending = appGroup.processAuthenticatedEntryUntilCompletion<
      GroupCreateAppInboxPayload,
      unknown
    >({
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
          requestId: 'pglite-summary-fence-create',
        },
      },
    }, authority);
    await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
    await inboxReader.dequeueInbox(
      InboxQueueReader.INBOX_DEQUEUE_TYPES,
      toResilienceDto(),
    );
    assert.equal((await pending).right !== undefined, true);

    const [summaryKey] = await sql<{
      ri_topic_id: string;
      ri_resource_id: string;
      fk_ext_bank_id: string;
    }[]>`
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
      contextId: summaryKey.fk_ext_bank_id,
    };
    const reserved = await resourceInbox.findAnyByKey(key);
    assert.ok(reserved);
    const message = JSON.parse(reserved.resource) as ALMessage;
    const ref = {
      applicationId: 'fence-app',
      workspaceId: 'main',
      groupId: 'fence-group',
    };
    const repository = new GroupStateRepository(runtime);
    const summaryBefore = await repository.findPresenceSummaryEntry(ref);
    const work = new GroupPresenceSummaryWork({
      runtimeRepository: runtime,
      database: sql,
      serviceId: 'pglite-summary-fence',
      now: () => nowEpochMs,
    });

    await assert.rejects(
      () =>
        work.processReservedEntry(message, {
          ...reserved,
          dequeueAudit: { ...reserved.dequeueAudit, attempts: 2 },
        }),
      /reservation changed before commit/,
    );

    assert.deepEqual(await repository.findPresenceSummaryEntry(ref), summaryBefore);
    const stillReserved = await resourceInbox.findAnyByKey(key);
    assert.equal(stillReserved?.status, EntityStatus.RESERVED);
    assert.equal(stillReserved?.dequeueAudit.attempts, 1);
    const downstream = await sql<{ ri_topic_id: string; ri_type_id: string }[]>`
      select ri_topic_id, ri_type_id
      from resource_inbox
      where ri_type_id in ('WS_OUTBOX', 'APP_OUTBOX')
        and ri_topic_id <> ${APP_OUTBOX_GROUP_PRESENCE_SUMMARY_TOPIC}
    `;
    assert.deepEqual(downstream, []);
  });
});

function groupFixture(ref: GroupRef, displayName: string): Group {
  const audit = canonicalAuditStamp(1);
  return {
    ...ref,
    slug: null,
    displayName,
    description: null,
    kind: 'room',
    status: 'active',
    joinMode: 'open',
    maxMembers: null,
    maxSessionsPerMember: null,
    metadata: {},
    activeMemberCount: 1,
    ownerPrincipalId: 'alice',
    snapshotVersion: 1,
    metadataVersion: 1,
    rosterVersion: 1,
    presenceVersion: 0,
    created: audit,
    updated: audit,
    expiresAtEpochMs: null,
    emptySinceEpochMs: null,
    purgeAfterEpochMs: null,
    archived: null,
    deleted: null,
  };
}

Deno.test('group event workspace keys preserve ordinary values and isolate sentinels and lookalikes', () => {
  const workspaces = [undefined, '_', '%5F', 'main', 'a:b', 'a%3Ab', '＿'];
  const keys = workspaces.map(groupEventWorkspaceKey);
  assert.equal(groupEventWorkspaceKey(undefined), '_');
  assert.equal(groupEventWorkspaceKey('_'), '%5F');
  assert.equal(groupEventWorkspaceKey('main'), 'main');
  assert.equal(new Set(keys).size, workspaces.length);
});

Deno.test('PGlite SQL adapter supports tagged templates, array interpolation, and transactions', async () => {
  await withPGliteSql(async (sql) => {
    const scalarRows = await sql<{ value: number }[]>`
            select ${1}::int as value
        `;

    assert.deepEqual(scalarRows, [{ value: 1 }]);

    const arrayRows = await sql<{ value: string }[]>`
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
      /rollback smoke/,
    );

    const rowsAfterRollback = await sql<{ count: string }[]>`
            select count(*)
            from runtime_state_store
            where store_namespace = ${'tx'}
        `;

    assert.equal(Number(rowsAfterRollback[0].count), 0);
  });
});

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
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
    );

    const allEntries = await repository.findAllEntries('runtime-smoke');
    assert.deepEqual(allEntries.map((row) => row.key), ['a', 'b']);

    const prefixedEntries = await repository.findEntriesByPrefix('runtime-smoke', 'a');
    assert.deepEqual(prefixedEntries.map((row) => row.key), ['a']);
    const keyedEntries = await repository.findEntriesByKeys(
      'runtime-smoke',
      ['b', 'missing', 'a', 'b'],
    );
    assert.deepEqual(keyedEntries.map((row) => row.key), ['a', 'b']);

    await assert.rejects(
      async () => {
        await repository.begin(async (txRepository) => {
          await txRepository.lockKey('runtime-smoke', 'rollback');
          await txRepository.upsert('runtime-smoke', 'rollback', 'value', FUTURE_MS);
          throw new Error('rollback runtime state');
        });
      },
      /rollback runtime state/,
    );
    assert.equal(await repository.findEntry('runtime-smoke', 'rollback'), undefined);

    await repository.upsert('runtime-smoke', 'expired', 'expired', PAST_MS);
    assert.equal(await repository.deleteExpired('runtime-smoke'), 1);
    assert.equal(await repository.findEntry('runtime-smoke', 'expired'), undefined);
  });
});

Deno.test('PGlite client write commits state, event, and ResourceInbox rows in one caller transaction', async () => {
  await withPGliteSql(async (sql) => {
    const runtime = new PSqlRuntimeStateRepository(sql);
    const authSessions = new AuthSessionRepository(runtime);
    const events = new PSqlClientStateEventRepository(sql);
    const repository = new ClientStateRepository(runtime, { events });
    const service = createClientStateService({
      runtimeRepository: runtime,
      createClientStateEventStore: () => events,
      serviceId: 'pglite-client-service',
    });
    const scope = { applicationId: 'pglite-app', workspaceId: 'pglite-workspace' };

    const compute = async (principalId: string, commandId: string) => {
      const authority = {
        clientId: principalId,
        accessToken: `${principalId}-token`,
        username: principalId,
        sessionId: `${principalId}-session`,
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs: FUTURE_MS,
      } as const;
      await authSessions.putSession(authority);
      const input = toUpsertPrincipalCommandInput(
        scope,
        principalId,
        {
          username: principalId,
          displayName: principalId,
          actorPrincipalId: principalId,
          actorSessionId: authority.sessionId,
          requestId: commandId,
        },
        commandId,
      );
      const command = await toClientMutationCommand(
        input,
        {
          nowEpochMs: 2_000,
          serviceId: 'pglite-client-service',
          eventId: `${commandId}-event`,
          attemptCount: 1,
          expireAtEpochMs: FUTURE_MS,
        },
        toClientMutationIssuedSessionAuthority(authority, scope, 'upsertPrincipal'),
      );
      const read = await service.read(command);
      const computed = service.compute(command, read);
      service.validate(command, read, computed);
      assert.equal(computed.outcome, 'write');
      if (computed.outcome !== 'write') throw new Error('Expected applied client write');
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
      1,
    );
    assert.equal((await events.listClientEvents({ ...scope, principalId: 'alice' })).length, 1);
    const outbox = new ResourceInboxRepository(sql);
    for (const entry of committed.outboxEntries) {
      assert.equal((await outbox.findByKey(entry.key))?.typeId, 'WS_OUTBOX');
    }

    const rolledBack = await compute('bob', 'pglite-client-rollback');
    await assert.rejects(
      async () => {
        await sql.begin(async (transaction) => {
          await service.write(transaction, rolledBack);
          throw new Error('rollback exact client write');
        });
      },
      /rollback exact client write/,
    );
    assert.equal(
      await repository.readSnapshot({ ...scope, principalId: 'bob' }),
      undefined,
    );
    assert.equal((await events.listClientEvents({ ...scope, principalId: 'bob' })).length, 0);
    for (const entry of rolledBack.outboxEntries) {
      assert.equal(await outbox.findByKey(entry.key), null);
    }
  });
});

async function createPGliteClientEventCollisionFixture(
  sql: PGliteSql,
  prefix: string,
) {
  const runtime = new PSqlRuntimeStateRepository(sql);
  const authSessions = new AuthSessionRepository(runtime);
  const events = new PSqlClientStateEventRepository(sql);
  const repository = new ClientStateRepository(runtime, { events });
  const service = createClientStateService({
    runtimeRepository: runtime,
    createClientStateEventStore: () => events,
    serviceId: 'pglite-client-service',
  });
  const scope = {
    applicationId: `${prefix}-app`,
    workspaceId: `${prefix}-workspace`,
  };
  const principalId = `${prefix}-client`;
  const authority = {
    clientId: principalId,
    accessToken: `${prefix}-client-token`,
    username: principalId,
    sessionId: `${prefix}-client-session`,
    issuedAtEpochMs: 1_000,
    expiresAtEpochMs: FUTURE_MS,
  } as const;
  await authSessions.putSession(authority);

  const compute = async (
    input: ReturnType<typeof toUpsertPrincipalCommandInput>,
    operation: 'upsertPrincipal' | 'upsertInstance',
    eventId: string,
    nowEpochMs: number,
  ) => {
    const command = await toClientMutationCommand(
      input,
      {
        nowEpochMs,
        serviceId: 'pglite-client-service',
        eventId,
        attemptCount: 1,
        expireAtEpochMs: FUTURE_MS,
      },
      toClientMutationIssuedSessionAuthority(authority, scope, operation),
    );
    const read = await service.read(command);
    const computed = service.compute(command, read);
    service.validate(command, read, computed);
    assert.equal(computed.outcome, 'write');
    if (computed.outcome !== 'write') throw new Error('Expected applied client write');
    return computed;
  };

  const seedRequestId = `${prefix}-seed`;
  const seed = await compute(
    toUpsertPrincipalCommandInput(
      scope,
      principalId,
      {
        username: principalId,
        displayName: `Before ${prefix}`,
        actorPrincipalId: principalId,
        actorSessionId: authority.sessionId,
        requestId: seedRequestId,
      },
      seedRequestId,
    ),
    'upsertPrincipal',
    `${seedRequestId}-event`,
    2_000,
  );
  await sql.begin(async (transaction) => {
    await service.write(transaction, seed);
  });
  const before = await repository.readSnapshot({ ...scope, principalId });
  assert.ok(before);

  const requestId = `${prefix}-instance`;
  const clientInstanceId = `${prefix}-browser`;
  const computed = await compute(
    toUpsertInstanceCommandInput(
      scope,
      principalId,
      clientInstanceId,
      {
        platform: 'web',
        deviceLabel: prefix,
        actorPrincipalId: principalId,
        actorSessionId: authority.sessionId,
        requestId,
      },
      requestId,
    ),
    'upsertInstance',
    `${requestId}-event`,
    3_000,
  );
  return {
    before,
    clientInstanceId,
    computed,
    events,
    principalId,
    repository,
    requestId,
    scope,
    service,
  };
}

Deno.test('PGlite client write rejects a divergent event collision and rolls back the aggregate', async () => {
  await withPGliteSql(async (sql) => {
    const fixture = await createPGliteClientEventCollisionFixture(sql, 'collision');
    const divergentEvent: ClientEvent = {
      ...fixture.computed.event,
      reason: 'pre-existing divergent event body',
    };
    await fixture.events.appendClientEvent(divergentEvent);
    const eventsBeforeWrite = await fixture.events.listClientEvents({
      ...fixture.scope,
      principalId: fixture.principalId,
    });

    let collisionError: unknown = null;
    try {
      await sql.begin(async (transaction) => {
        await fixture.service.write(transaction, fixture.computed);
      });
    } catch (error) {
      collisionError = error;
    }

    const outbox = new ResourceInboxRepository(sql);
    assert.deepEqual(
      {
        isTypedCollision: collisionError instanceof ClientStateEventCollisionError,
        errorName: collisionError instanceof Error ? collisionError.name : null,
        errorCode: collisionError instanceof Error && 'code' in collisionError
          ? collisionError.code
          : null,
        errorStatus: collisionError instanceof Error && 'status' in collisionError
          ? collisionError.status
          : null,
        snapshot: await fixture.repository.readSnapshot({
          ...fixture.scope,
          principalId: fixture.principalId,
        }),
        instance: await fixture.repository.findInstance({
          ...fixture.scope,
          principalId: fixture.principalId,
          clientInstanceId: fixture.clientInstanceId,
        }) ?? null,
        receipt: await fixture.repository.findIdempotentClientMutationReceipt(
          { ...fixture.scope, principalId: fixture.principalId },
          fixture.requestId,
        ) ?? null,
        outbox: await Promise.all(
          fixture.computed.outboxEntries.map((entry) => outbox.findByKey(entry.key)),
        ),
        events: await fixture.events.listClientEvents({
          ...fixture.scope,
          principalId: fixture.principalId,
        }),
      },
      {
        isTypedCollision: true,
        errorName: 'ClientStateEventCollisionError',
        errorCode: 'client-state-event-collision',
        errorStatus: 409,
        snapshot: fixture.before,
        instance: null,
        receipt: null,
        outbox: fixture.computed.outboxEntries.map(() => null),
        events: eventsBeforeWrite,
      },
    );
  });
});

Deno.test('PGlite client write accepts an identical pre-existing event and commits once', async () => {
  await withPGliteSql(async (sql) => {
    const fixture = await createPGliteClientEventCollisionFixture(sql, 'replay');
    await fixture.events.appendClientEvent(fixture.computed.event);
    await sql.begin(async (transaction) => {
      await fixture.service.write(transaction, fixture.computed);
    });

    const snapshot = await fixture.repository.readSnapshot({
      ...fixture.scope,
      principalId: fixture.principalId,
    });
    assert.equal(snapshot?.instances.length, 1);
    assert.equal(snapshot?.instances[0]?.clientInstanceId, fixture.clientInstanceId);
    assert.ok(fixture.computed.idempotency);
    assert.deepEqual(
      await fixture.repository.findIdempotentClientMutationReceipt(
        { ...fixture.scope, principalId: fixture.principalId },
        fixture.requestId,
      ),
      fixture.computed.idempotency,
    );
    const storedEvents = await fixture.events.listClientEvents({
      ...fixture.scope,
      principalId: fixture.principalId,
    });
    assert.equal(
      storedEvents.filter((event) => event.eventId === fixture.computed.event.eventId).length,
      1,
    );
    assert.deepEqual(
      storedEvents.find((event) => event.eventId === fixture.computed.event.eventId),
      fixture.computed.event,
    );
    const outbox = new ResourceInboxRepository(sql);
    for (const entry of fixture.computed.outboxEntries) {
      assert.equal((await outbox.findByKey(entry.key))?.typeId, 'WS_OUTBOX');
    }
  });
});

Deno.test(
  'guarded runtime-state batch applies every guard and effect operation with exact results',
  async () => {
    await withPGliteSql(async (sql) => {
      const repository = new PSqlRuntimeStateRepository(sql);
      await repository.insertIfAbsent(
        'guarded-effect',
        'update',
        'before-update',
        FUTURE_MS,
      );
      await repository.insertIfAbsent(
        'guarded-effect',
        'delete',
        'before-delete',
        FUTURE_MS,
      );
      await repository.insertIfAbsent(
        'guarded-effect',
        'put',
        'before-put',
        FUTURE_MS,
      );

      const insertBatch: RuntimeStateGuardedBatch = {
        guard: {
          operation: 'insert',
          namespace: 'guarded-root',
          key: 'root',
          value: 'inserted-root',
          expireAtTimestamp: FUTURE_MS,
        },
        effects: [{
          effectId: 'insert',
          operation: 'insert',
          namespace: 'guarded-effect',
          key: 'insert',
          value: 'inserted-effect',
          expireAtTimestamp: FUTURE_MS,
        }, {
          effectId: 'update',
          operation: 'update',
          namespace: 'guarded-effect',
          key: 'update',
          expectedRevision: 0,
          value: 'updated-effect',
          expireAtTimestamp: FUTURE_MS,
        }, {
          effectId: 'delete',
          operation: 'delete',
          namespace: 'guarded-effect',
          key: 'delete',
          expectedRevision: 0,
        }, {
          effectId: 'put',
          operation: 'put',
          namespace: 'guarded-effect',
          key: 'put',
          value: 'put-effect',
          expireAtTimestamp: FUTURE_MS,
        }],
      };

      const insertResult = await repository.begin(async (transactionRepository) => {
        assert.equal(
          isRuntimeStateGuardedBatchRepositoryLike(transactionRepository),
          true,
        );
        if (!isRuntimeStateGuardedBatchRepositoryLike(transactionRepository)) {
          throw new Error('Expected guarded runtime-state batch capability.');
        }
        return await transactionRepository.executeGuardedBatch(insertBatch);
      });

      assert.deepEqual(insertResult, {
        guard: {
          status: 'applied',
          operation: 'insert',
          namespace: 'guarded-root',
          key: 'root',
          resultingRevision: 0,
        },
        effects: [{
          status: 'applied',
          effectId: 'insert',
          operation: 'insert',
          namespace: 'guarded-effect',
          key: 'insert',
          resultingRevision: 0,
        }, {
          status: 'applied',
          effectId: 'update',
          operation: 'update',
          namespace: 'guarded-effect',
          key: 'update',
          resultingRevision: 1,
        }, {
          status: 'applied',
          effectId: 'delete',
          operation: 'delete',
          namespace: 'guarded-effect',
          key: 'delete',
          matchedRevision: 0,
        }, {
          status: 'applied',
          effectId: 'put',
          operation: 'put',
          namespace: 'guarded-effect',
          key: 'put',
          resultingRevision: 1,
        }],
      });
      assert.equal(
        (await repository.findEntry('guarded-effect', 'insert'))?.value,
        'inserted-effect',
      );
      const updatedEffect = await repository.findEntry('guarded-effect', 'update');
      assert.equal(updatedEffect?.value, 'updated-effect');
      assert.equal(updatedEffect?.revision, 1);
      assert.equal(await repository.findEntry('guarded-effect', 'delete'), undefined);
      const putEffect = await repository.findEntry('guarded-effect', 'put');
      assert.equal(putEffect?.value, 'put-effect');
      assert.equal(putEffect?.revision, 1);

      const updateBatch: RuntimeStateGuardedBatch = {
        guard: {
          operation: 'update',
          namespace: 'guarded-root',
          key: 'root',
          expectedRevision: 0,
          value: 'updated-root',
          expireAtTimestamp: FUTURE_MS,
        },
        effects: [{
          effectId: 'after-update',
          operation: 'insert',
          namespace: 'guarded-effect',
          key: 'after-update',
          value: 'after-update',
          expireAtTimestamp: FUTURE_MS,
        }],
      };
      assert.deepEqual(
        await repository.begin(async (transactionRepository) => {
          if (!isRuntimeStateGuardedBatchRepositoryLike(transactionRepository)) {
            throw new Error('Expected guarded runtime-state batch capability.');
          }
          return await transactionRepository.executeGuardedBatch(updateBatch);
        }),
        {
          guard: {
            status: 'applied',
            operation: 'update',
            namespace: 'guarded-root',
            key: 'root',
            resultingRevision: 1,
          },
          effects: [{
            status: 'applied',
            effectId: 'after-update',
            operation: 'insert',
            namespace: 'guarded-effect',
            key: 'after-update',
            resultingRevision: 0,
          }],
        },
      );

      const deleteBatch: RuntimeStateGuardedBatch = {
        guard: {
          operation: 'delete',
          namespace: 'guarded-root',
          key: 'root',
          expectedRevision: 1,
        },
        effects: [{
          effectId: 'after-delete',
          operation: 'insert',
          namespace: 'guarded-effect',
          key: 'after-delete',
          value: 'after-delete',
          expireAtTimestamp: FUTURE_MS,
        }],
      };
      assert.deepEqual(
        await repository.begin(async (transactionRepository) => {
          if (!isRuntimeStateGuardedBatchRepositoryLike(transactionRepository)) {
            throw new Error('Expected guarded runtime-state batch capability.');
          }
          return await transactionRepository.executeGuardedBatch(deleteBatch);
        }),
        {
          guard: {
            status: 'applied',
            operation: 'delete',
            namespace: 'guarded-root',
            key: 'root',
            matchedRevision: 1,
          },
          effects: [{
            status: 'applied',
            effectId: 'after-delete',
            operation: 'insert',
            namespace: 'guarded-effect',
            key: 'after-delete',
            resultingRevision: 0,
          }],
        },
      );
      assert.equal(await repository.findEntry('guarded-root', 'root'), undefined);
    });
  },
);

Deno.test(
  'guarded runtime-state batch guard conflict skips every effect without writes',
  async () => {
    await withPGliteSql(async (sql) => {
      const repository = new PSqlRuntimeStateRepository(sql);
      await repository.insertIfAbsent('guarded-miss', 'root', 'winner', FUTURE_MS);
      await repository.insertIfAbsent('guarded-miss', 'put-target', 'before', FUTURE_MS);
      const batch: RuntimeStateGuardedBatch = {
        guard: {
          operation: 'insert',
          namespace: 'guarded-miss',
          key: 'root',
          value: 'loser',
          expireAtTimestamp: FUTURE_MS,
        },
        effects: [{
          effectId: 'insert',
          operation: 'insert',
          namespace: 'guarded-miss',
          key: 'insert-target',
          value: 'must-not-exist',
          expireAtTimestamp: FUTURE_MS,
        }, {
          effectId: 'put',
          operation: 'put',
          namespace: 'guarded-miss',
          key: 'put-target',
          value: 'must-not-change',
          expireAtTimestamp: FUTURE_MS,
        }],
      };

      const result = await repository.begin(async (transactionRepository) => {
        if (!isRuntimeStateGuardedBatchRepositoryLike(transactionRepository)) {
          throw new Error('Expected guarded runtime-state batch capability.');
        }
        return await transactionRepository.executeGuardedBatch(batch);
      });

      assert.deepEqual(result, {
        guard: {
          status: 'conflict',
          operation: 'insert',
          namespace: 'guarded-miss',
          key: 'root',
          reason: 'condition-not-met',
        },
        effects: [{
          status: 'skipped',
          effectId: 'insert',
          operation: 'insert',
          namespace: 'guarded-miss',
          key: 'insert-target',
          reason: 'guard-conflict',
        }, {
          status: 'skipped',
          effectId: 'put',
          operation: 'put',
          namespace: 'guarded-miss',
          key: 'put-target',
          reason: 'guard-conflict',
        }],
      });
      assert.equal(await repository.findEntry('guarded-miss', 'insert-target'), undefined);
      const unchangedPut = await repository.findEntry('guarded-miss', 'put-target');
      assert.equal(unchangedPut?.value, 'before');
      assert.equal(unchangedPut?.revision, 0);
    });
  },
);

Deno.test(
  'guarded runtime-state batch preserves sequential physical expiry exactly',
  async () => {
    await withPGliteSql(async (sql) => {
      const repository = new PSqlRuntimeStateRepository(sql);
      const fractionalEpochMs = 1_234.75;
      await repository.insertIfAbsent(
        'guarded-expiry',
        'sequential-future',
        'future',
        FUTURE_MS,
      );
      await repository.insertIfAbsent(
        'guarded-expiry',
        'sequential-fractional',
        'fractional',
        fractionalEpochMs,
      );

      await repository.begin(async (transactionRepository) => {
        if (!isRuntimeStateGuardedBatchRepositoryLike(transactionRepository)) {
          throw new Error('Expected guarded runtime-state batch capability.');
        }
        await transactionRepository.executeGuardedBatch({
          guard: {
            operation: 'insert',
            namespace: 'guarded-expiry',
            key: 'guarded-future',
            value: 'future',
            expireAtTimestamp: FUTURE_MS,
          },
          effects: [{
            effectId: 'fractional',
            operation: 'insert',
            namespace: 'guarded-expiry',
            key: 'guarded-fractional',
            value: 'fractional',
            expireAtTimestamp: fractionalEpochMs,
          }],
        });
      });

      const rows = await sql<Array<{ store_key: string; expire_at_ts: string }>>`
        select store_key, expire_at_ts::text as expire_at_ts
        from runtime_state_store
        where store_namespace = ${'guarded-expiry'}
        order by store_key
      `;
      const expiryByKey = new Map(
        rows.map((row) => [row.store_key, row.expire_at_ts]),
      );
      assert.equal(
        expiryByKey.get('guarded-future'),
        expiryByKey.get('sequential-future'),
      );
      assert.equal(
        expiryByKey.get('guarded-fractional'),
        expiryByKey.get('sequential-fractional'),
      );
    });
  },
);

Deno.test(
  'guarded runtime-state batch rolls back applied siblings when a conditional effect conflicts',
  async () => {
    await withPGliteSql(async (sql) => {
      const repository = new PSqlRuntimeStateRepository(sql);
      await repository.insertIfAbsent('guarded-rollback', 'root', 'before', FUTURE_MS);
      let observedResult: RuntimeStateGuardedBatchResult | undefined;

      await assert.rejects(
        async () => {
          await repository.begin(async (transactionRepository) => {
            if (!isRuntimeStateGuardedBatchRepositoryLike(transactionRepository)) {
              throw new Error('Expected guarded runtime-state batch capability.');
            }
            observedResult = await transactionRepository.executeGuardedBatch({
              guard: {
                operation: 'update',
                namespace: 'guarded-rollback',
                key: 'root',
                expectedRevision: 0,
                value: 'after',
                expireAtTimestamp: FUTURE_MS,
              },
              effects: [{
                effectId: 'sibling',
                operation: 'insert',
                namespace: 'guarded-rollback',
                key: 'sibling',
                value: 'inserted',
                expireAtTimestamp: FUTURE_MS,
              }, {
                effectId: 'conflict',
                operation: 'update',
                namespace: 'guarded-rollback',
                key: 'missing',
                expectedRevision: 0,
                value: 'never',
                expireAtTimestamp: FUTURE_MS,
              }],
            });
            assert.deepEqual(observedResult.effects.map((effect) => effect.status), [
              'applied',
              'conflict',
            ]);
            throw new Error('roll back guarded batch conflict');
          });
        },
        /roll back guarded batch conflict/u,
      );

      assert.deepEqual(observedResult, {
        guard: {
          status: 'applied',
          operation: 'update',
          namespace: 'guarded-rollback',
          key: 'root',
          resultingRevision: 1,
        },
        effects: [{
          status: 'applied',
          effectId: 'sibling',
          operation: 'insert',
          namespace: 'guarded-rollback',
          key: 'sibling',
          resultingRevision: 0,
        }, {
          status: 'conflict',
          effectId: 'conflict',
          operation: 'update',
          namespace: 'guarded-rollback',
          key: 'missing',
          reason: 'condition-not-met',
        }],
      });
      const rolledBackGuard = await repository.findEntry('guarded-rollback', 'root');
      assert.equal(rolledBackGuard?.value, 'before');
      assert.equal(rolledBackGuard?.revision, 0);
      assert.equal(await repository.findEntry('guarded-rollback', 'sibling'), undefined);
    });
  },
);

Deno.test('PSqlRuntimeStateRepository generic expiry preserves protected namespaces', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlRuntimeStateRepository(sql);
    const protectedNamespaces = [
      'rtc-rtt:receipts',
      'rtc-rtt:recompute-outbox',
    ];
    await repository.upsert(protectedNamespaces[0], 'receipt', '{}', PAST_MS);
    await repository.upsert(protectedNamespaces[1], 'intent', '{}', PAST_MS);
    await repository.upsert('ordinary-expired', 'row', '{}', PAST_MS);

    const deleteAllExpired = repository.deleteAllExpired as unknown as (
      excludedNamespaces: readonly string[],
    ) => Promise<number>;
    assert.equal(await deleteAllExpired.call(repository, protectedNamespaces), 1);
    assert.notEqual(
      await repository.findEntry(protectedNamespaces[0], 'receipt'),
      undefined,
    );
    assert.notEqual(
      await repository.findEntry(protectedNamespaces[1], 'intent'),
      undefined,
    );
    assert.equal(await repository.findEntry('ordinary-expired', 'row'), undefined);
  });
});

Deno.test('PGlite AppGroup retries cross-target topology CAS conflicts through ResourceInbox and commits receipts and outboxes', async () => {
  await withPGliteSql(async (sql) => {
    const nowEpochMs = Date.parse('2026-07-23T00:00:00.000Z');
    const runtime = new PSqlRuntimeStateRepository(sql);
    const resourceInbox = new ResourceInboxRepository(sql);
    let retryReleaseCount = 0;
    class RetryObservedQueueBox extends PSqlQueueBox {
      override async releaseEntries(
        ...args: Parameters<PSqlQueueBox['releaseEntries']>
      ): ReturnType<PSqlQueueBox['releaseEntries']> {
        const released = await super.releaseEntries(...args);
        if (args[1].status === EntityStatus.RETRY) retryReleaseCount += 1;
        return released;
      }
    }
    const inboxReader = new InboxQueueReader(new RetryObservedQueueBox(resourceInbox));
    const authority: IssuedAuthSession = {
      clientId: 'owner',
      sessionId: 'cross-target-owner-session',
      accessToken: 'cross-target-owner-token',
      username: 'owner',
      issuedAtEpochMs: nowEpochMs - 1_000,
      expiresAtEpochMs: FUTURE_MS,
    };
    const authSessions = new AuthSessionRepository(runtime);
    await authSessions.putSession(authority);
    const groupRef = {
      applicationId: 'pglite-topology',
      workspaceId: 'concurrency',
      groupId: 'room',
    };
    const snapshot = topologyGroupSnapshot(groupRef);
    const groupStateRepository = new GroupStateRepository(runtime);
    assert.equal((await groupStateRepository.insertGroup(snapshot.group)).status, 'applied');
    for (const member of snapshot.members) {
      await groupStateRepository.putMember(member);
    }
    const configRepository = new GroupTopologyConfigRepository(runtime);
    const baselineService = new GroupTopologyManagementService({
      findGroupSnapshotByRef: (ref) => groupStateRepository.readSnapshot(ref),
      groupStateRepository,
      configRepository,
      topologyService: new RallarRtcTopologyService(),
      now: () => nowEpochMs,
    });
    const staleOverrideRead = await baselineService.readTopologyConfigMutation(
      topologyOverrideCommand(groupRef, 'pglite-topology-b', 'mesh'),
    );
    let staleReadCount = 0;
    let delegatedReadCount = 0;
    class StaleOnceTopologyService extends GroupTopologyManagementService {
      override async readTopologyConfigMutation(
        command: GroupTopologyConfigMutationCommand,
      ) {
        if (command.commandId === 'pglite-topology-b' && staleReadCount === 0) {
          staleReadCount += 1;
          return staleOverrideRead;
        }
        delegatedReadCount += 1;
        return await super.readTopologyConfigMutation(command);
      }
    }
    const topology = new StaleOnceTopologyService({
      findGroupSnapshotByRef: (ref) => groupStateRepository.readSnapshot(ref),
      groupStateRepository,
      configRepository,
      topologyService: new RallarRtcTopologyService(),
      now: () => nowEpochMs,
    });
    const groupState = createGroupStateService({
      runtimeRepository: runtime,
      createGroupStateEventStore: createGroupStateEventRepository,
      authSessionRepository: authSessions,
      serviceId: 'pglite-topology-cross-target',
      now: () => nowEpochMs,
    });
    const appGroup = new AppGroupInboxService(
      inboxReader,
      resourceInbox,
      new ResourceInboxResultsRepository(sql),
      sql,
      groupState,
      'pglite-topology-cross-target',
      undefined,
      {
        waitMaxElapsedMsecs: 5_000,
        waitRetryIntervalMsecs: 1,
        waitMaxRetryIntervalMsecs: 4,
        waitJitterRatio: 0,
        nowEpochMs: () => nowEpochMs,
      },
    );
    appGroup.setTopologyManagementService(topology);
    const submit = async (
      requestId: string,
      payload: TopologyAppInboxRequestPayload,
    ) => {
      const command = await toTopologyAppInboxCommand({
        actor: { principalId: authority.clientId, sessionId: authority.sessionId },
        groupRef,
        requestId,
        capturedAtEpochMs: nowEpochMs,
        payload,
      });
      const pending = submitPGliteTopologyCommand(appGroup, authority, command);
      await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
      await inboxReader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        toResilienceDto(),
      );
      return await pending;
    };

    assert.ok(
      (await submit(
        'pglite-topology-a',
        { operation: 'putConfig', config: { topologyKind: 'tree' } },
      )).right,
    );
    assert.ok(
      (await submit(
        'pglite-topology-b',
        {
          operation: 'putOverride',
          config: { topologyKind: 'mesh' },
          ttlMs: 60_000,
          expiresAtEpochMs: null,
        },
      )).right,
    );

    const firstReceipt = await configRepository.findMutationRecord(
      groupRef,
      'pglite-topology-a',
    );
    const secondReceipt = await configRepository.findMutationRecord(
      groupRef,
      'pglite-topology-b',
    );
    assert.ok(firstReceipt);
    assert.ok(secondReceipt);
    assert.equal(firstReceipt.receipt.acceptedVersion, 1);
    assert.equal(secondReceipt.receipt.acceptedVersion, 1);
    assert.equal(staleReadCount, 1);
    assert.ok(delegatedReadCount >= 2);
    assert.equal(retryReleaseCount, 1);
    const [retriedEntry] = await sql<{
      ri_attempts: string | number;
      ri_status: string;
    }[]>`
      select ri_attempts, ri_status from resource_inbox
      where ri_type_id = 'APP_INBOX'
        and ri_resource_id = 'pglite-topology-b'
    `;
    assert.equal(Number(retriedEntry?.ri_attempts), 2);
    assert.equal(retriedEntry?.ri_status, EntityStatus.COMPLETED);
    const generation = await configRepository.findGenerationEntry(groupRef, 'config');
    assert.deepEqual(generation?.value, { groupRef, target: 'config', version: 1 });
    assert.equal(generation?.entry.revision, 0);
    const overrideGeneration = await configRepository.findGenerationEntry(groupRef, 'override');
    assert.deepEqual(overrideGeneration?.value, {
      groupRef,
      target: 'override',
      version: 1,
    });
    assert.equal(overrideGeneration?.entry.revision, 0);
    const invariantGeneration = await configRepository.findInvariantGenerationEntry(groupRef);
    assert.deepEqual(invariantGeneration?.value, { groupRef, version: 2 });
    assert.equal(
      invariantGeneration?.entry.key,
      configRepository.invariantGenerationKey(groupRef),
    );
    assert.equal(invariantGeneration?.entry.revision, 1);
    const outboxRows = await sql<{ ri_resource: string }[]>`
      select ri_resource
      from resource_inbox
      where ri_type_id = 'APP_OUTBOX'
      order by ri_resource_id
    `;
    assert.deepEqual(
      outboxRows.map((row) => (JSON.parse(row.ri_resource) as ALMessage).id.msgId).sort(),
      [firstReceipt.receipt.outboxId, secondReceipt.receipt.outboxId].sort(),
    );
    assert.equal((await runtime.findAllEntries('state-mutation:outbox')).length, 0);
  });
});

Deno.test('PGlite AppGroup reuses the first durable topology command and rejects divergent stable identity', async () => {
  await withPGliteSql(async (sql) => {
    const nowEpochMs = Date.parse('2026-07-23T00:00:00.000Z');
    const runtime = new PSqlRuntimeStateRepository(sql);
    const resourceInbox = new ResourceInboxRepository(sql);
    const resourceResults = new ResourceInboxResultsRepository(sql);
    const inboxReader = new InboxQueueReader(new PSqlQueueBox(resourceInbox));
    const authSessions = new AuthSessionRepository(runtime);
    const authority: IssuedAuthSession = {
      clientId: 'owner',
      sessionId: 'owner-session',
      accessToken: 'owner-token',
      username: 'owner',
      issuedAtEpochMs: nowEpochMs - 1_000,
      expiresAtEpochMs: FUTURE_MS,
    };
    await authSessions.putSession(authority);
    const groupRef = {
      applicationId: 'pglite-app-inbox-topology',
      workspaceId: 'replay',
      groupId: 'room',
    };
    const snapshot = topologyGroupSnapshot(groupRef);
    const groupRepository = new GroupStateRepository(runtime);
    assert.equal((await groupRepository.insertGroup(snapshot.group)).status, 'applied');
    for (const member of snapshot.members) await groupRepository.putMember(member);
    const groupState = createGroupStateService({
      runtimeRepository: runtime,
      createGroupStateEventStore: createGroupStateEventRepository,
      authSessionRepository: authSessions,
      serviceId: 'pglite-app-inbox-topology',
      now: () => nowEpochMs,
    });
    const topology = new GroupTopologyManagementService({
      findGroupSnapshotByRef: (ref) => groupRepository.readSnapshot(ref),
      groupStateRepository: groupRepository,
      configRepository: new GroupTopologyConfigRepository(runtime),
      topologyService: new RallarRtcTopologyService({ now: () => nowEpochMs }),
      processRttReader: () => [],
      now: () => nowEpochMs,
    });
    const appGroup = new AppGroupInboxService(
      inboxReader,
      resourceInbox,
      resourceResults,
      sql,
      groupState,
      'pglite-app-inbox-topology',
      undefined,
      {
        waitMaxElapsedMsecs: 5_000,
        waitRetryIntervalMsecs: 1,
        waitMaxRetryIntervalMsecs: 4,
        waitJitterRatio: 0,
        nowEpochMs: () => nowEpochMs,
      },
    );
    appGroup.setTopologyManagementService(topology);

    const first = await toTopologyAppInboxCommand({
      actor: { principalId: authority.clientId, sessionId: authority.sessionId },
      groupRef,
      requestId: 'stable-topology-request',
      capturedAtEpochMs: 1_000,
      payload: { operation: 'putConfig', config: { topologyKind: 'tree' } },
    });
    const firstPending = submitPGliteTopologyCommand(
      appGroup,
      authority,
      first,
    );
    await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
    await inboxReader.dequeueInbox(
      InboxQueueReader.INBOX_DEQUEUE_TYPES,
      toResilienceDto(),
    );
    const firstResult = await firstPending;
    assert.ok(firstResult.right);
    const acceptedHttpCommands: Array<{
      command: TopologyAppInboxCommand;
      requestPayload: TopologyAppInboxRequestPayload;
      divergentPayload: TopologyAppInboxRequestPayload;
      result: unknown;
    }> = [{
      command: first,
      requestPayload: { operation: 'putConfig', config: { topologyKind: 'tree' } },
      divergentPayload: { operation: 'putConfig', config: { topologyKind: 'mesh' } },
      result: firstResult.right,
    }];

    const replay = await toTopologyAppInboxCommand({
      actor: first.actor,
      groupRef,
      requestId: first.requestId,
      capturedAtEpochMs: 9_000,
      payload: { operation: 'putConfig', config: { topologyKind: 'tree' } },
    });
    assert.equal(replay.commandHash, first.commandHash);
    const replayResult = await submitPGliteTopologyCommand(
      appGroup,
      authority,
      replay,
    );
    assert.deepEqual(replayResult.right, firstResult.right);

    const [persisted] = await sql<{ ri_resource: string }[]>`
      select ri_resource from resource_inbox
      where ri_type_id = 'APP_INBOX'
        and ri_resource_id = ${first.requestId}
    `;
    assert.ok(persisted);
    const message = JSON.parse(persisted.ri_resource) as ALMessage;
    const envelope = JSON.parse(message.payload.resource) as { data: TopologyAppInboxCommand };
    assert.equal(envelope.data.capturedAtEpochMs, 1_000);
    assert.equal(
      Number(
        (await sql<{ count: string | number }[]>`
        select count(*) as count from resource_inbox
        where ri_type_id = 'APP_INBOX'
          and ri_resource_id = ${first.requestId}
      `)[0]?.count,
      ),
      1,
    );

    for (
      const [requestId, payload, divergentPayload] of [
        [
          'stable-topology-override-put',
          {
            operation: 'putOverride',
            config: { degreeLimit: 4 },
            ttlMs: 60_000,
            expiresAtEpochMs: null,
          },
          {
            operation: 'putOverride',
            config: { degreeLimit: 5 },
            ttlMs: 60_000,
            expiresAtEpochMs: null,
          },
        ],
        [
          'stable-topology-override-delete',
          { operation: 'deleteOverride', target: 'override' },
          {
            operation: 'putOverride',
            config: { degreeLimit: 3 },
            ttlMs: 60_000,
            expiresAtEpochMs: null,
          },
        ],
        [
          'stable-topology-config-delete',
          { operation: 'deleteConfig', target: 'config' },
          { operation: 'putConfig', config: { topologyKind: 'mesh' } },
        ],
        [
          'stable-topology-reconfigure',
          { operation: 'reconfigureTopology', requestOptions: {}, publish: false },
          { operation: 'reconfigureTopology', requestOptions: {}, publish: true },
        ],
      ] as const
    ) {
      const command = await toTopologyAppInboxCommand({
        actor: first.actor,
        groupRef,
        requestId,
        capturedAtEpochMs: nowEpochMs,
        payload,
      });
      const pending = submitPGliteTopologyCommand(appGroup, authority, command);
      await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
      await inboxReader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        toResilienceDto(),
      );
      const result = await pending;
      assert.ok(result.right, `${payload.operation} did not complete`);
      acceptedHttpCommands.push({
        command,
        requestPayload: payload,
        divergentPayload,
        result: result.right,
      });
    }

    const [outboxCountBeforeReplay] = await sql<{ count: string | number }[]>`
      select count(*) as count from resource_inbox where ri_type_id = 'APP_OUTBOX'
    `;
    let freshProofRevision = 0;
    for (const accepted of acceptedHttpCommands) {
      freshProofRevision += 1;
      const freshAuthority: IssuedAuthSession = {
        ...authority,
        accessToken: `owner-replay-token-${freshProofRevision}`,
        issuedAtEpochMs: authority.issuedAtEpochMs + freshProofRevision,
      };
      await authSessions.putSession(freshAuthority);
      const replayAfterCurrentStateChanged = await toTopologyAppInboxCommand({
        actor: accepted.command.actor,
        groupRef,
        requestId: accepted.command.requestId,
        capturedAtEpochMs: accepted.command.capturedAtEpochMs + 30_000,
        payload: accepted.requestPayload,
      });
      assert.equal(
        replayAfterCurrentStateChanged.commandHash,
        accepted.command.commandHash,
      );
      const replayAfterChange = await submitPGliteTopologyCommand(
        appGroup,
        freshAuthority,
        replayAfterCurrentStateChanged,
      );
      assert.deepEqual(replayAfterChange.right, accepted.result);
      assert.equal(
        Number(
          (await sql<{ count: string | number }[]>`
            select count(*) as count from resource_inbox
            where ri_type_id = 'APP_INBOX'
              and ri_resource_id = ${accepted.command.requestId}
          `)[0]?.count,
        ),
        1,
      );

      const divergent = await toTopologyAppInboxCommand({
        actor: accepted.command.actor,
        groupRef,
        requestId: accepted.command.requestId,
        capturedAtEpochMs: accepted.command.capturedAtEpochMs + 60_000,
        payload: accepted.divergentPayload,
      });
      await assert.rejects(
        () => submitPGliteTopologyCommand(appGroup, freshAuthority, divergent),
        (error) =>
          error instanceof Error &&
          'code' in error && error.code === 'app-inbox-idempotency-conflict',
      );
    }
    assert.equal(freshProofRevision, 5);
    for (const accepted of acceptedHttpCommands) {
      const [durable] = await sql<{ ri_resource: string }[]>`
        select ri_resource from resource_inbox
        where ri_type_id = 'APP_INBOX'
          and ri_resource_id = ${accepted.command.requestId}
      `;
      assert.ok(durable);
      const durableMessage = JSON.parse(durable.ri_resource) as ALMessage;
      const durableEnvelope = JSON.parse(durableMessage.payload.resource) as {
        authority: {
          proof: {
            principalId: string;
            sessionId: string;
            sessionIssuedAtEpochMs: number;
          };
        };
      };
      assert.equal(
        durableEnvelope.authority.proof.principalId,
        authority.clientId,
      );
      assert.equal(
        durableEnvelope.authority.proof.sessionId,
        authority.sessionId,
      );
      assert.equal(
        durableEnvelope.authority.proof.sessionIssuedAtEpochMs,
        authority.issuedAtEpochMs,
      );
    }
    await authSessions.putSession(authority);
    assert.equal(
      Number(
        (await sql<{ count: string | number }[]>`
          select count(*) as count from resource_inbox where ri_type_id = 'APP_OUTBOX'
        `)[0]?.count,
      ),
      Number(outboxCountBeforeReplay?.count),
    );

    const processCommand = async (
      requestId: string,
      payload: TopologyAppInboxRequestPayload,
    ) => {
      const command = await toTopologyAppInboxCommand({
        actor: first.actor,
        groupRef,
        requestId,
        capturedAtEpochMs: nowEpochMs,
        payload,
      });
      const pending = submitPGliteTopologyCommand(appGroup, authority, command);
      await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
      await inboxReader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        toResilienceDto(),
      );
      return { command, result: await pending };
    };
    assert.ok(
      (await processCommand(
        'topology-clear-durable-base',
        { operation: 'putConfig', config: { degreeLimit: 4 } },
      )).result.right,
    );
    assert.ok(
      (await processCommand(
        'topology-clear-override-base',
        {
          operation: 'putOverride',
          config: { meshParamK: 4 },
          ttlMs: 60_000,
          expiresAtEpochMs: null,
        },
      )).result.right,
    );
    const durableUpdateUnderOverride = await processCommand(
      'topology-durable-under-full-override',
      { operation: 'putConfig', config: { degreeLimit: 3 } },
    );
    assert.ok(durableUpdateUnderOverride.result.right);
    const underOverride = await topology.readConfig(groupRef);
    assert.equal(underOverride.durable?.config.degreeLimit, 3);
    assert.equal(underOverride.temporary?.config.degreeLimit, 4);
    assert.equal(underOverride.effective.degreeLimit, 4);

    const cleared = await processCommand(
      'topology-clear-durable-field',
      { operation: 'putConfig', config: { degreeLimit: null } },
    );
    assert.ok(cleared.result.right);
    const afterClear = await topology.readConfig(groupRef);
    assert.equal(afterClear.durable?.config.degreeLimit, 5);
    assert.equal(afterClear.effective.degreeLimit, 4);
    assert.equal(afterClear.effective.meshParamK, 4);

    assert.ok(
      (await processCommand(
        'topology-clear-override-field',
        {
          operation: 'putOverride',
          config: { degreeLimit: null },
          ttlMs: 60_000,
          expiresAtEpochMs: null,
        },
      )).result.right,
    );
    assert.equal((await topology.readConfig(groupRef)).effective.degreeLimit, 5);

    assert.ok(
      (await processCommand(
        'topology-overwrite-after-clear',
        { operation: 'putConfig', config: { degreeLimit: 7 } },
      )).result.right,
    );
    const clearReplay = await toTopologyAppInboxCommand({
      actor: first.actor,
      groupRef,
      requestId: cleared.command.requestId,
      capturedAtEpochMs: nowEpochMs + 90_000,
      payload: { operation: 'putConfig', config: { degreeLimit: null } },
    });
    assert.deepEqual(
      (await submitPGliteTopologyCommand(appGroup, authority, clearReplay)).right,
      cleared.result.right,
    );
    assert.equal((await topology.readConfig(groupRef)).durable?.config.degreeLimit, 7);
    const clearDivergent = await toTopologyAppInboxCommand({
      actor: first.actor,
      groupRef,
      requestId: cleared.command.requestId,
      capturedAtEpochMs: nowEpochMs + 120_000,
      payload: { operation: 'putConfig', config: { degreeLimit: 5 } },
    });
    await assert.rejects(
      () => submitPGliteTopologyCommand(appGroup, authority, clearDivergent),
      (error) =>
        error instanceof Error &&
        'code' in error && error.code === 'app-inbox-idempotency-conflict',
    );

    const rttGroup = topologyGroupSnapshotWithSessions(
      groupRef,
      authority.sessionId,
      'peer-session',
      nowEpochMs,
    );
    appGroup.setRtcRttAppInboxDependencies({
      repository: new RtcRttRepository(runtime, { now: () => nowEpochMs }),
      readPolicyInputs: () =>
        Promise.resolve({
          candidateGroups: [rttGroup],
          overlaySnapshotsByGroupKey: new Map(),
          degreeLimit: 5,
        }),
    });
    configureRttRepository({ ttlMs: 60_000 });
    configureSharedGraphRepositories({
      graphs: { ttlMs: 60_000 },
      vivaldi: { ttlMs: 60_000 },
    });
    const wsServer = new JsonWebSocketServer();
    const wsSocket = new PGliteTestSocket();
    wsServer.addConnection(new ConnectionContext(authority.sessionId, wsSocket as never));
    const wsService = new WsQueueBoxServerService(
      new InMemoryQueueBox(new Map()),
      new InMemoryQueueBox(new Map()),
      wsServer,
      'pglite-ws-ingress',
    );
    const wsIngressCapturedAt: number[] = [];
    const wsTopics = initRallarSystemWsTopics(wsService, {
      rtcTopologyService: new RallarRtcTopologyService({ now: () => nowEpochMs }),
      rtcTopologyRuntimeState: { repository: runtime },
      processRtcRttMutation: async (input) => {
        wsIngressCapturedAt.push(input.capturedAtEpochMs);
        const result = await appGroup.processRtcRttUntilCompletion(input);
        if (result.right !== undefined) return result.right;
        throw new Error(result.left ?? 'RTC RTT AppInbox processing failed');
      },
    });
    const rtt = {
      sessionIdFrom: authority.sessionId,
      sessionIdTo: 'peer-session',
      rttMs: 12,
      createdAtEpochMs: nowEpochMs,
      version: 1,
    };
    const dispatchRtt = () =>
      wsSocket.dispatchMessage(newALBroadcastMessage(
        authority.sessionId,
        newALEventRoute(AppTopics.rtt, groupRef.groupId, 'pglite-rtt-replay'),
        'room',
        AppTopics.rtt,
        rtt,
        { groupRef },
      ));
    const rttPending = dispatchRtt();
    await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
    await inboxReader.dequeueInbox(
      InboxQueueReader.INBOX_DEQUEUE_TYPES,
      toResilienceDto(),
    );
    await rttPending;
    await new Promise((resolve) => setTimeout(resolve, 2));
    await dispatchRtt();
    wsTopics.stop();
    assert.equal(wsIngressCapturedAt.length, 2);
    assert.ok(wsIngressCapturedAt[1]! > wsIngressCapturedAt[0]!);

    assert.equal(
      Number(
        (await sql<{ count: string | number }[]>`
        select count(*) as count from resource_inbox
        where ri_type_id = 'APP_INBOX' and ri_status = 'COMPLETED'
      `)[0]?.count,
      ),
      12,
    );

    for (
      const collisionAuthority of [
        {
          ...authority,
          clientId: 'other-principal',
          sessionId: 'other-principal-session',
          accessToken: 'other-principal-token',
        },
        {
          ...authority,
          sessionId: 'owner-second-session',
          accessToken: 'owner-second-token',
        },
      ]
    ) {
      await authSessions.putSession(collisionAuthority);
      const actorDivergent = await toTopologyAppInboxCommand({
        actor: {
          principalId: collisionAuthority.clientId,
          sessionId: collisionAuthority.sessionId,
        },
        groupRef,
        requestId: first.requestId,
        capturedAtEpochMs: 15_000,
        payload: { operation: 'putConfig', config: { topologyKind: 'tree' } },
      });
      await assert.rejects(
        () =>
          submitPGliteTopologyCommand(
            appGroup,
            collisionAuthority,
            actorDivergent,
          ),
        (error) =>
          error instanceof Error &&
          'code' in error && error.code === 'app-inbox-idempotency-conflict',
      );
    }

    const revokedCommand = await toTopologyAppInboxCommand({
      actor: first.actor,
      groupRef,
      requestId: 'revoked-before-topology-write',
      capturedAtEpochMs: nowEpochMs,
      payload: { operation: 'putConfig', config: { topologyKind: 'mesh' } },
    });
    const revokedPending = submitPGliteTopologyCommand(
      appGroup,
      authority,
      revokedCommand,
    );
    await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
    await authSessions.deleteSession(authority);
    await inboxReader.dequeueInbox(
      InboxQueueReader.INBOX_DEQUEUE_TYPES,
      toResilienceDto(),
    );
    const revokedResult = await revokedPending;
    assert.match(revokedResult.left ?? '', /revoked|authority|session/i);
    await assert.rejects(
      () => submitPGliteTopologyCommand(appGroup, authority, first),
      (error) =>
        error instanceof Error &&
        'code' in error && error.code === 'group-mutation-authority-denied',
    );
    assert.equal(
      await new GroupTopologyConfigRepository(runtime).findMutationRecord(
        groupRef,
        revokedCommand.requestId,
      ),
      undefined,
    );
  });
});

Deno.test('PGlite topology route preserves structured AppInbox terminal and unavailable failures', async () => {
  await withPGliteSql(async (sql) => {
    const nowEpochMs = Date.parse('2026-07-23T00:00:00.000Z');
    const runtime = new PSqlRuntimeStateRepository(sql);
    const resourceInbox = new ResourceInboxRepository(sql);
    const resourceResults = new ResourceInboxResultsRepository(sql);
    const inboxReader = new InboxQueueReader(new PSqlQueueBox(resourceInbox));
    const authSessions = new AuthSessionRepository(runtime);
    const authority: IssuedAuthSession = {
      clientId: 'owner',
      sessionId: 'owner-session',
      accessToken: 'owner-token',
      username: 'owner',
      issuedAtEpochMs: nowEpochMs - 1_000,
      expiresAtEpochMs: FUTURE_MS,
    };
    await authSessions.putSession(authority);
    const groupRef = {
      applicationId: 'pglite-topology-route-errors',
      workspaceId: 'default',
      groupId: 'room',
    };
    const snapshot = topologyGroupSnapshot(groupRef);
    const groupRepository = new GroupStateRepository(runtime);
    assert.equal((await groupRepository.insertGroup(snapshot.group)).status, 'applied');
    for (const member of snapshot.members) await groupRepository.putMember(member);
    const groupState = createGroupStateService({
      runtimeRepository: runtime,
      createGroupStateEventStore: createGroupStateEventRepository,
      authSessionRepository: authSessions,
      serviceId: 'pglite-topology-route-errors',
      now: () => nowEpochMs,
    });
    const topology = new GroupTopologyManagementService({
      findGroupSnapshotByRef: (ref) => groupRepository.readSnapshot(ref),
      groupStateRepository: groupRepository,
      configRepository: new GroupTopologyConfigRepository(runtime),
      topologyService: new RallarRtcTopologyService({ now: () => nowEpochMs }),
      processRttReader: () => [],
      now: () => nowEpochMs,
    });
    const createAppGroup = (waitMaxElapsedMsecs: number) => {
      const service = new AppGroupInboxService(
        inboxReader,
        resourceInbox,
        resourceResults,
        sql,
        groupState,
        'pglite-topology-route-errors',
        undefined,
        {
          waitMaxElapsedMsecs,
          waitRetryIntervalMsecs: 1,
          waitMaxRetryIntervalMsecs: 4,
          waitJitterRatio: 0,
          nowEpochMs: () => nowEpochMs,
        },
      );
      service.setTopologyManagementService(topology);
      return service;
    };
    const appGroup = createAppGroup(5_000);
    const createRouteApp = (service: AppGroupInboxService) => {
      const app = new Hono();
      graphTopologyRoutes.init(app, {
        getGroupStateService: () => ({
          readSnapshot: (ref) => groupRepository.readSnapshot(ref),
        }),
        requireApiAuthSession: () => Promise.resolve(authority),
        readAppGroupInboxService: () => service,
        now: () => nowEpochMs,
      });
      return app;
    };
    const routePath =
      `/api/state/apps/${groupRef.applicationId}/workspaces/${groupRef.workspaceId}/groups/${groupRef.groupId}/topology/config`;
    const submit = (
      app: Hono,
      requestId: string,
      config: Record<string, unknown>,
    ) =>
      app.request(routePath, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer owner-token',
          'Idempotency-Key': requestId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ config }),
      });

    const validationPending = submit(
      createRouteApp(appGroup),
      'route-validation',
      { degreeLimit: 0 },
    );
    await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
    await inboxReader.dequeueInbox(
      InboxQueueReader.INBOX_DEQUEUE_TYPES,
      toResilienceDto(),
    );
    const validation = await validationPending;
    assert.equal(validation.status, 422);
    assert.deepEqual(await validation.json(), {
      error: 'Group topology config validation failed',
      code: 'group-topology-config-validation-failed',
      message: 'Group topology config validation failed',
      issues: [{
        code: 'invalid-positive-integer',
        path: ['degreeLimit'],
        message: 'degreeLimit must be a positive integer',
        details: { value: 0 },
      }],
      denial: null,
      retry: null,
    });

    const authorityPending = submit(
      createRouteApp(appGroup),
      'route-authority',
      { topologyKind: 'tree' },
    );
    await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
    await authSessions.deleteSession(authority);
    await inboxReader.dequeueInbox(
      InboxQueueReader.INBOX_DEQUEUE_TYPES,
      toResilienceDto(),
    );
    const denied = await authorityPending;
    assert.equal(denied.status, 403);
    const denialBody = await denied.json() as Record<string, unknown>;
    assert.equal(denialBody.code, 'group-mutation-authority-denied');
    assert.deepEqual(denialBody.denial, {
      code: 'group-mutation-authority-denied',
      message:
        'Forbidden: Topology mutation authority is missing, expired, revoked, or mismatched.',
      details: null,
    });
    await authSessions.putSession(authority);

    const firstPending = submit(
      createRouteApp(appGroup),
      'route-idempotency',
      { topologyKind: 'tree' },
    );
    await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
    await inboxReader.dequeueInbox(
      InboxQueueReader.INBOX_DEQUEUE_TYPES,
      toResilienceDto(),
    );
    assert.equal((await firstPending).status, 200);
    const conflict = await submit(
      createRouteApp(appGroup),
      'route-idempotency',
      { topologyKind: 'mesh' },
    );
    assert.equal(conflict.status, 409);
    assert.equal(
      (await conflict.json() as { code?: string }).code,
      'app-inbox-idempotency-conflict',
    );

    const unavailable = await submit(
      createRouteApp(createAppGroup(0)),
      'route-unavailable',
      { topologyKind: 'mesh' },
    );
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), {
      error: 'App inbox entry did not complete within the wait budget',
      code: 'app-inbox-unavailable',
      message: 'App inbox entry did not complete within the wait budget',
      issues: null,
      denial: null,
      retry: {
        kind: 'unavailable',
        attempts: null,
        lane: null,
        queueAgeMs: null,
        dueAgeMs: null,
      },
    });
  });
});

Deno.test('PGlite AppGroup rereads lifecycle after a retryable topology conflict', async () => {
  await withPGliteSql(async (sql) => {
    const nowEpochMs = Date.parse('2026-07-23T00:00:00.000Z');
    const runtime = new PSqlRuntimeStateRepository(sql);
    const resourceInbox = new ResourceInboxRepository(sql);
    let onFirstRetryRelease = async () => {};
    let retryReleaseCount = 0;
    class RetryObservedQueueBox extends PSqlQueueBox {
      override async releaseEntries(
        ...args: Parameters<PSqlQueueBox['releaseEntries']>
      ): ReturnType<PSqlQueueBox['releaseEntries']> {
        const released = await super.releaseEntries(...args);
        if (args[1].status === EntityStatus.RETRY && retryReleaseCount++ === 0) {
          await onFirstRetryRelease();
        }
        return released;
      }
    }
    const inboxReader = new InboxQueueReader(new RetryObservedQueueBox(resourceInbox));
    const authority: IssuedAuthSession = {
      clientId: 'owner',
      sessionId: 'retry-owner-session',
      accessToken: 'retry-owner-token',
      username: 'owner',
      issuedAtEpochMs: nowEpochMs - 1_000,
      expiresAtEpochMs: FUTURE_MS,
    };
    const authSessions = new AuthSessionRepository(runtime);
    await authSessions.putSession(authority);
    const groupRef = {
      applicationId: 'pglite-topology-retry',
      workspaceId: 'lifecycle',
      groupId: 'room',
    };
    const snapshot = topologyGroupSnapshot(groupRef);
    const groupRepository = new GroupStateRepository(runtime);
    assert.equal((await groupRepository.insertGroup(snapshot.group)).status, 'applied');
    for (const member of snapshot.members) await groupRepository.putMember(member);
    const configRepository = new GroupTopologyConfigRepository(runtime);
    const baselineTopology = new GroupTopologyManagementService({
      findGroupSnapshotByRef: (ref) => groupRepository.readSnapshot(ref),
      groupStateRepository: groupRepository,
      configRepository,
      topologyService: new RallarRtcTopologyService({ now: () => nowEpochMs }),
      processRttReader: () => [],
      now: () => nowEpochMs,
    });
    const staleConfigRead = await baselineTopology.readTopologyConfigMutation(
      topologyConfigCommand(
        groupRef,
        'lifecycle-change-after-conflict',
        'tree',
      ),
    );
    const groupState = createGroupStateService({
      runtimeRepository: runtime,
      createGroupStateEventStore: createGroupStateEventRepository,
      authSessionRepository: authSessions,
      serviceId: 'pglite-topology-retry',
      now: () => nowEpochMs,
    });
    let readCount = 0;
    let readsAtFirstRetryRelease = 0;
    let staleReadCount = 0;
    class StaleOnceTopologyService extends GroupTopologyManagementService {
      override async readTopologyConfigMutation(
        command: GroupTopologyConfigMutationCommand,
      ) {
        readCount += 1;
        if (
          command.commandId === 'lifecycle-change-after-conflict' &&
          staleReadCount === 0
        ) {
          staleReadCount += 1;
          return staleConfigRead;
        }
        return await super.readTopologyConfigMutation(command);
      }
    }
    const topology = new StaleOnceTopologyService({
      findGroupSnapshotByRef: (ref) => groupRepository.readSnapshot(ref),
      groupStateRepository: groupRepository,
      configRepository,
      topologyService: new RallarRtcTopologyService({ now: () => nowEpochMs }),
      processRttReader: () => [],
      now: () => nowEpochMs,
    });
    onFirstRetryRelease = async () => {
      readsAtFirstRetryRelease = readCount;
      const current = await groupRepository.findGroupEntry(groupRef);
      assert.ok(current);
      assert.equal(
        (await groupRepository.updateGroup({
          ...current.value,
          status: 'archived',
          snapshotVersion: current.value.snapshotVersion + 1,
          updated: canonicalAuditStamp(2),
          archived: canonicalAuditStamp(2),
          deleted: null,
        }, current.entry.revision)).status,
        'applied',
      );
    };
    const appGroup = new AppGroupInboxService(
      inboxReader,
      resourceInbox,
      new ResourceInboxResultsRepository(sql),
      sql,
      groupState,
      'pglite-topology-retry',
      undefined,
      {
        waitMaxElapsedMsecs: 5_000,
        waitRetryIntervalMsecs: 1,
        waitMaxRetryIntervalMsecs: 4,
        waitJitterRatio: 0,
        nowEpochMs: () => nowEpochMs,
      },
    );
    appGroup.setTopologyManagementService(topology);
    const seedCommand = await toTopologyAppInboxCommand({
      actor: { principalId: authority.clientId, sessionId: authority.sessionId },
      groupRef,
      requestId: 'lifecycle-conflict-seed-override',
      capturedAtEpochMs: nowEpochMs,
      payload: {
        operation: 'putOverride',
        config: { degreeLimit: 4 },
        ttlMs: 60_000,
        expiresAtEpochMs: null,
      },
    });
    const seedPending = submitPGliteTopologyCommand(
      appGroup,
      authority,
      seedCommand,
    );
    await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
    await inboxReader.dequeueInbox(
      InboxQueueReader.INBOX_DEQUEUE_TYPES,
      toResilienceDto(),
    );
    assert.ok((await seedPending).right);
    const command = await toTopologyAppInboxCommand({
      actor: { principalId: authority.clientId, sessionId: authority.sessionId },
      groupRef,
      requestId: 'lifecycle-change-after-conflict',
      capturedAtEpochMs: nowEpochMs,
      payload: { operation: 'putConfig', config: { topologyKind: 'tree' } },
    });
    const pending = submitPGliteTopologyCommand(appGroup, authority, command);
    await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
    await inboxReader.dequeueInbox(
      InboxQueueReader.INBOX_DEQUEUE_TYPES,
      toResilienceDto(),
    );
    const result = await pending;
    assert.match(result.left ?? '', /active|archived|lifecycle|forbidden/i);
    assert.equal(retryReleaseCount, 1);
    assert.equal(staleReadCount, 1);
    assert.ok(readsAtFirstRetryRelease >= 1);
    assert.ok(readCount > readsAtFirstRetryRelease);
    assert.equal(
      await configRepository.findMutationRecord(
        groupRef,
        command.requestId,
      ),
      undefined,
    );
  });
});

Deno.test('PGlite topology authority fence rejects an archive overlapping the stable authorization read', async () => {
  await withPGliteSql(async (sql) => {
    const runtime = new PSqlRuntimeStateRepository(sql);
    const topology = new GroupTopologyConfigRepository(runtime);
    const groupState = new GroupStateRepository(runtime);
    const groupRef = {
      applicationId: 'pglite-topology-authority',
      workspaceId: 'overlap',
      groupId: 'room',
    };
    const snapshot = topologyGroupSnapshot(groupRef);
    assert.equal((await groupState.insertGroup(snapshot.group)).status, 'applied');
    for (const member of snapshot.members) await groupState.putMember(member);
    const observed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let pauseFirstRead = false;
    class PausingGroupStateRepository extends GroupStateRepository {
      override async readSnapshotWithAuthorityGuard(ref: GroupRef) {
        const observation = await super.readSnapshotWithAuthorityGuard(ref);
        if (pauseFirstRead) {
          pauseFirstRead = false;
          observed.resolve();
          await release.promise;
        }
        return observation;
      }
    }
    const service = new GroupTopologyManagementService({
      findGroupSnapshotByRef: () => snapshot,
      groupStateRepository: new PausingGroupStateRepository(runtime),
      configRepository: topology,
      topologyService: new RallarRtcTopologyService(),
    });
    const command = topologyConfigCommand(
      groupRef,
      'pglite-overlapping-archive',
      'tree',
    );
    const preparation = await service.prepareTopologyConfigMutation({
      command,
      commandHash: await hashStateMutationCommand(command),
      capturedAtEpochMs: 1_000,
    });
    pauseFirstRead = true;
    const firstReadPromise = service.readTopologyConfigMutation(command);
    await observed.promise;
    const current = await groupState.findGroupEntry(groupRef);
    assert.ok(current);
    const archived: Group = {
      ...current.value,
      status: 'archived',
      snapshotVersion: current.value.snapshotVersion + 1,
      updated: canonicalAuditStamp(2),
      archived: canonicalAuditStamp(2),
      deleted: null,
    };
    assert.equal(
      (await groupState.updateGroup(archived, current.entry.revision)).status,
      'applied',
    );
    release.resolve();
    const firstRead = await firstReadPromise;
    const firstComputed = service.computeTopologyConfigMutation(
      preparation,
      firstRead,
      1,
    );
    service.validateTopologyConfigMutation(
      preparation,
      firstRead,
      1,
      firstComputed,
    );
    assert.equal(firstComputed.outcome, 'write');
    if (firstComputed.outcome !== 'write') throw new Error('Expected topology write');
    await assert.rejects(
      () =>
        sql.begin((transaction) => service.writeTopologyConfigMutation(transaction, firstComputed)),
      /conditional write conflict/,
    );
    const retryRead = await service.readTopologyConfigMutation(command);
    assert.throws(
      () =>
        service.computeTopologyConfigMutation(
          preparation,
          retryRead,
          2,
        ),
      (error: unknown) =>
        typeof error === 'object' && error !== null &&
        'status' in error && error.status === 403,
    );
    assert.equal(await topology.findConfig(groupRef), undefined);
    assert.equal(
      await topology.findMutationRecord(groupRef, 'pglite-overlapping-archive'),
      undefined,
    );
    assert.equal((await groupState.findGroup(groupRef))?.status, 'archived');
    assert.equal(
      Number(
        (await sql<{ count: string | number }[]>`
        select count(*) as count
        from resource_inbox
        where ri_type_id = 'APP_OUTBOX'
      `)[0]?.count,
      ),
      0,
    );
  });
});

Deno.test('PGlite topology planning uses the immutable group update time for a planned removal tombstone', async () => {
  await withPGliteSql(async (sql) => {
    const scenario = await createPGliteRemovalPlanningScenario(sql, {
      name: 'immutable-removal-time',
      status: 'archived',
      expiresAtEpochMs: null,
      updatedAtEpochMs: 123,
    });

    const result = scenario.service.computeTopologyFromAuthority(
      scenario.authority,
      scenario.previous,
    );

    assert.equal(result.snapshot.state, 'removed');
    assert.equal(result.snapshot.updatedAtEpochMs, 123);
    assert.equal(result.snapshot.createdAtEpochMs, 1);
  });
});

Deno.test('PGlite topology planning does not let a stale removal delete a newer active topology', async () => {
  await withPGliteSql(async (sql) => {
    const scenario = await createPGliteRemovalPlanningScenario(sql, {
      name: 'newer-active',
      status: 'active',
      expiresAtEpochMs: null,
      updatedAtEpochMs: 200,
    });

    const result = scenario.service.computeTopologyFromAuthority(
      scenario.authority,
      scenario.previous,
    );

    assert.equal(scenario.authority.group.group.status, 'active');
    assert.equal(result.snapshot.state, 'active');
    assert.deepEqual(
      result.snapshot.sourceGroupStateCausalRevision,
      scenario.authority.group.causalRevision,
    );
  });
});

Deno.test('PGlite topology planning does not treat a newer expired active group as removal cancellation', async () => {
  await withPGliteSql(async (sql) => {
    const scenario = await createPGliteRemovalPlanningScenario(sql, {
      name: 'newer-expired',
      status: 'active',
      expiresAtEpochMs: 999,
      updatedAtEpochMs: 201,
    });

    const result = scenario.service.computeTopologyFromAuthority(
      scenario.authority,
      scenario.previous,
    );

    assert.equal(scenario.authority.group.group.status, 'active');
    assert.equal(result.snapshot.state, 'removed');
    assert.deepEqual(
      result.snapshot.sourceGroupStateCausalRevision,
      scenario.authority.group.causalRevision,
    );
  });
});

Deno.test('PGlite topology planning replans a stale removal from the newer terminal group authority', async () => {
  await withPGliteSql(async (sql) => {
    const scenario = await createPGliteRemovalPlanningScenario(sql, {
      name: 'newer-terminal',
      status: 'archived',
      expiresAtEpochMs: null,
      updatedAtEpochMs: 202,
    });

    const result = scenario.service.computeTopologyFromAuthority(
      scenario.authority,
      scenario.previous,
    );

    assert.equal(scenario.authority.group.group.status, 'archived');
    assert.equal(result.snapshot.state, 'removed');
    assert.equal(result.snapshot.updatedAtEpochMs, 202);
    assert.deepEqual(
      result.snapshot.sourceGroupStateCausalRevision,
      scenario.authority.group.causalRevision,
    );
  });
});

Deno.test('PGlite topology planning filters stored RTTs that are not reporting edges for the recomputed group', async () => {
  await withPGliteSql(async (sql) => {
    const nowEpochMs = 1_000;
    const groupRef = {
      applicationId: 'pglite-topology-rtt-filter',
      workspaceId: 'planning',
      groupId: 'room',
    };
    const group = topologyGroupSnapshotWithSessionIds(
      groupRef,
      ['session-a', 'session-b', 'session-c'],
      nowEpochMs,
    );
    const runtime = new PSqlRuntimeStateRepository(sql);
    const groups = new GroupStateRepository(runtime);
    assert.equal((await groups.insertGroup(group.group)).status, 'applied');
    for (const member of group.members) await groups.putMember(member);
    for (const session of group.activeSessions) await groups.putPresenceSession(session);
    const rttRepository = new RtcRttRepository(runtime, {
      now: () => nowEpochMs,
    });
    const storedRtt = {
      sessionIdFrom: 'session-a',
      sessionIdTo: 'session-c',
      rttMs: 7,
      createdAtEpochMs: nowEpochMs,
      version: 1,
    };
    assert.equal(await rttRepository.putMeasurementIfNewer(storedRtt), true);
    let plannedRtts: readonly typeof storedRtt[] = [];
    class RecordingTopologyService extends RallarRtcTopologyService {
      override planGroupTopologyAt(
        ...args: Parameters<RallarRtcTopologyService['planGroupTopologyAt']>
      ): ReturnType<RallarRtcTopologyService['planGroupTopologyAt']> {
        plannedRtts = args[1] as readonly typeof storedRtt[];
        return super.planGroupTopologyAt(...args);
      }
    }
    const topologyService = new RecordingTopologyService({
      now: () => nowEpochMs,
      topologyKind: 'tree',
      degreeLimit: 2,
      rttReportingDegreeLimit: 1,
    });
    const service = new GroupTopologyManagementService({
      findGroupSnapshotByRef: () => group,
      groupStateRepository: groups,
      configRepository: new GroupTopologyConfigRepository(runtime),
      topologyService,
      rttRepository,
      serverDefaults: {
        topologyKind: 'tree',
        degreeLimit: 2,
        rttReportingDegreeLimit: 1,
      },
      now: () => nowEpochMs,
    });
    const previous = activeTopologySnapshot(
      groupRef,
      { groupRevision: 1, presenceRevision: 1 },
      ['session-a', 'session-b', 'session-c'],
      {
        'session-a': ['session-b'],
        'session-b': ['session-a', 'session-c'],
        'session-c': ['session-b'],
      },
    );
    const authority = await service.readTopologyPlanningAuthority(groupRef);
    assert.deepEqual(authority.rttMeasurements, [storedRtt]);

    service.computeTopologyFromAuthority(authority, previous);

    assert.deepEqual(plannedRtts, []);
  });
});

Deno.test('PGlite topology worker rereads terminal authority and the topology predecessor after a removal CAS conflict', async () => {
  await withPGliteSql(async (sql) => {
    const nowEpochMs = 1_000;
    const groupRef = {
      applicationId: 'pglite-removal-retry',
      workspaceId: 'planning',
      groupId: 'room',
    };
    const active = topologyGroupSnapshot(groupRef);
    const terminal: GroupSnapshot = {
      ...active,
      group: {
        ...active.group,
        status: 'archived',
        updated: canonicalAuditStamp(100),
        archived: canonicalAuditStamp(100),
        deleted: null,
      },
    };
    const runtimeRepository = new PSqlRuntimeStateRepository(sql);
    const groups = new GroupStateRepository(runtimeRepository);
    assert.equal((await groups.insertGroup(terminal.group)).status, 'applied');
    for (const member of terminal.members) await groups.putMember(member);
    const durableTerminal = await groups.readSnapshot(groupRef);
    assert.ok(durableTerminal);
    const snapshots = new RtcTopologySnapshotRepository(runtimeRepository);
    const predecessor = activeTopologySnapshot(
      groupRef,
      { groupRevision: 0, presenceRevision: 0 },
      [],
      {},
    );
    assert.equal(await snapshots.observeSnapshot(predecessor), 'inserted');
    const movedPredecessor = { ...predecessor, version: 1, updatedAtEpochMs: 2 };
    let authorityReadCount = 0;
    class MovePredecessorAfterFirstRead extends GroupTopologyManagementService {
      override async readTopologyPlanningAuthority(
        ...args: Parameters<GroupTopologyManagementService['readTopologyPlanningAuthority']>
      ) {
        const authority = await super.readTopologyPlanningAuthority(...args);
        authorityReadCount += 1;
        if (authorityReadCount === 1) {
          assert.equal(await snapshots.observeSnapshot(movedPredecessor), 'advanced');
        }
        return authority;
      }
    }
    const topologyManagement = new MovePredecessorAfterFirstRead({
      findGroupSnapshotByRef: (ref) => groups.readSnapshot(ref),
      groupStateRepository: groups,
      configRepository: new GroupTopologyConfigRepository(runtimeRepository),
      topologyService: new RallarRtcTopologyService({ now: () => nowEpochMs }),
      topologySnapshotRepository: snapshots,
      processRttReader: () => [],
      now: () => nowEpochMs,
    });
    const resourceInbox = new ResourceInboxRepository(sql);
    let retryReleaseCount = 0;
    class RetryObservedQueueBox extends PSqlQueueBox {
      override async releaseEntries(
        ...args: Parameters<PSqlQueueBox['releaseEntries']>
      ): ReturnType<PSqlQueueBox['releaseEntries']> {
        const released = await super.releaseEntries(...args);
        if (args[1].status === EntityStatus.RETRY) retryReleaseCount += 1;
        return released;
      }
    }
    const outboxReader = new OutboxQueueReader(
      new RetryObservedQueueBox(resourceInbox),
    );
    const workRuntime = createRtcTopologyOutboxPublisher({
      outboxQueueReader: outboxReader,
      senderId: 'pglite-removal-retry',
      now: () => nowEpochMs,
    });
    const executionRepository = new RtcTopologyExecutionRepository(
      runtimeRepository,
      60_000,
      () => nowEpochMs,
    );
    outboxReader.onOutboxMessageDo(
      workRuntime.workType,
      createRtcTopologyWorkHandler({
        runtime: workRuntime,
        database: sql,
        topologyManagement,
        executionRepository,
        publicationFanout: {
          readiness: Promise.resolve(),
          publish: () => Promise.resolve(0),
          deliverLocal: () => 0,
        },
      }),
    );
    await workRuntime.publisher.enqueueForGroupSnapshot(durableTerminal);

    await outboxReader.dequeueOutbox(
      OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
      toResilienceDto(),
    );

    const [work] = await sql<{
      ri_attempts: string | number;
      ri_status: string;
    }[]>`
      select ri_attempts, ri_status from resource_inbox
      where ri_type_id = 'APP_OUTBOX'
        and ri_topic_id = ${APP_OUTBOX_RTC_TOPOLOGY_TOPIC}
    `;
    assert.equal(retryReleaseCount, 1);
    assert.equal(Number(work?.ri_attempts), 2);
    assert.equal(work?.ri_status, EntityStatus.COMPLETED);
    assert.equal(authorityReadCount, 2);
    const committed = await executionRepository.findSnapshot(groupRef);
    assert.equal(committed?.state, 'removed');
    assert.equal(committed?.version, movedPredecessor.version);
    assert.deepEqual(
      committed?.sourceGroupStateCausalRevision,
      durableTerminal.causalRevision,
    );
  });
});

Deno.test('PGlite topology worker classifies exact WS outbox replay as idempotent', async () => {
  await withPGliteSql(async (sql) => {
    const fixture = await createPGliteTopologyWorkFixture(
      sql,
      'pglite-topology-ws-replay',
    );
    await new ResourceInboxRepository(sql).write(fixture.publicationEntry);

    await fixture.handler.onMessage(fixture.message, fixture.reserved);

    const consumed = await fixture.resourceInbox.findAnyByKey(fixture.workEntry.key);
    assert.equal(consumed?.status, EntityStatus.COMPLETED);
    assert.deepEqual(
      await fixture.executionRepository.findPublicationForWork(
        fixture.groupRef,
        fixture.workId,
      ),
      fixture.publication,
    );
    assert.deepEqual(
      await fixture.executionRepository.findSnapshot(fixture.groupRef),
      fixture.topology,
    );
    assert.equal(
      Number(
        (await sql<{ count: string | number }[]>`
        select count(*) as count
        from resource_inbox
        where ri_type_id = 'WS_OUTBOX'
      `)[0]?.count,
      ),
      1,
    );
  });
});

Deno.test('PGlite topology worker rolls state and receipt back on divergent WS outbox collision', async () => {
  await withPGliteSql(async (sql) => {
    const fixture = await createPGliteTopologyWorkFixture(
      sql,
      'pglite-topology-ws-collision',
    );
    const divergentResource = JSON.stringify({
      collision: 'preexisting-divergent-topology-publication',
    });
    await fixture.resourceInbox.write({
      ...fixture.publicationEntry,
      resource: divergentResource,
    });

    await assert.rejects(
      () => fixture.handler.onMessage(fixture.message, fixture.reserved),
      ResourceInboxInvariantCorruptionError,
    );

    assert.equal(
      await fixture.executionRepository.findPublicationForWork(
        fixture.groupRef,
        fixture.workId,
      ),
      undefined,
    );
    assert.equal(
      await fixture.executionRepository.findSnapshot(fixture.groupRef),
      undefined,
    );
    const consumed = await fixture.resourceInbox.findAnyByKey(fixture.workEntry.key);
    assert.equal(consumed?.status, EntityStatus.RESERVED);
    assert.equal(consumed?.dequeueAudit.attempts, 1);
    assert.equal(
      (await fixture.resourceInbox.findAnyByKey(fixture.publicationEntry.key))
        ?.resource,
      divergentResource,
    );
  });
});

Deno.test('PGlite topology worker rolls every effect back when reservation completion loses its fence', async () => {
  await withPGliteSql(async (sql) => {
    const fixture = await createPGliteTopologyWorkFixture(
      sql,
      'pglite-topology-finish-fence',
    );

    await assert.rejects(
      () =>
        fixture.handler.onMessage(fixture.message, {
          ...fixture.reserved,
          dequeueAudit: {
            ...fixture.reserved.dequeueAudit,
            attempts: fixture.reserved.dequeueAudit.attempts + 1,
          },
        }),
      RuntimeStateWriteConflictError,
    );

    assert.equal(
      await fixture.executionRepository.findPublicationForWork(
        fixture.groupRef,
        fixture.workId,
      ),
      undefined,
    );
    assert.equal(
      await fixture.executionRepository.findSnapshot(fixture.groupRef),
      undefined,
    );
    assert.equal(
      await fixture.resourceInbox.findAnyByKey(fixture.publicationEntry.key),
      null,
    );
    const consumed = await fixture.resourceInbox.findAnyByKey(fixture.workEntry.key);
    assert.equal(consumed?.status, EntityStatus.RESERVED);
    assert.equal(consumed?.dequeueAudit.attempts, 1);
  });
});

Deno.test('PGlite runtime-state transactions isolate nested savepoint rollback', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlRuntimeStateRepository(sql);

    await repository.begin(async (outer) => {
      await outer.upsert('nested-tx', 'outer', 'outer', FUTURE_MS);
      await assert.rejects(
        async () => {
          await outer.begin(async (inner) => {
            await inner.upsert('nested-tx', 'rolled-back', 'rolled-back', FUTURE_MS);
            throw new Error('rollback nested savepoint');
          });
        },
        /rollback nested savepoint/,
      );
      assert.equal(await outer.findEntry('nested-tx', 'rolled-back'), undefined);

      await outer.begin(async (inner) => {
        await inner.upsert('nested-tx', 'committed', 'committed', FUTURE_MS);
      });
    });

    assert.equal((await repository.findEntry('nested-tx', 'outer'))?.value, 'outer');
    assert.equal((await repository.findEntry('nested-tx', 'committed'))?.value, 'committed');
    assert.equal(await repository.findEntry('nested-tx', 'rolled-back'), undefined);
  });
});

Deno.test('PSqlRuntimeStateRepository treats encoded prefix characters literally', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlRuntimeStateRepository(sql);
    const literalPrefix = 'app=ops%2Fapp:ws=workspace%3Ablue';
    const wildcardCollisionPrefix = 'app=opsZZ2Fapp:ws=workspaceZZ3Ablue';

    await repository.upsert(
      'runtime-prefix',
      `${literalPrefix}:group=room-a`,
      '{"room":"a"}',
      FUTURE_MS,
    );
    await repository.upsert(
      'runtime-prefix',
      `${literalPrefix}:group=room-b`,
      '{"room":"b"}',
      FUTURE_MS,
    );
    await repository.upsert(
      'runtime-prefix',
      `${wildcardCollisionPrefix}:group=room-b`,
      '{"room":"b"}',
      FUTURE_MS,
    );

    const entries = await repository.findEntriesByPrefix(
      'runtime-prefix',
      `${literalPrefix}:`,
    );
    const firstPage = await repository.findEntriesByPrefixPage(
      'runtime-prefix',
      `${literalPrefix}:`,
      { limit: 1 },
    );
    const secondPage = await repository.findEntriesByPrefixPage(
      'runtime-prefix',
      `${literalPrefix}:`,
      {
        afterKey: `${literalPrefix}:group=room-a`,
        limit: 1,
      },
    );

    assert.deepEqual(entries.map((entry) => entry.key), [
      `${literalPrefix}:group=room-a`,
      `${literalPrefix}:group=room-b`,
    ]);
    assert.deepEqual(firstPage.map((entry) => entry.key), [
      `${literalPrefix}:group=room-a`,
    ]);
    assert.deepEqual(secondPage.map((entry) => entry.key), [
      `${literalPrefix}:group=room-b`,
    ]);
  });
});

Deno.test('PGlite runtime-state hierarchy isolates sibling key segments', async () => {
  await withPGliteSql(async (sql) => {
    const runtime = new PSqlRuntimeStateRepository(sql);
    const clients = new ClientStateRepository(runtime);
    const groups = new GroupStateRepository(runtime);
    const audit = canonicalAuditStamp(1);

    assert.equal(
      (await clients.insertPrincipal({
        applicationId: 'app',
        workspaceId: 'foo',
        principalId: 'alice',
        username: 'alice',
        displayName: null,
        avatarUrl: null,
        authProvider: null,
        externalSubjectId: null,
        roles: [],
        metadata: {},
        status: 'active',
        snapshotVersion: 1,
        profileVersion: 1,
        presenceVersion: 1,
        created: audit,
        updated: audit,
        lastSeenAtEpochMs: null,
        disabled: null,
        deleted: null,
      })).status,
      'applied',
    );
    assert.equal(
      (await clients.insertPrincipal({
        applicationId: 'app',
        workspaceId: 'foobar',
        principalId: 'bob',
        username: 'bob',
        displayName: null,
        avatarUrl: null,
        authProvider: null,
        externalSubjectId: null,
        roles: [],
        metadata: {},
        status: 'active',
        snapshotVersion: 1,
        profileVersion: 1,
        presenceVersion: 1,
        created: audit,
        updated: audit,
        lastSeenAtEpochMs: null,
        disabled: null,
        deleted: null,
      })).status,
      'applied',
    );
    await groups.putGroup(groupFixture({
      applicationId: 'app',
      workspaceId: 'foo',
      groupId: 'room',
    }, 'Foo room'));
    await groups.putGroup(groupFixture({
      applicationId: 'app',
      workspaceId: 'foobar',
      groupId: 'room',
    }, 'Foobar room'));

    assert.deepEqual(
      (await clients.listPrincipals({ applicationId: 'app', workspaceId: 'foo' }))
        .map((value) => value.workspaceId),
      ['foo'],
    );
    assert.deepEqual(
      (await groups.listGroups({ applicationId: 'app', workspaceId: 'foo' }))
        .map((value) => value.workspaceId),
      ['foo'],
    );
  });
});

Deno.test('PGlite group-state reads fail closed on a directly seeded legacy wrong-scope row', async () => {
  await withPGliteSql(async (sql) => {
    const ref = {
      applicationId: 'pglite-legacy-scope-app',
      workspaceId: 'main',
      groupId: 'pglite-legacy-scope-group',
    };
    const storedGroup = {
      ...ref,
      workspaceId: '_',
      displayName: 'Legacy explicit sentinel',
      kind: 'room',
      status: 'active',
      joinMode: 'open',
      metadata: {},
      activeMemberCount: 0,
      ownerPrincipalId: 'owner',
      snapshotVersion: 1,
      metadataVersion: 1,
      rosterVersion: 1,
      presenceVersion: 0,
      created: { atEpochMs: 1_000 },
      updated: { atEpochMs: 1_000 },
    };
    await sql`
      insert into runtime_state_store (
        store_namespace, store_key, store_value, expire_at_ts
      ) values (
        'group-state:groups',
        'app=pglite-legacy-scope-app:ws=main:group=pglite-legacy-scope-group',
        ${JSON.stringify(storedGroup)},
        ${new Date(FUTURE_MS)}
      )
    `;
    const repository = new GroupStateRepository(
      new PSqlRuntimeStateRepository(sql),
    );

    for (
      const read of [
        () => repository.findGroup(ref),
        () => repository.readSnapshot(ref),
        () =>
          repository.listGroups({
            applicationId: ref.applicationId,
            workspaceId: ref.workspaceId,
          }),
        () =>
          repository.listSnapshots({
            applicationId: ref.applicationId,
            workspaceId: ref.workspaceId,
          }),
        () =>
          repository.listSnapshotsPage(
            {
              applicationId: ref.applicationId,
              workspaceId: ref.workspaceId,
            },
            { limit: 10 },
          ),
      ]
    ) {
      await assert.rejects(read, (error) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'group-state-repository-invariant-corruption');
    }
  });
});

Deno.test('PGlite group-state reads reject complete-contract corruption across public boundaries', async () => {
  await withPGliteSql(async (sql) => {
    const cases = [
      { kind: 'group', namespace: 'group-state:groups', field: 'joinMode' },
      { kind: 'member', namespace: 'group-state:members', field: 'status' },
      { kind: 'session', namespace: 'group-state:sessions', field: 'generationId' },
      {
        kind: 'summary',
        namespace: 'group-state:presence-summaries',
        field: 'causalRevision',
      },
    ] as const;

    for (const testCase of cases) {
      const scope = {
        applicationId: `pglite-complete-${testCase.kind}`,
        workspaceId: 'main',
      };
      const ref = { ...scope, groupId: `group-${testCase.kind}` };
      const authority = {
        clientId: 'alice',
        sessionId: `alice-session-${testCase.kind}`,
        accessToken: `alice-token-${testCase.kind}`,
        username: 'alice',
        issuedAtEpochMs: 1,
        expiresAtEpochMs: 100_000,
      };
      let eventSequence = 0;
      const runtime = new PSqlRuntimeStateRepository(sql);
      const service = createGroupStateService({
        runtimeRepository: runtime,
        createGroupStateEventStore: createGroupStateEventRepository,
        authSessionRepository: {
          findBySessionId: (sessionId) =>
            Promise.resolve(sessionId === authority.sessionId ? authority : undefined),
        },
        now: () => 10_000,
        randomId: () => `event-${testCase.kind}-${eventSequence++}`,
        serviceId: `pglite-complete-${testCase.kind}`,
      });
      await applyPGliteGroupMutation(
        sql,
        service,
        mutationDescriptor('createGroup', scope, ref.groupId, {
          groupId: ref.groupId,
          displayName: `Complete ${testCase.kind}`,
          kind: 'room',
          joinMode: 'open',
          createdByPrincipalId: 'alice',
          requestId: `create-${testCase.kind}`,
        }),
        authority,
      );
      if (testCase.kind === 'session') {
        await applyPGliteGroupMutation(
          sql,
          service,
          mutationDescriptor(
            'connectPresence',
            scope,
            ref.groupId,
            {
              principalId: 'alice',
              generationId: `generation-${testCase.kind}`,
              connectedAtEpochMs: 10_000,
              lastHeartbeatAtEpochMs: 10_000,
              expiresAtEpochMs: 4_102_444_800_000,
              actorPrincipalId: 'alice',
              actorSessionId: authority.sessionId,
              requestId: `connect-${testCase.kind}`,
            },
            'alice',
            authority.sessionId,
          ),
          authority,
        );
      }

      const storageKey = testCase.kind === 'member'
        ? groupStateMemberStorageKey({ ...ref, principalId: 'alice' })
        : testCase.kind === 'session'
        ? groupStatePresenceSessionStorageKey({ ...ref, sessionId: authority.sessionId })
        : groupStateGroupStorageKey(ref);
      await sql`
        update runtime_state_store
        set store_value = (store_value::jsonb - ${testCase.field})::text
        where store_namespace = ${testCase.namespace}
          and store_key = ${storageKey}
      `;

      const repository = new GroupStateRepository(runtime);
      const reads = testCase.kind === 'group'
        ? [
          () => repository.findGroup(ref),
          () => repository.listGroups(scope),
          () => repository.readSnapshot(ref),
          () => repository.listSnapshots(scope),
          () => repository.listSnapshotsPage(scope, { limit: 10 }),
        ]
        : testCase.kind === 'member'
        ? [
          () => repository.findMember({ ...ref, principalId: 'alice' }),
          () => repository.listMembers(ref),
          () => repository.readSnapshot(ref),
          () => repository.listSnapshots(scope),
          () => repository.listSnapshotsPage(scope, { limit: 10 }),
        ]
        : testCase.kind === 'session'
        ? [
          () => repository.findPresenceSession({ ...ref, sessionId: authority.sessionId }),
          () => repository.listPresenceSessions(ref),
          () => repository.listAllPresenceSessions(),
          () => repository.readSnapshot(ref),
          () => repository.listSnapshots(scope),
          () => repository.listSnapshotsPage(scope, { limit: 10 }),
        ]
        : [
          () => repository.findPresenceSummaryEntry(ref),
          () => repository.readSnapshot(ref),
          () => repository.listSnapshots(scope),
          () => repository.listSnapshotsPage(scope, { limit: 10 }),
        ];
      for (const [readIndex, read] of reads.entries()) {
        await assert.rejects(
          read,
          (error) =>
            error instanceof Error &&
            'code' in error &&
            error.code === 'group-state-repository-invariant-corruption',
          `${testCase.kind} public read ${readIndex} accepted a corrupt persisted record`,
        );
      }
    }
  });
});

Deno.test('PSql state event repositories page by snapshot cursor order', async () => {
  await withPGliteSql(async (sql) => {
    const clientEvents = new PSqlClientStateEventRepository(sql);
    const groupEvents = new PSqlGroupStateEventRepository(sql);
    const clientRef = {
      applicationId: 'rallar-test',
      workspaceId: 'main',
      principalId: 'principal-1',
    };
    const groupRef = {
      applicationId: 'rallar-test',
      workspaceId: 'main',
      groupId: 'room-1',
    };

    await clientEvents.appendClientEvent(
      createClientStateEvent('client-late-snapshot', 1_000, 30),
    );
    await clientEvents.appendClientEvent(
      createClientStateEvent('client-early-snapshot', 2_000, 10),
    );
    await clientEvents.appendClientEvent(
      createClientStateEvent('client-middle-snapshot', 3_000, 20),
    );
    const firstClientDuplicate = createClientStateEvent(
      'client-filtered',
      4_000,
      40,
      'session-disconnected',
    );
    await clientEvents.appendClientEvent(firstClientDuplicate);
    await clientEvents.appendClientEvent(structuredClone(firstClientDuplicate));
    await assert.rejects(
      () =>
        clientEvents.appendClientEvent(
          createClientStateEvent('client-filtered', 5_000, 50, 'session-disconnected', {
            reason: 'updated',
          }),
        ),
      (error) => error instanceof ClientStateEventCollisionError,
    );

    const firstClientPage = await clientEvents.listClientEventPage(
      clientRef,
      { limit: 2 },
    );
    const secondClientPage = await clientEvents.listClientEventPage(
      clientRef,
      {
        limit: 2,
        after: firstClientPage.nextCursor,
      },
    );
    const filteredClientPage = await clientEvents.listClientEventPage(
      clientRef,
      {
        eventTypes: ['session-disconnected'],
        limit: 1,
      },
    );
    const recentClientEvents = await clientEvents.listRecentClientEvents(
      clientRef,
      { limit: 2 },
    );
    const recentFilteredClientEvents = await clientEvents.listRecentClientEvents(
      clientRef,
      {
        eventTypes: ['session-disconnected'],
        limit: 1,
        after: firstClientPage.nextCursor,
      },
    );

    assert.deepEqual(
      firstClientPage.events.map((event) => event.eventId),
      ['client-early-snapshot', 'client-middle-snapshot'],
    );
    assert.equal(firstClientPage.hasMore, true);
    assert.deepEqual(
      secondClientPage.events.map((event) => event.eventId),
      ['client-late-snapshot', 'client-filtered'],
    );
    assert.equal(secondClientPage.hasMore, false);
    assert.equal(filteredClientPage.events[0].reason, null);
    assert.deepEqual(filteredClientPage.nextCursor, {
      snapshotVersion: 40,
      occurredAtEpochMs: 4_000,
      eventId: 'client-filtered',
    });
    assert.deepEqual(
      (await clientEvents.listClientEvents(clientRef)).map((event) => event.eventId),
      [
        'client-early-snapshot',
        'client-middle-snapshot',
        'client-late-snapshot',
        'client-filtered',
      ],
    );
    assert.deepEqual(
      recentClientEvents.map((event) => event.eventId),
      ['client-late-snapshot', 'client-filtered'],
    );
    assert.deepEqual(
      recentFilteredClientEvents.map((event) => event.eventId),
      ['client-filtered'],
    );

    await groupEvents.appendGroupEvent(
      createGroupStateEvent('group-late-snapshot', 1_000, 30),
    );
    await groupEvents.appendGroupEvent(
      createGroupStateEvent('group-early-snapshot', 2_000, 10),
    );
    await groupEvents.appendGroupEvent(
      createGroupStateEvent('group-middle-snapshot', 3_000, 20),
    );
    const firstDuplicate = createGroupStateEvent(
      'group-duplicate',
      4_000,
      40,
      'member-left',
    );
    await groupEvents.appendGroupEvent(firstDuplicate);
    await groupEvents.appendGroupEvent(structuredClone(firstDuplicate));
    await assert.rejects(
      () =>
        groupEvents.appendGroupEvent(
          createGroupStateEvent('group-duplicate', 5_000, 50, 'member-left', {
            reason: 'updated',
          }),
        ),
      (error) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'group-state-event-collision',
    );

    const firstGroupPage = await groupEvents.listGroupEventPage(groupRef, {
      limit: 2,
    });
    const secondGroupPage = await groupEvents.listGroupEventPage(groupRef, {
      limit: 2,
      after: firstGroupPage.nextCursor,
    });
    const recentGroupEvents = await groupEvents.listRecentGroupEvents(
      groupRef,
      { limit: 2 },
    );

    assert.deepEqual(
      firstGroupPage.events.map((event) => event.eventId),
      ['group-early-snapshot', 'group-middle-snapshot'],
    );
    assert.equal(firstGroupPage.hasMore, true);
    assert.deepEqual(
      secondGroupPage.events.map((event) => event.eventId),
      ['group-late-snapshot', 'group-duplicate'],
    );
    assert.equal(secondGroupPage.hasMore, false);
    assert.equal(secondGroupPage.events[1]?.reason, null);
    assert.deepEqual(secondGroupPage.nextCursor, {
      snapshotVersion: 40,
      occurredAtEpochMs: 4_000,
      eventId: 'group-duplicate',
    });
    assert.deepEqual(
      recentGroupEvents.map((event) => event.eventId),
      ['group-late-snapshot', 'group-duplicate'],
    );
  });
});

Deno.test('PSql group events isolate ordinary and sentinel workspaces without event-id loss', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlGroupStateEventRepository(sql);
    const ordinaryRef = {
      applicationId: 'group-event-scope-app',
      workspaceId: 'main',
      groupId: 'shared-group',
    };
    const explicitSentinelRef = { ...ordinaryRef, workspaceId: '_' };
    const ordinaryEvent = createGroupStateEvent('shared-event', 1_000, 1, 'group-updated', {
      ...ordinaryRef,
      reason: 'ordinary',
    });
    const explicitSentinelEvent = createGroupStateEvent(
      'shared-event',
      2_000,
      2,
      'group-updated',
      {
        ...explicitSentinelRef,
        reason: 'explicit-sentinel',
      },
    );

    await repository.appendGroupEvent(ordinaryEvent);
    await repository.appendGroupEvent(explicitSentinelEvent);

    for (
      const [ref, expected] of [
        [ordinaryRef, ordinaryEvent],
        [explicitSentinelRef, explicitSentinelEvent],
      ] as const
    ) {
      assert.deepEqual(await repository.listGroupEvents(ref), [expected]);
      assert.deepEqual(await repository.listRecentGroupEvents(ref), [expected]);
      assert.deepEqual(
        (await repository.listGroupEventPage(ref, { limit: 1 })).events,
        [expected],
      );
    }

    const rows = await sql<{ workspace_key: string }[]>`
      select workspace_key
      from group_state_events
      where application_id = ${ordinaryRef.applicationId}
        and group_id = ${ordinaryRef.groupId}
        and event_id = ${ordinaryEvent.eventId}
      order by workspace_key
    `;
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0]?.workspace_key, rows[1]?.workspace_key);
  });
});

Deno.test('PGlite group event collision rolls back the authoritative mutation transaction', async () => {
  await withPGliteSql(async (sql) => {
    const runtime = new PSqlRuntimeStateRepository(sql);
    const authority = {
      clientId: 'alice',
      sessionId: 'alice-session',
      accessToken: 'test-token',
      username: 'alice',
      issuedAtEpochMs: 1,
      expiresAtEpochMs: 100_000,
    };
    const service = createGroupStateService({
      runtimeRepository: runtime,
      createGroupStateEventStore: createGroupStateEventRepository,
      authSessionRepository: {
        findBySessionId: (sessionId) =>
          Promise.resolve(sessionId === authority.sessionId ? authority : undefined),
      },
      now: () => 10_000,
      serviceId: 'pglite-group-service',
    });
    const scope = { applicationId: 'collision-app', workspaceId: 'main' };
    const ref = { ...scope, groupId: 'collision-group' };
    await applyPGliteGroupMutation(
      sql,
      service,
      mutationDescriptor('createGroup', scope, ref.groupId, {
        groupId: ref.groupId,
        displayName: 'Before collision',
        kind: 'room',
        joinMode: 'open',
        createdByPrincipalId: 'alice',
        requestId: 'seed-collision-group',
      }),
      authority,
    );
    const updateDescriptor = mutationDescriptor('updateGroup', scope, ref.groupId, {
      displayName: 'Must roll back',
      actorPrincipalId: 'alice',
      requestId: 'collision-request',
    });
    const updatePreparation = await service.prepareMutation(updateDescriptor, authority);
    await new PSqlGroupStateEventRepository(sql).appendGroupEvent(
      createGroupStateEvent(updatePreparation.facts.eventId, 9_000, 99, 'group-updated', {
        ...ref,
        requestId: 'preexisting-event',
      }),
    );

    await assert.rejects(
      () => applyPreparedPGliteGroupMutation(sql, service, updatePreparation),
      (error) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'group-state-event-collision',
    );

    const repository = new GroupStateRepository(runtime);
    assert.equal((await repository.findGroup(ref))?.displayName, 'Before collision');
    assert.equal(
      await repository.findIdempotentGroupMutationReceipt(ref, 'collision-request'),
      undefined,
    );
    const collisionOutbox = (await runtime.findAllEntries('state-mutation:outbox'))
      .map((entry) => JSON.parse(entry.value) as { commandId?: string })
      .filter((record) => record.commandId === 'collision-request');
    assert.deepEqual(collisionOutbox, []);
    const collisionRows = await sql<{ count: string }[]>`
      select count(*) as count
      from group_state_events
      where application_id = ${ref.applicationId}
        and workspace_key = ${groupEventWorkspaceKey(ref.workspaceId)}
        and group_id = ${ref.groupId}
        and event_id = ${updatePreparation.facts.eventId}
    `;
    assert.equal(Number(collisionRows[0]?.count), 1);
    const [summaryRows] = await sql<{ count: string | number }[]>`
      select count(*) as count
      from resource_inbox
      where ri_topic_id = ${APP_OUTBOX_GROUP_PRESENCE_SUMMARY_TOPIC}
        and ri_resource like ${'%collision-request%'}
    `;
    assert.equal(Number(summaryRows?.count ?? 0), 0);
  });
});

Deno.test('PGlite group summary outbox collision rolls back state event and receipt atomically', async () => {
  await withPGliteSql(async (sql) => {
    const runtime = new PSqlRuntimeStateRepository(sql);
    const authority = {
      clientId: 'alice',
      sessionId: 'alice-session',
      accessToken: 'test-token',
      username: 'alice',
      issuedAtEpochMs: 1,
      expiresAtEpochMs: 100_000,
    };
    const service = createGroupStateService({
      runtimeRepository: runtime,
      createGroupStateEventStore: createGroupStateEventRepository,
      authSessionRepository: {
        findBySessionId: (sessionId) =>
          Promise.resolve(sessionId === authority.sessionId ? authority : undefined),
      },
      now: () => 10_000,
      serviceId: 'pglite-group-summary-collision',
    });
    const scope = { applicationId: 'summary-collision-app', workspaceId: 'main' };
    const ref = { ...scope, groupId: 'summary-collision-group' };
    await applyPGliteGroupMutation(
      sql,
      service,
      mutationDescriptor('createGroup', scope, ref.groupId, {
        groupId: ref.groupId,
        displayName: 'Before summary collision',
        kind: 'room',
        joinMode: 'open',
        createdByPrincipalId: 'alice',
        requestId: 'seed-summary-collision-group',
      }),
      authority,
    );

    const preparation = await service.prepareMutation(
      mutationDescriptor('updateGroup', scope, ref.groupId, {
        displayName: 'Must roll back at summary outbox',
        actorPrincipalId: 'alice',
        requestId: 'summary-collision-request',
      }),
      authority,
    );
    const command = {
      ...preparation,
      facts: { ...preparation.facts, attemptCount: 1 },
    };
    const read = await service.read(command);
    const computed = service.compute(command, read);
    service.validate(command, read, computed);
    assert.equal(computed.outcome, 'write');
    if (computed.outcome !== 'write') throw new TypeError('Expected summary collision write');
    const [summaryEntry] = computed.outboxEntries;
    assert.ok(summaryEntry);
    const divergentResource = JSON.stringify({
      collision: 'preexisting-divergent-summary-work',
    });
    await new ResourceInboxRepository(sql).write({
      ...summaryEntry,
      resource: divergentResource,
    });

    await assert.rejects(
      () => sql.begin(async (transaction) => await service.write(transaction, computed)),
      ResourceInboxInvariantCorruptionError,
    );

    const repository = new GroupStateRepository(runtime);
    assert.equal((await repository.findGroup(ref))?.displayName, 'Before summary collision');
    assert.equal(
      await repository.findIdempotentGroupMutationReceipt(ref, 'summary-collision-request'),
      undefined,
    );
    const [eventRows] = await sql<{ count: string | number }[]>`
      select count(*) as count
      from group_state_events
      where application_id = ${ref.applicationId}
        and workspace_key = ${groupEventWorkspaceKey(ref.workspaceId)}
        and group_id = ${ref.groupId}
        and event_id = ${preparation.facts.eventId}
    `;
    assert.equal(Number(eventRows?.count ?? 0), 0);
    const storedCollision = await new ResourceInboxRepository(sql).findAnyByKey(
      summaryEntry.key,
    );
    assert.equal(storedCollision?.resource, divergentResource);
  });
});

Deno.test('PSql group event reads fail closed on a legacy wrong-scope payload', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlGroupStateEventRepository(sql);
    const expectedRef = {
      applicationId: 'legacy-group-event-app',
      workspaceId: 'main',
      groupId: 'legacy-group-event-group',
    };
    const corruptEvent = createGroupStateEvent('legacy-event', 1_000, 1, 'group-updated', {
      ...expectedRef,
      workspaceId: '_',
    });
    await sql`
      insert into group_state_events (
        application_id, workspace_key, group_id, event_id, event_type,
        snapshot_version, occurred_at_epoch_ms, event_json
      ) values (
        ${expectedRef.applicationId}, ${groupEventWorkspaceKey(expectedRef.workspaceId)},
        ${expectedRef.groupId},
        ${corruptEvent.eventId}, ${corruptEvent.eventType},
        ${corruptEvent.snapshotVersion}, ${corruptEvent.occurredAtEpochMs},
        ${JSON.stringify(corruptEvent)}
      )
    `;

    for (
      const read of [
        () => repository.listGroupEvents(expectedRef),
        () => repository.listRecentGroupEvents(expectedRef),
        () => repository.listGroupEventPage(expectedRef, { limit: 10 }),
      ]
    ) {
      await assert.rejects(read, (error) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'group-state-event-repository-invariant-corruption');
    }
  });
});

Deno.test('PSql group event reads normalize the f135 legacy contract at the storage boundary', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlGroupStateEventRepository(sql);
    const ref = {
      applicationId: 'legacy-group-event-normalization-app',
      workspaceId: 'main',
      groupId: 'legacy-group-event-normalization-group',
    };
    const eventType: GroupEvent['eventType'] = 'group-updated';
    const legacyEvent = {
      applicationId: ref.applicationId,
      groupId: ref.groupId,
      eventId: 'legacy-normalized-event',
      eventType,
      snapshotVersion: 7,
      occurredAtEpochMs: 1_000,
      actor: { principalId: 'alice' },
    };
    await sql`
      insert into group_state_events (
        application_id, workspace_key, group_id, event_id, event_type,
        snapshot_version, occurred_at_epoch_ms, event_json
      ) values (
        ${ref.applicationId}, ${groupEventWorkspaceKey(ref.workspaceId)},
        ${ref.groupId}, ${legacyEvent.eventId}, ${legacyEvent.eventType},
        ${legacyEvent.snapshotVersion}, ${legacyEvent.occurredAtEpochMs},
        ${JSON.stringify(legacyEvent)}
      )
    `;

    const expected: GroupEvent = {
      ...legacyEvent,
      workspaceId: ref.workspaceId,
      causalRevision: { groupRevision: 7, presenceRevision: 0 },
      actor: { kind: 'principal', principalId: 'alice' },
      reason: null,
      traceId: null,
      requestId: null,
      payload: {},
    };
    assert.deepEqual(await repository.listGroupEvents(ref), [expected]);
    assert.deepEqual(await repository.listRecentGroupEvents(ref), [expected]);
    assert.deepEqual(
      (await repository.listGroupEventPage(ref, { limit: 1 })).events,
      [expected],
    );
  });
});

Deno.test('PSql group event reads reject explicit null legacy identities and payloads', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlGroupStateEventRepository(sql);
    for (
      const [suffix, defect] of [
        ['workspace', { workspaceId: null }],
        ['payload', { payload: null }],
      ] as const
    ) {
      const ref = {
        applicationId: 'legacy-group-event-null-app',
        workspaceId: 'main',
        groupId: `legacy-group-event-null-${suffix}`,
      };
      const event = {
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        groupId: ref.groupId,
        eventId: `legacy-null-${suffix}`,
        eventType: 'group-updated',
        snapshotVersion: 1,
        occurredAtEpochMs: 1_000,
        actor: { principalId: 'alice' },
        ...defect,
      };
      await sql`
        insert into group_state_events (
          application_id, workspace_key, group_id, event_id, event_type,
          snapshot_version, occurred_at_epoch_ms, event_json
        ) values (
          ${ref.applicationId}, ${groupEventWorkspaceKey(ref.workspaceId)},
          ${ref.groupId}, ${event.eventId}, ${event.eventType},
          ${event.snapshotVersion}, ${event.occurredAtEpochMs},
          ${JSON.stringify(event)}
        )
      `;

      await assert.rejects(
        () => repository.listGroupEvents(ref),
        (error) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'group-state-event-repository-invariant-corruption',
      );
    }
  });
});

Deno.test('PSql group event reads validate the decoded event-id slot', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlGroupStateEventRepository(sql);
    const ref = {
      applicationId: 'group-event-slot-app',
      workspaceId: 'main',
      groupId: 'group-event-slot-group',
    };
    const event = createGroupStateEvent('payload-event-id', 1_000, 1, 'group-updated', ref);
    await sql`
      insert into group_state_events (
        application_id, workspace_key, group_id, event_id, event_type,
        snapshot_version, occurred_at_epoch_ms, event_json
      ) values (
        ${ref.applicationId}, ${ref.workspaceId}, ${ref.groupId},
        'physical-event-id', ${event.eventType}, ${event.snapshotVersion},
        ${event.occurredAtEpochMs}, ${JSON.stringify(event)}
      )
    `;

    await assert.rejects(
      () => repository.listGroupEvents(ref),
      (error) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'group-state-event-repository-invariant-corruption',
    );
  });
});

Deno.test('PSql group events enforce the complete event contract and physical columns', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlGroupStateEventRepository(sql);
    const baseRef = {
      applicationId: 'group-event-complete-contract-app',
      workspaceId: 'main',
      groupId: 'group-event-complete-contract-group',
    };
    const baseEvent = createGroupStateEvent(
      'complete-contract-event',
      1_000,
      1,
      'group-updated',
      baseRef,
    );
    const missingActor = structuredClone(baseEvent) as Record<string, unknown>;
    delete missingActor.actor;

    await assert.rejects(
      () => repository.appendGroupEvent(missingActor as unknown as GroupEvent),
      (error) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'group-state-event-repository-invariant-corruption',
    );

    const cases = [
      { suffix: 'missing-actor', payload: missingActor },
      {
        suffix: 'event-type',
        payload: { ...baseEvent, eventType: 'group-archived' },
      },
      {
        suffix: 'snapshot-version',
        payload: { ...baseEvent, snapshotVersion: 2 },
      },
      {
        suffix: 'occurred-at',
        payload: { ...baseEvent, occurredAtEpochMs: 2_000 },
      },
    ];

    for (const testCase of cases) {
      const ref = { ...baseRef, groupId: `${baseRef.groupId}-${testCase.suffix}` };
      const payload = {
        ...testCase.payload,
        groupId: ref.groupId,
        eventId: `${baseEvent.eventId}-${testCase.suffix}`,
      };
      await sql`
        insert into group_state_events (
          application_id, workspace_key, group_id, event_id, event_type,
          snapshot_version, occurred_at_epoch_ms, event_json
        ) values (
          ${ref.applicationId}, ${groupEventWorkspaceKey(ref.workspaceId)},
          ${ref.groupId}, ${payload.eventId}, ${baseEvent.eventType},
          ${baseEvent.snapshotVersion}, ${baseEvent.occurredAtEpochMs},
          ${JSON.stringify(payload)}
        )
      `;

      for (
        const read of [
          () => repository.listGroupEvents(ref),
          () => repository.listRecentGroupEvents(ref),
          () => repository.listGroupEventPage(ref, { limit: 10 }),
        ]
      ) {
        await assert.rejects(read, (error) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'group-state-event-repository-invariant-corruption');
      }
    }
  });
});

Deno.test('ResourceInboxRepository rejects a persisted null attempt count', async () => {
  await withPGliteSql(async (sql) => {
    const inbox = new ResourceInboxRepository(sql);
    const nullAttempts = createResourceEntry('null-attempts', {
      payload: { text: 'mandatory attempts' },
      typeId: 'APP_OUTBOX',
      expiryTs: Temporal.Instant.from('9999-12-31T23:59:59Z'),
    });
    assert.equal(await inbox.writeIfAbsentOrMatch(nullAttempts), 'inserted');
    await sql`
      update resource_inbox
      set ri_attempts = null
      where ri_topic_id = ${nullAttempts.key.topicId}
        and ri_resource_id = ${nullAttempts.key.resourceId}
        and fk_ext_bank_id = ${nullAttempts.key.contextId}
    `;

    await assert.rejects(
      () => inbox.writeIfAbsentOrMatch(nullAttempts),
      ResourceInboxInvariantCorruptionError,
    );
  });
});

Deno.test('ResourceInboxRepository replay is independent of PostgreSQL DateStyle', async () => {
  await withPGliteSql(async (sql) => {
    await sql`set datestyle to 'SQL, DMY'`;

    const inbox = new ResourceInboxRepository(sql);
    const base = createResourceEntry('datestyle-replay', {
      payload: { text: 'datestyle independent' },
      typeId: 'APP_OUTBOX',
      expiryTs: Temporal.Instant.from('9999-12-31T23:59:59.000001Z'),
    });
    const entry = {
      ...base,
      audit: {
        ...base.audit,
        createdTs: Temporal.PlainDateTime.from('2026-06-01T12:00:00.000001'),
      },
    };

    assert.equal(await inbox.writeIfAbsentOrMatch(entry), 'inserted');
    assert.equal(await inbox.writeIfAbsentOrMatch(entry), 'matched');
    await assert.rejects(
      () =>
        inbox.writeIfAbsentOrMatch({
          ...entry,
          audit: {
            ...entry.audit,
            createdTs: Temporal.PlainDateTime.from('2026-06-01T12:00:00.000002'),
          },
        }),
      ResourceInboxInvariantCorruptionError,
    );
    await assert.rejects(
      () =>
        inbox.writeIfAbsentOrMatch({
          ...entry,
          audit: {
            ...entry.audit,
            expiryTs: Temporal.Instant.from('9999-12-31T23:59:59.000002Z'),
          },
        }),
      ResourceInboxInvariantCorruptionError,
    );

    await sql`
      update resource_inbox
      set ri_status = ${EntityStatus.RETRY},
          ri_attempts = 1,
          start_ts = timestamp '2026-06-01 12:01:00.000001',
          end_ts = timestamp '2026-06-01 12:01:01.000001',
          next_ts = timestamp '2026-06-01 12:01:02.000001'
      where ri_topic_id = ${entry.key.topicId}
        and ri_resource_id = ${entry.key.resourceId}
        and fk_ext_bank_id = ${entry.key.contextId}
    `;
    assert.equal(await inbox.writeIfAbsentOrMatch(entry), 'matched');
  });
});

Deno.test('ResourceInboxRepository preserves supported expanded-year rollover', async () => {
  await withPGliteSql(async (sql) => {
    await sql`set datestyle to 'SQL, DMY'`;

    const inbox = new ResourceInboxRepository(sql);
    const base = createResourceEntry('expanded-year-replay', {
      payload: { text: 'expanded year' },
      typeId: 'APP_OUTBOX',
      expiryTs: Temporal.Instant.from('9999-12-31T23:59:59.9999995Z'),
    });
    const entry = {
      ...base,
      audit: {
        ...base.audit,
        createdTs: Temporal.PlainDateTime.from('9999-01-01T00:00:00'),
      },
    };

    assert.equal(await inbox.writeIfAbsentOrMatch(entry), 'inserted');
    assert.equal(await inbox.writeIfAbsentOrMatch(entry), 'matched');
    await assert.rejects(
      () =>
        inbox.writeIfAbsentOrMatch({
          ...entry,
          audit: {
            ...entry.audit,
            expiryTs: Temporal.Instant.from('9999-12-31T23:59:59.9999994Z'),
          },
        }),
      ResourceInboxInvariantCorruptionError,
    );
  });
});

Deno.test('PGlite reclaims stale AppInbox exhaustion as an exact finalization generation', async () => {
  await withPGliteSql(async (sql) => {
    const inbox = new ResourceInboxRepository(sql);
    const queue = new PSqlQueueBox(inbox);
    const exhausted = {
      ...createResourceEntry('pglite-finalization-recovery', {
        payload: { text: 'recover finalization' },
        typeId: 'APP_INBOX',
      }),
      status: EntityStatus.RESERVED,
      dequeueAudit: {
        attempts: 20,
        startTs: Temporal.Instant.from('2020-01-01T00:00:00Z'),
      },
    };
    await inbox.write(exhausted);

    const recovered = await queue.reserveRetryExhaustionFinalizations(
      new Set(['APP_INBOX', 'APP_OUTBOX']),
      {
        processingAttempts: 20,
        maxToReserve: 1,
        staleAfterMs: 300_000,
      },
    );

    assert.equal(recovered.size, 1);
    assert.equal([...recovered.values()][0]?.entry.dequeueAudit.attempts, 21);
    assert.equal([...recovered.values()][0]?.entry.status, EntityStatus.RESERVED);
    assert.equal(
      [...recovered.values()][0]?.selectedDueTs.toString(),
      exhausted.dequeueAudit.startTs.toString(),
    );
    assert.equal(
      (await queue.reserveRetryExhaustionFinalizations(
        new Set(['APP_INBOX']),
        {
          processingAttempts: 20,
          maxToReserve: 1,
          staleAfterMs: 300_000,
        },
      )).size,
      0,
    );
  });
});

Deno.test('ResourceInboxRepository and ResourceInboxResultsRepository run against PGlite SQL adapter', async () => {
  await withPGliteSql(async (sql) => {
    const inbox = new ResourceInboxRepository(sql);
    const results = new ResourceInboxResultsRepository(sql);
    const active = createResourceEntry('active-1', {
      payload: { text: 'active' },
      typeId: 'TYPE_A',
    });
    const expired = createResourceEntry('expired-1', {
      payload: { text: 'expired' },
      typeId: 'TYPE_A',
      expiryTs: PAST_INSTANT,
    });
    const exhausted = {
      ...createResourceEntry('exhausted-ordinary', {
        payload: { text: 'exhausted ordinary' },
        typeId: 'TYPE_EXHAUSTED',
      }),
      dequeueAudit: { attempts: 2 },
    };
    const exhaustedTimeout = {
      ...createResourceEntry('exhausted-timeout', {
        payload: { text: 'exhausted timeout' },
        typeId: 'TYPE_EXHAUSTED_TIMEOUT',
      }),
      status: EntityStatus.RESERVED,
      dequeueAudit: {
        attempts: 2,
        startTs: Temporal.Instant.from('2020-01-01T00:00:00Z'),
      },
    };

    const stored = await inbox.write(active);
    assert.ok(stored.db?.id);
    await inbox.write(expired);
    await inbox.write(exhausted);
    await inbox.write(exhaustedTimeout);
    assert.equal(
      await inbox.isEntriesToLock(
        new Set([exhausted.typeId]),
        new Set([EntityStatus.NEW]),
        2,
      ),
      false,
    );
    assert.equal(
      await inbox.isEntriesToLock(
        new Set([exhausted.typeId]),
        new Set([EntityStatus.NEW]),
      ),
      true,
    );
    assert.equal(
      await inbox.isTimeoutOnReservedEntries(
        new Set([exhaustedTimeout.typeId]),
        Temporal.Duration.from({ seconds: 1 }),
        2,
      ),
      false,
    );
    assert.equal(
      await inbox.isTimeoutOnReservedEntries(
        new Set([exhaustedTimeout.typeId]),
        Temporal.Duration.from({ seconds: 1 }),
      ),
      true,
    );
    const databaseClockTimeout = {
      ...createResourceEntry('database-clock-timeout', {
        payload: { text: 'database clock timeout' },
        typeId: 'TYPE_DATABASE_CLOCK_TIMEOUT',
      }),
      status: EntityStatus.RESERVED,
      dequeueAudit: {
        attempts: 1,
        startTs: Temporal.Instant.from('2020-01-01T00:00:00Z'),
      },
    };
    await inbox.write(databaseClockTimeout);
    await sql`
      update resource_inbox
      set start_ts = (now() - interval '29 seconds') at time zone 'UTC'
      where ri_topic_id = ${databaseClockTimeout.key.topicId}
        and ri_resource_id = ${databaseClockTimeout.key.resourceId}
        and fk_ext_bank_id = ${databaseClockTimeout.key.contextId}
    `;
    const originalDateNow = Date.now;
    Date.now = () => Date.parse('1900-01-01T00:00:00Z');
    try {
      assert.equal(
        (await inbox.begin((transactionInbox) =>
          transactionInbox.findTimedOutReservedEntriesSkipLocked(
            new Set([databaseClockTimeout.typeId]),
            30_000,
            { maxToReserve: 1, maxAttempts: 2 },
          )
        )).size,
        0,
      );
      await sql`
        update resource_inbox
        set start_ts = (now() - interval '31 seconds') at time zone 'UTC'
        where ri_topic_id = ${databaseClockTimeout.key.topicId}
          and ri_resource_id = ${databaseClockTimeout.key.resourceId}
          and fk_ext_bank_id = ${databaseClockTimeout.key.contextId}
      `;
      assert.equal(
        (await inbox.begin((transactionInbox) =>
          transactionInbox.findTimedOutReservedEntriesSkipLocked(
            new Set([databaseClockTimeout.typeId]),
            30_000,
            { maxToReserve: 1, maxAttempts: 2 },
          )
        )).size,
        1,
      );
    } finally {
      Date.now = originalDateNow;
    }

    const immutable = {
      ...createResourceEntry('immutable-replay', {
        payload: { text: 'immutable' },
        typeId: 'APP_OUTBOX',
        expiryTs: Temporal.Instant.from('9999-12-31T23:59:59.000001Z'),
      }),
      audit: {
        ...createResourceEntry('immutable-replay').audit,
        createdTs: Temporal.PlainDateTime.from('2026-06-01T12:00:00.000001'),
        expiryTs: Temporal.Instant.from('9999-12-31T23:59:59.000001Z'),
      },
    };
    assert.equal(await inbox.writeIfAbsentOrMatch(immutable), 'inserted');
    assert.equal(await inbox.writeIfAbsentOrMatch(immutable), 'matched');
    await assert.rejects(
      () =>
        inbox.writeIfAbsentOrMatch({
          ...immutable,
          audit: {
            ...immutable.audit,
            expiryTs: Temporal.Instant.from('9999-12-31T23:59:59.000002Z'),
          },
        }),
      ResourceInboxInvariantCorruptionError,
    );

    const timestampRoundingCases = [
      ['below-half', '0000004', '12:00:00'],
      ['half-even-down', '0000005', '12:00:00'],
      ['half-even-up', '0000015', '12:00:00.000002'],
      ['above-half', '0000006', '12:00:00.000001'],
      ['second-rollover', '9999995', '12:00:01'],
    ] as const;
    for (const [scenario, fraction, expectedTime] of timestampRoundingCases) {
      const creationBase = createResourceEntry(`round-created-${scenario}`, {
        payload: { scenario },
        typeId: 'APP_OUTBOX',
        expiryTs: Temporal.Instant.from('9999-12-31T23:59:59Z'),
      });
      const creationEntry = {
        ...creationBase,
        audit: {
          ...creationBase.audit,
          createdTs: Temporal.PlainDateTime.from(
            `2026-06-01T12:00:00.${fraction}`,
          ),
        },
      };
      assert.equal(await inbox.writeIfAbsentOrMatch(creationEntry), 'inserted');
      const creationRows = await sql<{ created_ts: string }[]>`
        select created_ts::text as created_ts
        from resource_inbox
        where ri_topic_id = ${creationEntry.key.topicId}
          and ri_resource_id = ${creationEntry.key.resourceId}
          and fk_ext_bank_id = ${creationEntry.key.contextId}
      `;
      assert.equal(
        creationRows[0]?.created_ts,
        `2026-06-01 ${expectedTime}`,
      );
      assert.equal(await inbox.writeIfAbsentOrMatch(creationEntry), 'matched');

      const expiryEntry = createResourceEntry(`round-expiry-${scenario}`, {
        payload: { scenario },
        typeId: 'APP_OUTBOX',
        expiryTs: Temporal.Instant.from(`9998-06-01T12:00:00.${fraction}Z`),
      });
      assert.equal(await inbox.writeIfAbsentOrMatch(expiryEntry), 'inserted');
      const expiryRows = await sql<{ expire_ts: string }[]>`
        select expire_ts::text as expire_ts
        from resource_inbox
        where ri_topic_id = ${expiryEntry.key.topicId}
          and ri_resource_id = ${expiryEntry.key.resourceId}
          and fk_ext_bank_id = ${expiryEntry.key.contextId}
      `;
      assert.equal(
        expiryRows[0]?.expire_ts,
        `9998-06-01 ${expectedTime}`,
      );
      assert.equal(await inbox.writeIfAbsentOrMatch(expiryEntry), 'matched');
    }

    assert.equal((await inbox.findByKey(active.key))?.key.resourceId, 'active-1');
    assert.equal(await inbox.findByKey(expired.key), null);
    assert.equal(
      await inbox.isEntriesToLock(
        new Set(['TYPE_A']),
        new Set([EntityStatus.NEW]),
      ),
      true,
    );

    const locked = await inbox.begin((txInbox) =>
      txInbox.findEntriesSkipLocked(
        new Set(['TYPE_A']),
        new Set([EntityStatus.NEW]),
        10,
      )
    );
    assert.equal(locked.size, 1);
    assert.equal([...locked.values()][0].key.resourceId, 'active-1');

    const reserved = await inbox.startProcessingEntity(active);
    assert.equal(reserved.right?.status, EntityStatus.RESERVED);
    assert.equal(reserved.right?.dequeueAudit.attempts, 1);
    assert.equal(await inbox.writeIfAbsentOrMatch(active), 'matched');

    const reservedStartRows = await sql<{ start_ts: string }[]>`
      select start_ts::text as start_ts
      from resource_inbox
      where ri_topic_id = ${active.key.topicId}
        and ri_resource_id = ${active.key.resourceId}
        and fk_ext_bank_id = ${active.key.contextId}
    `;
    const reservedStartText = reservedStartRows[0]?.start_ts;
    assert.ok(reservedStartText);
    const reservedStartTs = Temporal.Instant.from(
      `${reservedStartText.replace(' ', 'T')}Z`,
    );
    assert.equal(
      reserved.right?.dequeueAudit.startTs?.toString(),
      reservedStartTs.toString(),
    );
    const releasedAt = Temporal.Instant.fromEpochMilliseconds(
      Number(reservedStartTs.epochMilliseconds) + 123,
    );
    assert.equal(
      await inbox.releaseReserved(active.key, {
        expectedAttempts: 2,
        releasedAt,
        disposition: { status: EntityStatus.COMPLETED, delayMs: null },
      }),
      null,
    );
    const released = await inbox.releaseReserved(active.key, {
      expectedAttempts: 1,
      releasedAt,
      disposition: { status: EntityStatus.COMPLETED, delayMs: null },
    });
    const releaseRows = await sql<{ end_ts: string }[]>`
      select end_ts::text as end_ts
      from resource_inbox
      where ri_topic_id = ${active.key.topicId}
        and ri_resource_id = ${active.key.resourceId}
        and fk_ext_bank_id = ${active.key.contextId}
    `;
    assert.equal(
      releaseRows[0]?.end_ts,
      releasedAt.toString().replace('T', ' ').replace(/Z$/u, ''),
    );
    assert.equal(released?.dequeueAudit.endTs?.toString(), releasedAt.toString());
    assert.equal(released?.dequeueAudit.nextTs, undefined);
    assert.equal((await inbox.findByKey(active.key))?.status, EntityStatus.COMPLETED);
    assert.equal(await inbox.writeIfAbsentOrMatch(active), 'matched');

    const batchFirst = createResourceEntry('release-batch-first', {
      payload: { text: 'first' },
      typeId: 'TYPE_A',
    });
    const batchSecond = createResourceEntry('release-batch-second', {
      payload: { text: 'second' },
      typeId: 'TYPE_A',
    });
    await inbox.write(batchFirst);
    await inbox.write(batchSecond);
    const firstReservation = await inbox.startProcessingEntity(batchFirst);
    const secondReservation = await inbox.startProcessingEntity(batchSecond);
    assert.ok(firstReservation.right);
    assert.ok(secondReservation.right);
    const queueBox = new PSqlQueueBox(inbox);
    await assert.rejects(
      () =>
        queueBox.releaseEntries([
          firstReservation.right!,
          {
            ...secondReservation.right!,
            dequeueAudit: {
              ...secondReservation.right!.dequeueAudit,
              attempts: 0,
            },
          },
        ], { status: EntityStatus.COMPLETED, delayMs: null }),
      (error) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'resource-inbox-lost-reservation',
    );
    assert.equal((await inbox.findByKey(batchFirst.key))?.status, EntityStatus.RESERVED);
    assert.equal((await inbox.findByKey(batchSecond.key))?.status, EntityStatus.RESERVED);
    assert.equal(await inbox.deleteExpired(), 1);

    const resultEntry = createResourceEntry('result-1', {
      topicId: 'result-topic',
      typeId: 'RESULT',
      status: EntityStatus.COMPLETED,
      payload: { text: 'result' },
    });
    const activeResult = await results.writeIfAbsentOrReplaceExpired(resultEntry);
    assert.equal(activeResult.key.resourceId, 'result-1');

    const replacedResult = await results.replace(
      createResourceEntry('result-1', {
        topicId: 'result-topic',
        typeId: 'RESULT',
        status: EntityStatus.FAILED,
        payload: { text: 'result-updated' },
      }),
    );
    assert.equal(replacedResult.status, EntityStatus.FAILED);
    assert.deepEqual(JSON.parse(replacedResult.resource), { text: 'result-updated' });

    await results.replace(
      createResourceEntry('result-expired', {
        topicId: 'result-topic',
        typeId: 'RESULT',
        status: EntityStatus.COMPLETED,
        expiryTs: PAST_INSTANT,
      }),
    );
    assert.equal(await results.deleteExpired(), 1);
    assert.equal(await inbox.deleteByKey(active.key), true);
  });
});

Deno.test('Coalesced APP_OUTBOX RTC topology work fits the durable resource inbox key columns', async () => {
  await withPGliteSql(async (sql) => {
    const queue = new PSqlQueueBox(new ResourceInboxRepository(sql));
    const service = new CoalescedAppOutboxWorkService(
      new OutboxQueueReader(queue),
      'rallar-server-instance-with-a-long-identity',
      () => 500,
    );
    const groupId = 'rallar-bb-group-chromium-w0-configured-live-distributed-run-1234567890';
    const overlayId = JSON.stringify(['rallar-server', 'default', groupId]);
    const contextId = `rallar-server:default:${groupId}`;

    const result = await service.enqueue({
      type: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
      topicId: 'app-outbox.rtc-topology',
      resourceId: overlayId,
      contextId,
      data: { overlayId },
    });
    const updated = await service.enqueue({
      type: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
      topicId: 'app-outbox.rtc-topology',
      resourceId: overlayId,
      contextId,
      data: { overlayId, revision: 2 },
      reason: 'rtt',
    });
    const stored = await queue.getItem(updated.entry.key);
    const rowCount = await sql<{ count: string }[]>`
      select count(*) as count
      from resource_inbox
      where fk_ext_bank_id = ${updated.entry.key.contextId}
        and ri_resource_id = ${updated.entry.key.resourceId}
        and ri_topic_id = ${updated.entry.key.topicId}
    `;

    assert.ok(stored);
    assert.equal(stored.typeId, 'APP_OUTBOX');
    assert.equal(result.action, 'inserted');
    assert.equal(updated.action, 'updated');
    assert.equal(Number(rowCount[0].count), 1);
    assert.ok(stored.key.topicId.length <= 36);
    assert.ok(stored.key.resourceId.length <= 36);
    assert.ok(stored.key.contextId.length <= 35);
    assert.ok(stored.audit.createdBy.length <= 16);
    assert.deepEqual(service.readEnvelope(stored), updated.envelope);
    assert.equal(updated.envelope.resourceId, overlayId);
    assert.equal(updated.envelope.contextId, contextId);
    assert.equal(updated.envelope.data.revision, 2);
  });
});

Deno.test('transaction-bound APP_OUTBOX coalescing fences generation and reserved work', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new ResourceInboxRepository(sql);
    const queue = new PSqlQueueBox(repository);
    const service = new CoalescedAppOutboxWorkService(
      new OutboxQueueReader(queue),
      'rallar-server',
      () => 500,
    );
    const first = (await service.enqueue({
      type: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
      topicId: 'app-outbox.rtc-topology',
      resourceId: 'transactional-overlay',
      contextId: 'transactional-room',
      data: { overlayId: 'transactional-overlay', revision: 1 },
    })).entry;
    const second = advanceCoalescedGeneration(first, 2);
    const successor = createResourceEntry('transactional-successor', {
      topicId: first.key.topicId,
      contextId: first.key.contextId,
      typeId: first.typeId,
      payload: { generation: 2, kind: 'successor' },
    });

    const statusFirst = (await service.enqueue({
      type: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
      topicId: 'app-outbox.rtc-topology',
      resourceId: 'transactional-status-fence',
      contextId: 'transactional-room',
      data: { overlayId: 'transactional-status-fence', revision: 1 },
    })).entry;
    await repository.writeIfAbsentOrMatch(statusFirst);
    await sql`
      update resource_inbox
      set ri_status = ${EntityStatus.RETRY}
      where ri_topic_id = ${statusFirst.key.topicId}
        and ri_resource_id = ${statusFirst.key.resourceId}
        and fk_ext_bank_id = ${statusFirst.key.contextId}
    `;
    const statusMismatch = await sql.begin(async (transaction) =>
      await new ResourceInboxRepository(transaction).replacePendingIfMatch(
        statusFirst,
        advanceCoalescedGeneration(statusFirst, 2),
        1,
      )
    );
    assert.equal(statusMismatch, null);
    assert.equal(
      (await repository.findAnyByKey(statusFirst.key))?.status,
      EntityStatus.RETRY,
    );

    const updated = await sql.begin(async (transaction) =>
      await service.write(transaction, {
        expectedEntry: first,
        entry: second,
        successorEntry: successor,
      })
    );
    assert.equal(updated.action, 'updated');
    assert.equal((await repository.findByKey(first.key))?.resource, second.resource);

    const reserved = await queue.reserveEntries(
      new Set([first.typeId]),
      new Set([EntityStatus.NEW]),
      { maxToReserve: 1, maxAttempts: 20 },
    );
    assert.equal(reserved.size, 1);
    const observedReserved = [...reserved.values()][0];
    assert.ok(observedReserved);
    const third = advanceCoalescedGeneration(second, 3);
    const blocked = await sql.begin(async (transaction) =>
      await service.write(transaction, {
        expectedEntry: observedReserved,
        entry: third,
        successorEntry: successor,
      })
    );

    assert.equal(blocked.action, 'successor');
    assert.equal(blocked.blockedByReserved, true);
    assert.equal((await repository.findAnyByKey(first.key))?.resource, second.resource);
    assert.equal((await repository.findAnyByKey(first.key))?.status, EntityStatus.RESERVED);
    assert.equal((await repository.findByKey(successor.key))?.resource, successor.resource);

    const replay = await sql.begin(async (transaction) =>
      await service.write(transaction, {
        expectedEntry: observedReserved,
        entry: third,
        successorEntry: successor,
      })
    );
    assert.equal(replay.action, 'successor');
    assert.equal((await repository.findAnyByKey(first.key))?.resource, second.resource);
    assert.equal((await repository.findAnyByKey(first.key))?.status, EntityStatus.RESERVED);
    assert.equal((await repository.findByKey(successor.key))?.resource, successor.resource);

    await assert.rejects(
      async () => {
        await sql.begin(async (transaction) =>
          await service.write(transaction, {
            expectedEntry: observedReserved,
            entry: third,
            successorEntry: {
              ...successor,
              resource: JSON.stringify({ different: true }),
            },
          })
        );
      },
      (error) =>
        error instanceof ResourceInboxInvariantCorruptionError &&
        error.code === 'resource-inbox-invariant-corruption',
    );
  });
});

Deno.test('PSqlAppDataRepository runs against PGlite SQL adapter', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlAppDataRepository(sql);

    await repository.upsert({
      namespace: 'app-smoke',
      storeName: 'store',
      key: 'alpha',
      value: { count: 1 },
      schemaVersion: 1,
      expireAtTimestamp: FUTURE_MS,
    });
    await repository.upsert({
      namespace: 'app-smoke',
      storeName: 'store',
      key: 'alpha',
      value: { count: 2 },
      schemaVersion: 2,
      expireAtTimestamp: FUTURE_MS,
    });
    await repository.upsert({
      namespace: 'app-smoke',
      storeName: 'store',
      key: 'beta',
      value: { count: 3 },
      schemaVersion: 1,
      expireAtTimestamp: FUTURE_MS,
    });
    await repository.upsert({
      namespace: 'app-smoke',
      storeName: 'store',
      key: 'expired',
      value: { count: 4 },
      schemaVersion: 1,
      expireAtTimestamp: PAST_MS,
    });

    const alpha = await repository.findEntry('app-smoke', 'store', 'alpha');
    assert.deepEqual(alpha?.value, { count: 2 });
    assert.equal(alpha?.schemaVersion, 2);
    assert.equal(alpha?.revision, 1);

    const prefixed = await repository.findEntries('app-smoke', 'store', 'a');
    assert.deepEqual(prefixed.map((entry) => entry.key), ['alpha']);
    const firstPage = await repository.findEntriesPage('app-smoke', 'store', {
      limit: 1,
    });
    const secondPage = await repository.findEntriesPage('app-smoke', 'store', {
      afterKey: firstPage.at(-1)?.key,
      limit: 10,
    });
    const prefixedPage = await repository.findEntriesPage('app-smoke', 'store', {
      keyPrefix: 'a',
      limit: 10,
    });

    assert.deepEqual(firstPage.map((entry) => entry.key), ['alpha']);
    assert.deepEqual(secondPage.map((entry) => entry.key), ['beta', 'expired']);
    assert.deepEqual(prefixedPage.map((entry) => entry.key), ['alpha']);

    assert.equal(await repository.deleteExpired('app-smoke', 'store'), 1);
    assert.equal(await repository.deleteByKey('app-smoke', 'store', 'beta'), true);
    assert.equal(await repository.findEntry('app-smoke', 'store', 'beta'), undefined);
  });
});

Deno.test('PSqlCrdtLogRepository runs against PGlite SQL adapter', async () => {
  await withPGliteSql(async (sql) => {
    const repository = new PSqlCrdtLogRepository(sql, {
      now: () => 2_000,
      serverId: 'server-a',
    });
    const first = createCrdtUpdate('update-1');
    const second = createCrdtUpdate('update-2');

    await assert.rejects(
      repository.updateDocumentLifecycle({
        document: CRDT_DOCUMENT_REF,
        lifecycle: 'destroy',
      } as never),
      { message: 'Unsupported CRDT lifecycle: destroy' },
    );
    assert.equal(await repository.readDocumentMetadata(CRDT_DOCUMENT_REF), undefined);

    const accepted = await repository.append(toCrdtAppendInput(first));
    const duplicate = await repository.append(toCrdtAppendInput(first));
    await repository.append(toCrdtAppendInput(second));
    const storedBytes = await readCrdtStoredUpdateBytes(sql, CRDT_DOCUMENT_REF);

    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.status === 'accepted' && accepted.append.appendSequence, 1);
    assert.equal(duplicate.status, 'duplicate');
    assert.equal(
      duplicate.status === 'duplicate' && duplicate.append.appendSequence,
      1,
    );
    assert.equal(
      storedBytes,
      byteLengthOfSerializedJson(JSON.stringify(first)) +
        byteLengthOfSerializedJson(JSON.stringify(second)),
    );

    const page = await repository.listAfter({
      document: CRDT_DOCUMENT_REF,
      limit: 1,
    });
    const nextPage = await repository.listAfter({
      document: CRDT_DOCUMENT_REF,
      afterCursor: page.nextCursor,
      limit: 10,
    });

    assert.deepEqual(page.records.map((record) => record.update.updateId), [
      'update-1',
    ]);
    assert.equal(page.nextCursor, 'seq:1');
    assert.equal(page.hasMore, true);
    assert.deepEqual(nextPage.records.map((record) => record.update.updateId), [
      'update-2',
    ]);

    const snapshot: RallarCrdtSnapshotEnvelope = {
      protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
      document: CRDT_DOCUMENT_REF,
      snapshotId: 'snapshot-1',
      schemaVersion: 1,
      createdAtEpochMs: 2_500,
      maxLamport: 2,
      includedUpdateIds: ['update-1', 'update-2'],
      value: {
        title: 'Title update-2',
      },
      metadata: {
        updateCount: 2,
      },
    };
    await repository.writeSnapshot({
      snapshot,
      appendSequence: 2,
    });
    assert.deepEqual(await repository.readSnapshot(CRDT_DOCUMENT_REF), snapshot);

    const list = await repository.listDocuments({
      documentType: 'checklist',
    });
    const debugBundle = await repository.exportDebugBundle(CRDT_DOCUMENT_REF, {
      reason: 'pglite-test',
    });
    const backup = await repository.exportBackupBundle(CRDT_DOCUMENT_REF);
    const integrity = await repository.verifyIntegrity(CRDT_DOCUMENT_REF);

    assert.equal(list.documents.length, 1);
    assert.equal(debugBundle.integrity.updateCount, 2);
    assert.equal(backup?.integrity.updateCount, 2);
    assert.equal(integrity.valid, true);

    await withPGliteSql(async (restoreSql) => {
      const restoreRepository = new PSqlCrdtLogRepository(restoreSql, {
        now: () => 4_000,
        serverId: 'restore-server',
      });
      const restored = await restoreRepository.restoreBackupBundle(backup!);

      assert.equal(restored.restoredUpdateCount, 2);
      assert.equal(restored.firstAppendSequence, 1);
      assert.equal(restored.lastAppendSequence, 2);
      assert.equal(
        (await restoreRepository.verifyIntegrity(CRDT_DOCUMENT_REF)).valid,
        true,
      );
    });

    await repository.rebuildProjection(CRDT_DOCUMENT_REF, 'checklist-summary');
    assert.deepEqual(
      (await repository.readDocumentMetadata(CRDT_DOCUMENT_REF))?.projectionIds,
      ['checklist-summary'],
    );

    await repository.updateDocumentLifecycle({
      document: CRDT_DOCUMENT_REF,
      lifecycle: 'archived',
      changedAtEpochMs: 3_000,
    });
    const rejected = await repository.append(
      toCrdtAppendInput(createCrdtUpdate('update-3')),
    );

    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.status === 'rejected' && rejected.code, 'document-archived');
  });

  await withPGliteSql(async (sql) => {
    const disabledRepository = new PSqlCrdtLogRepository(sql, {
      now: () => 5_000,
      policies: [
        {
          documentType: 'checklist',
          rollout: 'disabled',
          flags: {
            killSwitchReason: 'maintenance',
          },
        },
      ],
    });
    const disabled = await disabledRepository.append(
      toCrdtAppendInput(createCrdtUpdate('disabled-1')),
    );

    assert.equal(disabled.status, 'rejected');
    assert.equal(disabled.status === 'rejected' && disabled.code, 'feature-disabled');
  });

  await withPGliteSql(async (sql) => {
    const repository = new PSqlCrdtLogRepository(sql, {
      now: () => 6_000,
    });
    await repository.updateDocumentLifecycle({
      document: CRDT_DOCUMENT_REF,
      lifecycle: 'active',
      quota: {
        maxUpdatesPerMinutePerActor: 1,
      },
    });

    assert.equal(
      (await repository.append(toCrdtAppendInput(createCrdtUpdate('rate-1'))))
        .status,
      'accepted',
    );
    const rateLimited = await repository.append(
      toCrdtAppendInput(createCrdtUpdate('rate-2')),
    );
    assert.equal(rateLimited.status, 'rejected');
    assert.equal(rateLimited.status === 'rejected' && rateLimited.code, 'rate-limited');

    await repository.updateDocumentLifecycle({
      document: CRDT_DOCUMENT_REF,
      lifecycle: 'quarantined',
    });
    const quarantined = await repository.append(
      toCrdtAppendInput(createCrdtUpdate('rate-3')),
    );
    assert.equal(quarantined.status, 'rejected');
    assert.equal(
      quarantined.status === 'rejected' && quarantined.code,
      'document-quarantined',
    );
  });
});

function submitPGliteTopologyCommand(
  appGroup: AppGroupInboxService,
  authority: IssuedAuthSession,
  command: TopologyAppInboxCommand,
) {
  const type = command.operation === 'putConfig'
    ? AppInboxType.TOPOLOGY_CONFIG_PUT
    : command.operation === 'deleteConfig'
    ? AppInboxType.TOPOLOGY_CONFIG_DELETE
    : command.operation === 'putOverride'
    ? AppInboxType.TOPOLOGY_OVERRIDE_PUT
    : command.operation === 'deleteOverride'
    ? AppInboxType.TOPOLOGY_OVERRIDE_DELETE
    : AppInboxType.TOPOLOGY_RECONFIGURE;
  return appGroup.processAuthenticatedEntryUntilCompletion({
    type,
    resourceId: command.requestId,
    contextId: [
      command.groupRef.applicationId,
      command.groupRef.workspaceId,
      command.groupRef.groupId,
    ].map(encodeURIComponent).join(':'),
    senderId: command.actor.principalId,
    data: command,
  }, authority);
}

function topologyConfigCommand(
  groupRef: GroupRef,
  requestId: string,
  topologyKind: 'tree' | 'mesh',
): GroupTopologyConfigMutationCommand {
  return {
    operation: 'putConfig',
    aggregateRef: groupRef,
    commandId: requestId,
    requestId,
    input: {
      config: { topologyKind },
      updatedByPrincipalId: 'owner',
      ttlMs: null,
      expiresAtEpochMs: null,
    },
  };
}

function topologyOverrideCommand(
  groupRef: GroupRef,
  requestId: string,
  topologyKind: 'tree' | 'mesh',
): GroupTopologyConfigMutationCommand {
  return {
    operation: 'putOverride',
    aggregateRef: groupRef,
    commandId: requestId,
    requestId,
    input: {
      config: { topologyKind },
      updatedByPrincipalId: 'owner',
      ttlMs: 60_000,
      expiresAtEpochMs: null,
    },
  };
}

async function createPGliteTopologyWorkFixture(
  sql: PGliteSql,
  commandId: string,
) {
  const nowEpochMs = Date.parse('2026-07-23T00:00:00.000Z');
  const groupRef = {
    applicationId: commandId,
    workspaceId: 'atomic-work',
    groupId: 'room',
  };
  const groupSnapshot = topologyGroupSnapshot(groupRef);
  const runtimeRepository = new PSqlRuntimeStateRepository(sql);
  const topologySnapshotRepository = new RtcTopologySnapshotRepository(
    runtimeRepository,
  );
  const topologyManagement = new GroupTopologyManagementService({
    findGroupSnapshotByRef: () => groupSnapshot,
    topologyService: new RallarRtcTopologyService({ now: () => nowEpochMs }),
    topologySnapshotRepository,
    processRttReader: () => [],
    now: () => nowEpochMs,
  });
  const executionRepository = new RtcTopologyExecutionRepository(
    runtimeRepository,
    60_000,
    () => nowEpochMs,
  );
  const resourceInbox = new ResourceInboxRepository(sql);
  const workEntry = await sql.begin((transaction) =>
    writeRtcTopologyOutbox(transaction, {
      commandId,
      resourceId: `${commandId}:rtc-topology-recompute:explicit`,
      aggregateRef: groupRef,
      acceptedCausalRevision: groupSnapshot.causalRevision,
      groupSnapshot,
      effectKind: 'rtc-topology-recompute',
      payloadKind: 'group-revision',
      createdAtEpochMs: nowEpochMs,
      expireAtEpochMs: FUTURE_MS,
      senderId: 'owner',
      requestOptions: toCanonicalGroupTopologyConfigPatch({}),
      publish: true,
    })
  );
  await sql`
    update resource_inbox
    set ri_status = 'RESERVED', ri_attempts = 1,
        start_ts = now() at time zone 'UTC', end_ts = null, next_ts = null
    where ri_topic_id = ${workEntry.key.topicId}
      and ri_resource_id = ${workEntry.key.resourceId}
      and fk_ext_bank_id = ${workEntry.key.contextId}
  `;
  const reserved = await resourceInbox.findAnyByKey(workEntry.key);
  assert.ok(reserved);
  const message = JSON.parse(reserved.resource) as ALMessage;
  const envelope = JSON.parse(message.payload.resource) as {
    topicId: string;
    resourceId: string;
    contextId: string;
  };
  const workId = [
    envelope.topicId,
    envelope.contextId,
    envelope.resourceId,
    0,
  ].join(':');
  const authority = await topologyManagement.readTopologyPlanningAuthority(
    groupRef,
    {},
    groupSnapshot,
  );
  const topology = topologyManagement.computeTopologyFromAuthority(
    authority,
    undefined,
  ).snapshot;
  const expiresAtEpochMs = executionRepository.publicationExpireAtTimestamp();
  const publication = {
    publicationId: toRtcTopologyPublicationId({
      workId,
      sourceGroupStateCausalRevision: topology.sourceGroupStateCausalRevision,
      overlayVersion: topology.version,
    }),
    workId,
    groupRef,
    sourceGroupStateCausalRevision: topology.sourceGroupStateCausalRevision,
    overlayVersion: topology.version,
    targetGroupSnapshotVersion: groupSnapshot.group.snapshotVersion,
    recipientSessionIds: topology.activeSessionIds,
    message: materializeRtcOverlayTopologyBroadcastMessage(
      groupSnapshot,
      topology,
      { workId, createdAtEpochMs: nowEpochMs, expiresAtEpochMs },
    ),
    createdAtEpochMs: nowEpochMs,
  };
  const publicationEntry = computeRtcTopologyPublicationOutbox(publication);
  const queue = new PSqlQueueBox(resourceInbox);
  const runtime = createRtcTopologyOutboxPublisher({
    outboxQueueReader: new OutboxQueueReader(queue),
    senderId: 'pglite-topology-worker',
    now: () => nowEpochMs,
  });
  const handler = createRtcTopologyWorkHandler({
    runtime,
    database: sql,
    topologyManagement,
    executionRepository,
    publicationFanout: {
      readiness: Promise.resolve(),
      publish: () => Promise.resolve(0),
      deliverLocal: () => 0,
    },
  });
  return {
    groupRef,
    workId,
    topology,
    publication,
    publicationEntry,
    resourceInbox,
    executionRepository,
    workEntry,
    reserved,
    message,
    handler,
  };
}

function topologyGroupSnapshot(groupRef: GroupRef): GroupSnapshot {
  return {
    stateRevision: 1,
    causalRevision: { groupRevision: 1, presenceRevision: 0 },
    group: {
      ...groupFixture(groupRef, 'Topology room'),
      ownerPrincipalId: 'owner',
    },
    members: [{
      ...groupRef,
      principalId: 'owner',
      role: 'owner',
      status: 'active',
      joined: canonicalAuditStamp(1),
      updated: canonicalAuditStamp(1),
      left: null,
      removed: null,
      banned: null,
      invitedByPrincipalId: null,
      invitationExpiresAtEpochMs: null,
    }],
    activeSessions: [],
    memberCount: 1,
    onlineMemberCount: 0,
  };
}

function topologyGroupSnapshotWithSessions(
  groupRef: GroupRef,
  ownerSessionId: string,
  peerSessionId: string,
  nowEpochMs: number,
): GroupSnapshot {
  const base = topologyGroupSnapshot(groupRef);
  const peer = {
    ...base.members[0],
    principalId: 'peer',
    role: 'member' as const,
  };
  const session = (sessionId: string, principalId: string) => ({
    ...groupRef,
    sessionId,
    principalId,
    generationId: `generation-${sessionId}`,
    generationVersion: nowEpochMs - 1_000,
    connectedAtEpochMs: nowEpochMs - 1_000,
    lastHeartbeatAtEpochMs: nowEpochMs,
    expiresAtEpochMs: nowEpochMs + 60_000,
    status: 'active' as const,
    disconnectedAtEpochMs: null,
    disconnectReason: null,
  });
  return {
    stateRevision: 2,
    causalRevision: { groupRevision: 1, presenceRevision: 1 },
    group: {
      ...base.group,
      activeMemberCount: 2,
      snapshotVersion: 2,
      rosterVersion: 2,
      presenceVersion: 1,
    },
    members: [base.members[0], peer],
    activeSessions: [
      session(ownerSessionId, 'owner'),
      session(peerSessionId, 'peer'),
    ],
    memberCount: 2,
    onlineMemberCount: 2,
  };
}

function topologyGroupSnapshotWithSessionIds(
  groupRef: GroupRef,
  sessionIds: readonly string[],
  nowEpochMs: number,
): GroupSnapshot {
  const base = topologyGroupSnapshot(groupRef);
  const members = sessionIds.map((sessionId, index) => ({
    ...base.members[0],
    principalId: index === 0 ? 'owner' : `member-${index}`,
    role: index === 0 ? 'owner' as const : 'member' as const,
  }));
  const activeSessions = sessionIds.map((sessionId, index) => ({
    ...groupRef,
    sessionId,
    principalId: members[index]!.principalId,
    generationId: `generation-${sessionId}`,
    generationVersion: nowEpochMs - 100,
    connectedAtEpochMs: nowEpochMs - 100,
    lastHeartbeatAtEpochMs: nowEpochMs,
    expiresAtEpochMs: nowEpochMs + 60_000,
    status: 'active' as const,
    disconnectedAtEpochMs: null,
    disconnectReason: null,
  }));
  return {
    ...base,
    stateRevision: 2,
    causalRevision: { groupRevision: 1, presenceRevision: 1 },
    group: {
      ...base.group,
      activeMemberCount: members.length,
      snapshotVersion: 2,
      rosterVersion: 2,
      presenceVersion: 1,
    },
    members,
    activeSessions,
    memberCount: members.length,
    onlineMemberCount: members.length,
  };
}

function activeTopologySnapshot(
  groupRef: GroupRef,
  sourceGroupStateCausalRevision: GroupSnapshot['causalRevision'],
  activeSessionIds: readonly string[],
  nextHopsBySessionId: Readonly<Record<string, readonly string[]>>,
): RallarOverlayTopologySnapshot {
  return {
    sourceGroupStateCausalRevision,
    state: 'active',
    overlayId: toScopedOverlayId(groupRef),
    groupRef,
    name: 'Topology room',
    topology: 'tree',
    activeSessionIds,
    nextHopsBySessionId,
    degreeLimit: Math.max(
      1,
      ...Object.values(nextHopsBySessionId).map((peers) => peers.length),
    ),
    version: 0,
    createdByClientId: 'owner',
    createdAtEpochMs: 1,
    updatedAtEpochMs: 1,
  };
}

async function createPGliteRemovalPlanningScenario(
  sql: PGliteSql,
  input: Readonly<{
    name: string;
    status: 'active' | 'archived';
    expiresAtEpochMs: number | null;
    updatedAtEpochMs: number;
  }>,
) {
  const nowEpochMs = 1_000;
  const groupRef = {
    applicationId: `pglite-removal-${input.name}`,
    workspaceId: 'planning',
    groupId: 'room',
  };
  const base = topologyGroupSnapshot(groupRef);
  const currentGroup: Group = input.status === 'archived'
    ? {
      ...base.group,
      status: 'archived',
      expiresAtEpochMs: input.expiresAtEpochMs,
      updated: canonicalAuditStamp(input.updatedAtEpochMs),
      archived: canonicalAuditStamp(input.updatedAtEpochMs),
      deleted: null,
    }
    : {
      ...base.group,
      status: 'active',
      expiresAtEpochMs: input.expiresAtEpochMs,
      updated: canonicalAuditStamp(input.updatedAtEpochMs),
      archived: null,
      deleted: null,
    };
  const current: GroupSnapshot = {
    ...base,
    group: currentGroup,
  };
  const runtime = new PSqlRuntimeStateRepository(sql);
  const groups = new GroupStateRepository(runtime);
  assert.equal((await groups.insertGroup(current.group)).status, 'applied');
  for (const member of current.members) await groups.putMember(member);
  const durable = await groups.readSnapshot(groupRef);
  assert.ok(durable);
  const staleTerminal: GroupSnapshot = {
    ...current,
    stateRevision: 0,
    causalRevision: { groupRevision: 0, presenceRevision: 0 },
    group: {
      ...current.group,
      status: 'archived',
      updated: canonicalAuditStamp(10),
      archived: canonicalAuditStamp(10),
      expiresAtEpochMs: null,
      deleted: null,
    },
  };
  const snapshots = new RtcTopologySnapshotRepository(runtime);
  const previous = activeTopologySnapshot(
    groupRef,
    { groupRevision: 0, presenceRevision: 0 },
    [],
    {},
  );
  assert.equal(await snapshots.observeSnapshot(previous), 'inserted');
  const service = new GroupTopologyManagementService({
    findGroupSnapshotByRef: (ref) => groups.readSnapshot(ref),
    groupStateRepository: groups,
    configRepository: new GroupTopologyConfigRepository(runtime),
    topologyService: new RallarRtcTopologyService({ now: () => nowEpochMs }),
    topologySnapshotRepository: snapshots,
    processRttReader: () => [],
    now: () => nowEpochMs,
  });
  const authority = await service.readTopologyPlanningAuthority(
    groupRef,
    {},
    staleTerminal,
  );
  assert.deepEqual(authority.group, durable);
  return { authority, previous, service };
}

async function withPGliteSql(
  fn: (sql: PGliteSql) => Promise<void>,
): Promise<void> {
  const sql = createApiV1SqlClient({ sqlBackend: 'pglite-memory' }) as PGliteSql;
  try {
    await fn(sql);
  } finally {
    await sql.close();
  }
}

async function readPGliteAppInboxFailure(
  sql: PGliteSql,
  resourceId: string,
  resource: unknown,
) {
  const inbox = new ResourceInboxRepository(sql);
  const results = new ResourceInboxResultsRepository(sql);
  const service = new AppInboxService(
    new InboxQueueReader(new PSqlQueueBox(inbox)),
    inbox,
    results,
    sql,
    'pglite-legacy-failure-reader',
    undefined,
    undefined,
    {
      waitMaxElapsedMsecs: 5_000,
      waitRetryIntervalMsecs: 1,
      waitMaxRetryIntervalMsecs: 2,
      waitJitterRatio: 0,
    },
  );
  const enqueue = {
    type: AppInboxType.GROUP_CREATE,
    resourceId,
    contextId: 'legacy-context',
    data: { requestId: resourceId },
  } as const;
  const typedPending = service.processEntryUntilCompletionResult(enqueue);
  await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
  const key = {
    topicId: 'app-inbox.group-state',
    resourceId,
    contextId: enqueue.contextId,
  };
  const entry = await inbox.findByKey(key);
  assert.ok(entry);
  const reserved = await inbox.startProcessingEntity(entry);
  assert.ok(reserved.right);
  await results.replace(
    toResourceEntryWithUpdatedResource(
      reserved.right,
      EntityStatus.FAILED,
      resource,
    ),
  );
  assert.ok(
    await inbox.finishReserved(
      key,
      reserved.right.dequeueAudit.attempts,
      EntityStatus.FAILED,
      new Date(),
    ),
  );
  const typed = await typedPending;
  const legacy = await service.processEntryUntilCompletion(enqueue);
  return { typed, legacy };
}

async function waitForPGliteQueueRow(
  sql: PGliteSql,
  typeId: string,
  status: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await sql<{ count: string }[]>`
      select count(*) as count
      from resource_inbox
      where ri_type_id = ${typeId} and ri_status = ${status}
    `;
    if (Number(row?.count ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${typeId} ${status} queue row`);
}

async function applyPGliteGroupMutation(
  sql: PGliteSql,
  service: GroupStateService,
  descriptor: GroupMutationDescriptor,
  authority: IssuedAuthSession,
): Promise<void> {
  await applyPreparedPGliteGroupMutation(
    sql,
    service,
    await service.prepareMutation(descriptor, authority),
  );
}

async function applyPreparedPGliteGroupMutation(
  sql: PGliteSql,
  service: GroupStateService,
  preparation: GroupMutationPreparation,
): Promise<void> {
  const command = {
    ...preparation,
    facts: { ...preparation.facts, attemptCount: 1 },
  };
  const read = await service.read(command);
  const computed = service.compute(command, read);
  service.validate(command, read, computed);
  if (computed.outcome !== 'write') return;
  await sql.begin(async (transaction) => {
    await service.write(transaction, computed);
  });
}

async function readCrdtStoredUpdateBytes(
  sql: PGliteSql,
  document: RallarCrdtDocumentRef,
): Promise<number> {
  const rows = await sql<{ stored_update_bytes: string | number }[]>`
        select stored_update_bytes
        from crdt_documents
        where document_key = ${toRallarCrdtDocumentKey(document)}
    `;
  return Number(rows[0]?.stored_update_bytes ?? 0);
}

function byteLengthOfSerializedJson(serialized: string): number {
  return new TextEncoder().encode(serialized).byteLength;
}

function createClientStateEvent(
  eventId: string,
  occurredAtEpochMs: number,
  snapshotVersion: number,
  eventType: ClientEvent['eventType'] = 'session-connected',
  overrides: Partial<ClientEvent> = {},
): ClientEvent {
  return {
    applicationId: 'rallar-test',
    workspaceId: 'main',
    principalId: 'principal-1',
    eventId,
    eventType,
    snapshotVersion,
    occurredAtEpochMs,
    clientInstanceId: 'instance-1',
    sessionId: 'session-1',
    actor: {
      kind: 'service',
      serviceId: 'pglite-test',
    },
    reason: null,
    traceId: null,
    requestId: null,
    payload: {},
    ...overrides,
  };
}

function createGroupStateEvent(
  eventId: string,
  occurredAtEpochMs: number,
  snapshotVersion: number,
  eventType: GroupEvent['eventType'] = 'session-connected',
  overrides: Partial<GroupEvent> = {},
): GroupEvent {
  return {
    applicationId: 'rallar-test',
    workspaceId: 'main',
    groupId: 'room-1',
    eventId,
    eventType,
    snapshotVersion,
    causalRevision: {
      groupRevision: snapshotVersion,
      presenceRevision: 0,
    },
    occurredAtEpochMs,
    actor: {
      kind: 'service',
      serviceId: 'pglite-test',
    },
    reason: null,
    traceId: null,
    requestId: null,
    payload: {},
    ...overrides,
  };
}

function canonicalAuditStamp(atEpochMs: number): AuditStamp {
  return {
    atEpochMs,
    actor: { kind: 'service', serviceId: 'pglite-test' },
    reason: null,
    traceId: null,
    requestId: null,
  };
}

const CRDT_ROOM_REF = {
  applicationId: 'rallar-test',
  workspaceId: 'main',
  groupId: 'room-1',
};

const CRDT_DOCUMENT_REF: RallarCrdtDocumentRef = {
  applicationId: 'rallar-test',
  workspaceId: 'main',
  scope: 'room',
  documentType: 'checklist',
  documentId: 'room-1',
  roomRef: CRDT_ROOM_REF,
};

function toCrdtAppendInput(update: RallarCrdtUpdateEnvelope) {
  return {
    update,
    trusted: {
      authorizationScope: 'room' as const,
      principalId: 'principal-a',
      sessionId: 'session-a',
    },
  };
}

function createCrdtUpdate(updateId: string): RallarCrdtUpdateEnvelope {
  return {
    protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
    document: CRDT_DOCUMENT_REF,
    updateId,
    replicaId: 'replica-a',
    lamport: Number(updateId.split('-').at(-1) ?? 1),
    parents: [],
    schemaVersion: 1,
    operationVersion: RALLAR_CRDT_OPERATION_VERSION,
    createdAtEpochMs: 1_000,
    payload: createCrdtBatch(`Title ${updateId}`),
  };
}

function createCrdtBatch(title: string): RallarCrdtOperationBatch {
  return {
    kind: 'batch',
    operations: [
      {
        kind: 'register.set',
        path: ['title'],
        policy: 'lww',
        value: title,
      },
    ],
  };
}

function createResourceEntry(
  resourceId: string,
  options: Readonly<{
    topicId?: string;
    contextId?: string;
    typeId?: string;
    status?: EntityStatus;
    payload?: unknown;
    expiryTs?: Temporal.Instant;
  }> = {},
): ResourceEntry {
  return {
    key: {
      topicId: options.topicId ?? 'topic-smoke',
      resourceId,
      contextId: options.contextId ?? 'ctx-smoke',
    },
    resource: JSON.stringify(options.payload ?? { resourceId }),
    typeId: options.typeId ?? 'TYPE_A',
    status: options.status ?? EntityStatus.NEW,
    audit: {
      date: CREATED_TS.toPlainTime(),
      createdBy: 'tester',
      createdTs: CREATED_TS,
      expiryTs: options.expiryTs ?? FUTURE_INSTANT,
    },
    dequeueAudit: {
      attempts: 0,
    },
  };
}

class PGliteTestSocket {
  readonly readyState = WebSocket.OPEN;
  private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(): void {}

  async dispatchMessage(message: ALMessage): Promise<void> {
    const event = { data: JSON.stringify(message) } as MessageEvent;
    for (const listener of this.listeners.get('message') ?? []) {
      await listener(event);
    }
  }
}

function advanceCoalescedGeneration(
  entry: ResourceEntry,
  generation: number,
): ResourceEntry {
  const message = JSON.parse(entry.resource);
  const envelope = JSON.parse(message.payload.resource);
  envelope.data.__rallarCoalescedWork.generation = generation;
  envelope.data.revision = generation;
  message.payload.resource = JSON.stringify(envelope);
  return {
    ...entry,
    resource: JSON.stringify(message),
  };
}
