import assert from 'node:assert/strict';
import { Temporal } from '@js-temporal/polyfill';
import { PSqlAppDataRepository } from '@shared-server/postgres/app-data/PSqlAppDataRepository.ts';
import { PSqlCrdtLogRepository } from '@shared-server/postgres/crdt/PSqlCrdtLogRepository.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import {
  ResourceInboxResultsRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import {
  PSqlClientStateEventRepository,
  PSqlGroupStateEventRepository,
} from '@shared-server/postgres/rallar-system/PSqlStateEventRepository.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';
import {
  RALLAR_CRDT_OPERATION_VERSION,
  RALLAR_CRDT_PROTOCOL_VERSION,
  type RallarCrdtDocumentRef,
  type RallarCrdtOperationBatch,
  type RallarCrdtSnapshotEnvelope,
  type RallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { createApiV1SqlClient } from '../../src/db/db.ts';
import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';

const FUTURE_MS = Date.parse('9999-12-31T23:59:59.999Z');
const PAST_MS = Date.parse('2000-01-01T00:00:00.000Z');
const FUTURE_INSTANT = Temporal.Instant.from('9999-12-31T23:59:59.999Z');
const PAST_INSTANT = Temporal.Instant.from('2000-01-01T00:00:00.000Z');
const CREATED_TS = Temporal.PlainDateTime.from('2026-06-01T12:00:00');

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

    const allEntries = await repository.findAllEntries('runtime-smoke');
    assert.deepEqual(allEntries.map((row) => row.key), ['a', 'b']);

    const prefixedEntries = await repository.findEntriesByPrefix('runtime-smoke', 'a');
    assert.deepEqual(prefixedEntries.map((row) => row.key), ['a']);

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
    await clientEvents.appendClientEvent(
      createClientStateEvent('client-filtered', 4_000, 40, 'session-disconnected'),
    );
    await clientEvents.appendClientEvent(
      createClientStateEvent('client-filtered', 5_000, 50, 'session-disconnected', {
        reason: 'updated',
      }),
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
    assert.equal(filteredClientPage.events[0].reason, undefined);
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

    await groupEvents.appendGroupEvent(
      createGroupStateEvent('group-late-snapshot', 1_000, 30),
    );
    await groupEvents.appendGroupEvent(
      createGroupStateEvent('group-early-snapshot', 2_000, 10),
    );
    await groupEvents.appendGroupEvent(
      createGroupStateEvent('group-middle-snapshot', 3_000, 20),
    );
    await groupEvents.appendGroupEvent(
      createGroupStateEvent('group-duplicate', 4_000, 40, 'member-left'),
    );
    await groupEvents.appendGroupEvent(
      createGroupStateEvent('group-duplicate', 5_000, 50, 'member-left', {
        reason: 'updated',
      }),
    );

    const firstGroupPage = await groupEvents.listGroupEventPage(groupRef, {
      limit: 2,
    });
    const secondGroupPage = await groupEvents.listGroupEventPage(groupRef, {
      limit: 2,
      after: firstGroupPage.nextCursor,
    });

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
    assert.equal(secondGroupPage.events[1]?.reason, undefined);
    assert.deepEqual(secondGroupPage.nextCursor, {
      snapshotVersion: 40,
      occurredAtEpochMs: 4_000,
      eventId: 'group-duplicate',
    });
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

    const stored = await inbox.write(active);
    assert.ok(stored.db?.id);
    await inbox.write(expired);

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

    assert.equal(await inbox.updateResourceEntry(active.key, EntityStatus.COMPLETED), 1);
    assert.equal((await inbox.findByKey(active.key))?.status, EntityStatus.COMPLETED);
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

    const accepted = await repository.append(toCrdtAppendInput(first));
    const duplicate = await repository.append(toCrdtAppendInput(first));
    await repository.append(toCrdtAppendInput(second));

    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.status === 'accepted' && accepted.append.appendSequence, 1);
    assert.equal(duplicate.status, 'duplicate');
    assert.equal(
      duplicate.status === 'duplicate' && duplicate.append.appendSequence,
      1,
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
      serviceId: 'pglite-test',
    },
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
    occurredAtEpochMs,
    actor: {
      serviceId: 'pglite-test',
    },
    ...overrides,
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
