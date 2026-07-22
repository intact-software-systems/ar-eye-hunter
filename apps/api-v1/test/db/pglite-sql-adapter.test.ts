import assert from 'node:assert/strict';
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
import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts';
import { StateMutationOutboxRepository } from '@shared-server/rallar-system/repositories/StateMutationOutboxRepository.ts';
import { createGroupStateService } from '@shared-server/rallar-system/services/group-state-service.ts';
import { GroupTopologyManagementService } from '@shared-server/rallar-system/services/group-topology-management-service.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import {
  groupStateGroupStorageKey,
  groupStateMemberStorageKey,
  groupStatePresenceSessionStorageKey,
} from '@shared-server/rallar-system/group-state-storage-keys.ts';
import { CoalescedAppOutboxWorkService } from '@shared-server/rallar-system/services/CoalescedAppOutboxWorkService.ts';
import { AppOutboxType } from '@shared-server/rallar-system/services/AppOutboxService.ts';
import {
  PSqlClientStateEventRepository,
  PSqlGroupStateEventRepository,
} from '@shared-server/postgres/rallar-system/PSqlStateEventRepository.ts';
import { groupEventWorkspaceKey } from '@shared-server/postgres/rallar-system/group-event-workspace-key.ts';
import { createGroupStateEventRepository } from '@shared-server/postgres/rallar-system/createStateRepositories.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';
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
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { createApiV1SqlClient } from '../../src/db/db.ts';
import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';

const FUTURE_MS = Date.parse('9999-12-31T23:59:59.999Z');
const PAST_MS = Date.parse('2000-01-01T00:00:00.000Z');
const FUTURE_INSTANT = Temporal.Instant.from('9999-12-31T23:59:59.999Z');
const PAST_INSTANT = Temporal.Instant.from('2000-01-01T00:00:00.000Z');
const CREATED_TS = Temporal.PlainDateTime.from('2026-06-01T12:00:00');

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
    assert.match(entry?.updatedTimestamp ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);

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

Deno.test('PGlite topology config mutations converge concurrent CAS transactions with receipts and outboxes', async () => {
  await withPGliteSql(async (sql) => {
    const runtime = new PSqlRuntimeStateRepository(sql);
    const repository = new GroupTopologyConfigRepository(runtime);
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
    const service = () => new GroupTopologyManagementService({
      findGroupSnapshotByRef: () => snapshot,
      groupStateRepository,
      configRepository: repository,
      topologyService: new RallarRtcTopologyService(),
      sleep: () => Promise.resolve(),
    });

    const results = await Promise.all([
      service().putConfig({
        groupRef,
        config: { topologyKind: 'tree' },
        updatedByPrincipalId: 'owner',
        requestId: 'pglite-topology-a',
      }),
      service().putConfig({
        groupRef,
        config: { topologyKind: 'mesh' },
        updatedByPrincipalId: 'owner',
        requestId: 'pglite-topology-b',
      }),
    ]);

    assert.deepEqual(results.map(({ config }) => config.version).sort(), [1, 2]);
    assert.deepEqual(
      results.map(({ receipt }) => receipt.acceptedVersion).sort(),
      [1, 2],
    );
    assert.ok(await repository.findMutationRecord(groupRef, 'pglite-topology-a'));
    assert.ok(await repository.findMutationRecord(groupRef, 'pglite-topology-b'));
    const generation = await repository.findGenerationEntry(groupRef, 'config');
    assert.deepEqual(generation?.value, { groupRef, target: 'config', version: 2 });
    assert.equal(generation?.entry.revision, 1);
    const invariantGeneration = await repository.findInvariantGenerationEntry(groupRef);
    assert.deepEqual(invariantGeneration?.value, { groupRef, version: 2 });
    assert.equal(
      invariantGeneration?.entry.key,
      repository.invariantGenerationKey(groupRef),
    );
    assert.equal(invariantGeneration?.entry.revision, 1);
    const outbox = new StateMutationOutboxRepository(runtime);
    const pending = await outbox.listPendingPage({ limit: 10 });
    assert.equal(pending.records.length, 2);
    assert.ok(pending.records.every(({ record }) =>
      record.effects.length === 1 && record.effects[0] === 'rtc-topology-recompute'
    ));
    const exactRecords = await Promise.all(
      results.map(({ receipt }) => outbox.find(receipt.outboxId!)),
    );
    assert.deepEqual(
      exactRecords.map((stored) => stored?.record.commandId).sort(),
      ['pglite-topology-a', 'pglite-topology-b'],
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
    let pauseFirstRead = true;
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
      sleep: () => Promise.resolve(),
    });

    const mutation = service.putConfig({
      groupRef,
      config: { topologyKind: 'tree' },
      updatedByPrincipalId: 'owner',
      requestId: 'pglite-overlapping-archive',
    });
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

    await assert.rejects(
      mutation,
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
      (await new StateMutationOutboxRepository(runtime).listPendingPage({ limit: 10 }))
        .records.length,
      0,
    );
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

    assert.equal((await clients.insertPrincipal({
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
    })).status, 'applied');
    assert.equal((await clients.insertPrincipal({
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
    })).status, 'applied');
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
        () => repository.listGroups({
          applicationId: ref.applicationId,
          workspaceId: ref.workspaceId,
        }),
        () => repository.listSnapshots({
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
        sleep: () => Promise.resolve(),
        serviceId: `pglite-complete-${testCase.kind}`,
      });
      await service.createGroup(scope, {
        groupId: ref.groupId,
        displayName: `Complete ${testCase.kind}`,
        kind: 'room',
        joinMode: 'open',
        createdByPrincipalId: 'alice',
        requestId: `create-${testCase.kind}`,
      }, authority);
      if (testCase.kind === 'session') {
        await service.connectPresenceSession(
          scope,
          ref.groupId,
          authority.sessionId,
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
        await assert.rejects(read, (error) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'group-state-repository-invariant-corruption',
          `${testCase.kind} public read ${readIndex} accepted a corrupt persisted record`);
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
    for (
      const duplicate of [
        structuredClone(firstDuplicate),
        createGroupStateEvent('group-duplicate', 5_000, 50, 'member-left', {
          reason: 'updated',
        }),
      ]
    ) {
      await assert.rejects(
        () => groupEvents.appendGroupEvent(duplicate),
        (error) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'group-state-event-collision',
      );
    }

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
    const eventIds = ['seed-event', 'colliding-event'];
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
      randomId: () => eventIds.shift() ?? 'unexpected-event-id',
      sleep: () => Promise.resolve(),
      serviceId: 'pglite-group-service',
    });
    const scope = { applicationId: 'collision-app', workspaceId: 'main' };
    const ref = { ...scope, groupId: 'collision-group' };
    await service.createGroup(scope, {
      groupId: ref.groupId,
      displayName: 'Before collision',
      kind: 'room',
      joinMode: 'open',
      createdByPrincipalId: 'alice',
      requestId: 'seed-collision-group',
    }, authority);
    await new PSqlGroupStateEventRepository(sql).appendGroupEvent(
      createGroupStateEvent('colliding-event', 9_000, 99, 'group-updated', {
        ...ref,
        requestId: 'preexisting-event',
      }),
    );

    await assert.rejects(
      () =>
        service.updateGroup(scope, ref.groupId, {
          displayName: 'Must roll back',
          actorPrincipalId: 'alice',
          requestId: 'collision-request',
        }, authority),
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
        and event_id = 'colliding-event'
    `;
    assert.equal(Number(collisionRows[0]?.count), 1);
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
    for (const [suffix, defect] of [
      ['workspace', { workspaceId: null }],
      ['payload', { payload: null }],
    ] as const) {
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

      for (const read of [
        () => repository.listGroupEvents(ref),
        () => repository.listRecentGroupEvents(ref),
        () => repository.listGroupEventPage(ref, { limit: 10 }),
      ]) {
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
      () => inbox.writeIfAbsentOrMatch({
        ...entry,
        audit: {
          ...entry.audit,
          createdTs: Temporal.PlainDateTime.from('2026-06-01T12:00:00.000002'),
        },
      }),
      ResourceInboxInvariantCorruptionError,
    );
    await assert.rejects(
      () => inbox.writeIfAbsentOrMatch({
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
      () => inbox.writeIfAbsentOrMatch({
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
    assert.equal([...recovered.values()][0]?.dequeueAudit.attempts, 21);
    assert.equal([...recovered.values()][0]?.status, EntityStatus.RESERVED);
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
    assert.equal(await inbox.isEntriesToLock(
      new Set([exhausted.typeId]),
      new Set([EntityStatus.NEW]),
      2,
    ), false);
    assert.equal(await inbox.isEntriesToLock(
      new Set([exhausted.typeId]),
      new Set([EntityStatus.NEW]),
    ), true);
    assert.equal(await inbox.isTimeoutOnReservedEntries(
      new Set([exhaustedTimeout.typeId]),
      Temporal.Duration.from({ seconds: 1 }),
      2,
    ), false);
    assert.equal(await inbox.isTimeoutOnReservedEntries(
      new Set([exhaustedTimeout.typeId]),
      Temporal.Duration.from({ seconds: 1 }),
    ), true);
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
      assert.equal((await inbox.begin((transactionInbox) =>
        transactionInbox.findTimedOutReservedEntriesSkipLocked(
          new Set([databaseClockTimeout.typeId]),
          30_000,
          { maxToReserve: 1, maxAttempts: 2 },
        )
      )).size, 0);
      await sql`
        update resource_inbox
        set start_ts = (now() - interval '31 seconds') at time zone 'UTC'
        where ri_topic_id = ${databaseClockTimeout.key.topicId}
          and ri_resource_id = ${databaseClockTimeout.key.resourceId}
          and fk_ext_bank_id = ${databaseClockTimeout.key.contextId}
      `;
      assert.equal((await inbox.begin((transactionInbox) =>
        transactionInbox.findTimedOutReservedEntriesSkipLocked(
          new Set([databaseClockTimeout.typeId]),
          30_000,
          { maxToReserve: 1, maxAttempts: 2 },
        )
      )).size, 1);
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
      () => inbox.writeIfAbsentOrMatch({
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
    assert.equal(await inbox.releaseReserved(active.key, {
      expectedAttempts: 2,
      releasedAt,
      disposition: { status: EntityStatus.COMPLETED, delayMs: null },
    }), null);
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
      () => queueBox.releaseEntries([
        firstReservation.right!,
        {
          ...secondReservation.right!,
          dequeueAudit: {
            ...secondReservation.right!.dequeueAudit,
            attempts: 0,
          },
        },
      ], { status: EntityStatus.COMPLETED, delayMs: null }),
      (error) => error instanceof Error &&
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
