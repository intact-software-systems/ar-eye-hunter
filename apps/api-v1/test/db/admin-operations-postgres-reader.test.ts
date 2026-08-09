import assert from 'node:assert/strict';
import {
  PSqlAdminOperationsPruner,
  PSqlAdminOperationsStatsReader,
} from '@shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import {
  decodeClientPrincipalStorageKey,
  decodeClientSessionStorageKey,
} from '@shared-server/rallar-system/client-state/persistence/client-state-storage-keys.ts';
import {
  decodeGroupStateGroupStorageKey,
  decodeGroupStateMemberStorageKey,
  decodeGroupStatePresenceSessionStorageKey,
} from '@shared-server/rallar-system/group-state-storage-keys.ts';
import { createApiV1SqlClient } from '../../src/db/db.ts';
import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';

Deno.test('PSqlAdminOperationsStatsReader aggregates admin read statistics', async () => {
  await withPGliteSql(async (sql) => {
    await seedAdminOperationsRows(sql);
    const reader = new PSqlAdminOperationsStatsReader(sql, {
      now: () => 1_700_000_000_000,
      serverId: 'test-server',
      sqlBackend: 'pglite-memory',
      dbPubSub: 'local',
    });

    const queues = await reader.readQueues({ adminSession: createAdminSession() });
    assert.equal(queues.queueRows.total, 3);
    assert.equal(queues.queueRows.expired, 1);
    assert.deepEqual(queues.queueRows.byTypeStatus, [
      { typeId: 'APP_OUTBOX', status: 'PENDING', count: 1 },
      { typeId: 'WS_INBOX', status: 'PENDING', count: 1 },
      { typeId: 'WS_OUTBOX', status: 'RESERVED', count: 1 },
    ]);
    assert.equal(queues.resultRows.total, 2);
    assert.equal(queues.resultRows.expired, 1);

    const state = await reader.readState({
      adminSession: createAdminSession(),
      scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
    });
    assert.equal(state.clients.totalPrincipals, 1);
    assert.equal(state.clients.activeSessions, 1);
    assert.equal(state.groups.activeGroups, 1);
    assert.equal(state.groups.onlineMembers, 1);
    assert.equal(state.events.recentClientEvents, 1);
    assert.equal(state.events.recentGroupEvents, 1);

    const crdt = await reader.readCrdt({
      adminSession: createAdminSession(),
      scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
    });
    assert.equal(crdt.documents.total, 1);
    assert.deepEqual(crdt.documents.byLifecycle, [
      { status: 'active', count: 1 },
    ]);
    assert.equal(crdt.storage.updates, 3);
    assert.equal(crdt.storage.snapshots, 1);
    assert.equal(crdt.storage.storedUpdateBytes, 42);

    const system = await reader.readSystem({ adminSession: createAdminSession() });
    assert.equal(system.runtimeState.rows, 7);
    assert.equal(system.runtimeState.expiredRows, 2);
    assert.equal(system.appData.rows, 2);
    assert.equal(system.appData.expiredRows, 1);
    assert.equal(system.stateEvents.clientEvents, 1);
    assert.equal(system.stateEvents.groupEvents, 1);
    assert.deepEqual(system.configuration, {
      sqlBackend: 'pglite-memory',
      dbPubSub: 'local',
    });
  });
});

Deno.test('PSqlAdminOperationsStatsReader bounds recent events and expires active groups logically', async () => {
  await withPGliteSql(async (sql) => {
    const nowEpochMs = 1_700_000_000_000;
    const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };
    const keyPrefix = 'app=app-1:ws=workspace-1';

    for (
      const [key, value] of [
        [`${keyPrefix}:group=no-expiry`, { status: 'active' }],
        [
          `${keyPrefix}:group=future-expiry`,
          { status: 'active', expiresAtEpochMs: nowEpochMs + 1 },
        ],
        [
          `${keyPrefix}:group=expired-now`,
          { status: 'active', expiresAtEpochMs: nowEpochMs },
        ],
      ] as const
    ) {
      await insertRuntimeState(sql, {
        namespace: 'group-state:groups',
        key,
        value,
      });
    }

    await sql`
      insert into client_state_events (
        application_id, workspace_key, principal_id, event_id, event_type,
        snapshot_version, occurred_at_epoch_ms, event_json
      )
      values
        (${'app-1'}, ${'workspace-1'}, ${'alice'}, ${'client-old'}, ${'connected'}, ${1}, ${1_699_999_099_999}, ${'{}'}),
        (${'app-1'}, ${'workspace-1'}, ${'alice'}, ${'client-boundary'}, ${'connected'}, ${1}, ${1_699_999_100_000}, ${'{}'})
    `;
    await sql`
      insert into group_state_events (
        application_id, workspace_key, group_id, event_id, event_type,
        snapshot_version, occurred_at_epoch_ms, event_json
      )
      values
        (${'app-1'}, ${'workspace-1'}, ${'room-1'}, ${'group-old'}, ${'connected'}, ${1}, ${1_699_999_099_999}, ${'{}'}),
        (${'app-1'}, ${'workspace-1'}, ${'room-1'}, ${'group-boundary'}, ${'connected'}, ${1}, ${1_699_999_100_000}, ${'{}'})
    `;

    const reader = new PSqlAdminOperationsStatsReader(sql, { now: () => nowEpochMs });

    const scopedState = await reader.readState({ adminSession: createAdminSession(), scope });
    const globalState = await reader.readState({ adminSession: createAdminSession() });
    const system = await reader.readSystem({ adminSession: createAdminSession() });

    assert.equal(scopedState.events.recentClientEvents, 1);
    assert.equal(scopedState.events.recentGroupEvents, 1);
    assert.equal(globalState.events.recentClientEvents, 1);
    assert.equal(globalState.events.recentGroupEvents, 1);
    assert.equal(system.stateEvents.clientEvents, 2);
    assert.equal(system.stateEvents.groupEvents, 2);
    assert.equal(scopedState.groups.activeGroups, 2);
    assert.equal(globalState.groups.activeGroups, 2);
  });
});

Deno.test('PSqlAdminOperationsStatsReader fails closed on complete-contract violations in both scopes', async () => {
  const nowEpochMs = 1_700_000_000_000;
  const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };
  const keyPrefix = 'app=app-1:ws=workspace-1';
  const missingUpdated = canonicalGroupRuntimeValue(`${keyPrefix}:group=missing-updated`);
  delete missingUpdated.updated;
  const missingExpiry = canonicalGroupRuntimeValue(`${keyPrefix}:group=missing-expiry`);
  delete missingExpiry.expiresAtEpochMs;

  for (
    const input of [
      {
        label: 'missing mandatory group field',
        namespace: 'group-state:groups',
        key: `${keyPrefix}:group=missing-updated`,
        value: missingUpdated,
      },
      {
        label: 'wrong group discriminant primitive',
        namespace: 'group-state:groups',
        key: `${keyPrefix}:group=wrong-status`,
        value: canonicalGroupRuntimeValue(`${keyPrefix}:group=wrong-status`, { status: 1 }),
      },
      {
        label: 'missing group expiry',
        namespace: 'group-state:groups',
        key: `${keyPrefix}:group=missing-expiry`,
        value: missingExpiry,
      },
      {
        label: 'wrong member role primitive',
        namespace: 'group-state:members',
        key: `${keyPrefix}:group=room:member=alice`,
        value: canonicalMemberRuntimeValue(`${keyPrefix}:group=room:member=alice`, { role: 2 }),
      },
      {
        label: 'session heartbeat after expiry',
        namespace: 'group-state:sessions',
        key: `${keyPrefix}:group=room:session=session-a`,
        value: canonicalSessionRuntimeValue(`${keyPrefix}:group=room:session=session-a`, {
          lastHeartbeatAtEpochMs: nowEpochMs + 2_000,
          expiresAtEpochMs: nowEpochMs + 1_000,
        }),
      },
    ] as const
  ) {
    await withPGliteSql(async (sql) => {
      await insertRawRuntimeState(sql, input);
      const reader = new PSqlAdminOperationsStatsReader(sql, { now: () => nowEpochMs });
      for (
        const read of [
          () => reader.readState({ adminSession: createAdminSession() }),
          () => reader.readState({ adminSession: createAdminSession(), scope }),
        ]
      ) {
        await assert.rejects(
          read,
          (error) =>
            error instanceof Error &&
            'code' in error &&
            error.code === 'admin-operations-state-invariant-corruption',
          input.label,
        );
      }
    });
  }
});

Deno.test('PSqlAdminOperationsStatsReader counts canonical valid group expiries in both scopes', async () => {
  await withPGliteSql(async (sql) => {
    const nowEpochMs = 1_700_000_000_000;
    const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };
    const keyPrefix = 'app=app-1:ws=workspace-1';
    for (
      const [groupId, expiresAtEpochMs] of [
        ['no-expiry', undefined],
        ['future-expiry', nowEpochMs + 1],
        ['expired-now', nowEpochMs],
      ] as const
    ) {
      const key = `${keyPrefix}:group=${groupId}`;
      await insertRawRuntimeState(sql, {
        namespace: 'group-state:groups',
        key,
        value: canonicalGroupRuntimeValue(key, {
          expiresAtEpochMs: expiresAtEpochMs ?? null,
        }),
      });
    }
    const reader = new PSqlAdminOperationsStatsReader(sql, { now: () => nowEpochMs });
    const globalState = await reader.readState({ adminSession: createAdminSession() });
    const scopedState = await reader.readState({ adminSession: createAdminSession(), scope });
    assert.equal(globalState.groups.activeGroups, 2);
    assert.equal(scopedState.groups.activeGroups, 2);
  });
});

Deno.test('PSqlAdminOperationsStatsReader applies a custom recent-event window within scope', async () => {
  await withPGliteSql(async (sql) => {
    const nowEpochMs = 1_700_000_000_000;
    const recentEventWindowMs = 60_000;
    const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };

    await sql`
      insert into client_state_events (
        application_id, workspace_key, principal_id, event_id, event_type,
        snapshot_version, occurred_at_epoch_ms, event_json
      )
      values
        (${'app-1'}, ${'workspace-1'}, ${'alice'}, ${'client-old'}, ${'connected'}, ${1}, ${
      nowEpochMs - recentEventWindowMs - 1
    }, ${'{}'}),
        (${'app-1'}, ${'workspace-1'}, ${'alice'}, ${'client-boundary'}, ${'connected'}, ${1}, ${
      nowEpochMs - recentEventWindowMs
    }, ${'{}'}),
        (${'app-2'}, ${'workspace-2'}, ${'bob'}, ${'client-decoy'}, ${'connected'}, ${1}, ${nowEpochMs}, ${'{}'})
    `;
    await sql`
      insert into group_state_events (
        application_id, workspace_key, group_id, event_id, event_type,
        snapshot_version, occurred_at_epoch_ms, event_json
      )
      values
        (${'app-1'}, ${'workspace-1'}, ${'room-1'}, ${'group-old'}, ${'connected'}, ${1}, ${
      nowEpochMs - recentEventWindowMs - 1
    }, ${'{}'}),
        (${'app-1'}, ${'workspace-1'}, ${'room-1'}, ${'group-boundary'}, ${'connected'}, ${1}, ${
      nowEpochMs - recentEventWindowMs
    }, ${'{}'}),
        (${'app-2'}, ${'workspace-2'}, ${'room-2'}, ${'group-decoy'}, ${'connected'}, ${1}, ${nowEpochMs}, ${'{}'})
    `;

    const readerOptions = { now: () => nowEpochMs, recentEventWindowMs };
    const reader = new PSqlAdminOperationsStatsReader(sql, readerOptions);

    const scopedState = await reader.readState({ adminSession: createAdminSession(), scope });
    const globalState = await reader.readState({ adminSession: createAdminSession() });
    const system = await reader.readSystem({ adminSession: createAdminSession() });

    assert.equal(scopedState.events.recentClientEvents, 1);
    assert.equal(scopedState.events.recentGroupEvents, 1);
    assert.equal(globalState.events.recentClientEvents, 2);
    assert.equal(globalState.events.recentGroupEvents, 2);
    assert.equal(system.stateEvents.clientEvents, 3);
    assert.equal(system.stateEvents.groupEvents, 3);
  });
});

Deno.test('PSqlAdminOperationsStatsReader orders queue topPressure by count descending', async () => {
  await withPGliteSql(async (sql) => {
    for (
      const input of [
        { id: 'low', typeId: 'AA_LOW', status: 'PENDING' },
        { id: 'high-1', typeId: 'ZZ_HIGH', status: 'PENDING' },
        { id: 'high-2', typeId: 'ZZ_HIGH', status: 'PENDING' },
        { id: 'high-3', typeId: 'ZZ_HIGH', status: 'PENDING' },
        { id: 'mid-1', typeId: 'MM_MID', status: 'RESERVED' },
        { id: 'mid-2', typeId: 'MM_MID', status: 'RESERVED' },
      ] as const
    ) {
      await insertResourceInbox(sql, input);
    }
    for (
      const input of [
        { id: 'low', typeId: 'AA_RESULT', status: 'FAILED' },
        { id: 'high-1', typeId: 'ZZ_RESULT', status: 'COMPLETED' },
        { id: 'high-2', typeId: 'ZZ_RESULT', status: 'COMPLETED' },
      ] as const
    ) {
      await insertResourceInboxResult(sql, input);
    }

    const reader = new PSqlAdminOperationsStatsReader(sql, {
      now: () => 1_700_000_000_000,
    });

    const queues = await reader.readQueues({ adminSession: createAdminSession() });

    assert.deepEqual(queues.queueRows.topPressure.slice(0, 3), [
      { typeId: 'ZZ_HIGH', status: 'PENDING', count: 3 },
      { typeId: 'MM_MID', status: 'RESERVED', count: 2 },
      { typeId: 'AA_LOW', status: 'PENDING', count: 1 },
    ]);
    assert.deepEqual(queues.resultRows.topPressure.slice(0, 2), [
      { typeId: 'ZZ_RESULT', status: 'COMPLETED', count: 2 },
      { typeId: 'AA_RESULT', status: 'FAILED', count: 1 },
    ]);
  });
});

Deno.test('PSqlAdminOperationsStatsReader uses encoded runtime-state scope keys', async () => {
  await withPGliteSql(async (sql) => {
    const applicationId = 'ops app/1';
    const workspaceId = 'workspace:blue';
    const keyPrefix = `app=${encodeURIComponent(applicationId)}:ws=${
      encodeURIComponent(workspaceId)
    }`;
    await insertRuntimeState(sql, {
      namespace: 'client-state:principals',
      key: `${keyPrefix}:principal=alice`,
      value: { status: 'active' },
    });
    await insertRuntimeState(sql, {
      namespace: 'client-state:sessions',
      key: `${keyPrefix}:principal=alice:instance=browser:session=s1`,
      value: {
        applicationId,
        workspaceId,
        status: 'active',
        presenceState: 'online',
        principalId: 'alice',
        expiresAtEpochMs: 1_700_000_060_000,
      },
    });
    await insertRuntimeState(sql, {
      namespace: 'group-state:groups',
      key: `${keyPrefix}:group=room-1`,
      value: { status: 'active' },
    });

    const reader = new PSqlAdminOperationsStatsReader(sql, {
      now: () => 1_700_000_000_000,
    });

    const state = await reader.readState({
      adminSession: createAdminSession(),
      scope: { applicationId, workspaceId },
    });

    assert.equal(state.clients.totalPrincipals, 1);
    assert.equal(state.clients.onlinePrincipals, 1);
    assert.equal(state.clients.activeSessions, 1);
    assert.equal(state.groups.activeGroups, 1);
  });
});

Deno.test('PSqlAdminOperationsStatsReader isolates explicit sentinel group state and events', async () => {
  await withPGliteSql(async (sql) => {
    const applicationId = 'ops-sentinel-app';
    for (const index of [1, 2]) {
      await insertRuntimeState(sql, {
        namespace: 'group-state:groups',
        key: `app=${applicationId}:ws=_:group=absent-${index}`,
        value: {
          applicationId,
          groupId: `absent-${index}`,
          status: 'active',
        },
      });
      await sql`
        insert into group_state_events (
          application_id, workspace_key, group_id, event_id, event_type,
          snapshot_version, occurred_at_epoch_ms, event_json
        ) values (
          ${applicationId}, '_', ${`absent-${index}`}, ${`absent-event-${index}`},
          'group-updated', ${index}, ${1_700_000_000_000 + index},
          ${
        JSON.stringify({
          applicationId,
          groupId: `absent-${index}`,
          eventId: `absent-event-${index}`,
        })
      }
        )
      `;
    }
    await insertRuntimeState(sql, {
      namespace: 'group-state:groups',
      key: `app=${applicationId}:ws=%5F:group=explicit-sentinel`,
      value: {
        applicationId,
        workspaceId: '_',
        groupId: 'explicit-sentinel',
        status: 'active',
      },
    });
    await sql`
      insert into group_state_events (
        application_id, workspace_key, group_id, event_id, event_type,
        snapshot_version, occurred_at_epoch_ms, event_json
      ) values (
        ${applicationId}, '%5F', 'explicit-sentinel', 'explicit-event',
        'group-updated', 1, 1700000000001,
        ${
      JSON.stringify({
        applicationId,
        workspaceId: '_',
        groupId: 'explicit-sentinel',
        eventId: 'explicit-event',
      })
    }
      )
    `;

    const reader = new PSqlAdminOperationsStatsReader(sql, {
      now: () => 1_700_000_000_100,
    });
    const state = await reader.readState({
      adminSession: createAdminSession(),
      scope: { applicationId, workspaceId: '_' },
    });

    assert.equal(state.groups.activeGroups, 1);
    assert.equal(state.events.recentGroupEvents, 1);
  });
});

Deno.test('PSqlAdminOperationsStatsReader fails closed on wrong-scope group runtime values', async () => {
  await withPGliteSql(async (sql) => {
    const scope = {
      applicationId: 'ops-corrupt-scope-app',
      workspaceId: '_',
    };
    await insertRuntimeState(sql, {
      namespace: 'group-state:groups',
      key: `app=${scope.applicationId}:ws=%5F:group=corrupt-group`,
      value: {
        applicationId: scope.applicationId,
        workspaceId: 'wrong-workspace',
        groupId: 'corrupt-group',
        status: 'active',
      },
    });
    const reader = new PSqlAdminOperationsStatsReader(sql, {
      now: () => 1_700_000_000_100,
    });

    await assert.rejects(
      () => reader.readState({ adminSession: createAdminSession(), scope }),
      (error) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'admin-operations-state-invariant-corruption',
    );
  });
});

Deno.test('PSqlAdminOperationsStatsReader rejects noncanonical group child-key aliases', async () => {
  for (
    const input of [
      {
        namespace: 'group-state:members',
        key: 'app=ops-alias-app:ws=alias-workspace:group=room:member=%61lice',
        value: {
          applicationId: 'ops-alias-app',
          workspaceId: 'alias-workspace',
          groupId: 'room',
          principalId: 'alice',
          status: 'active',
        },
      },
      {
        namespace: 'group-state:sessions',
        key: 'app=ops-alias-app:ws=alias-workspace:group=room:session=%73ession',
        value: {
          applicationId: 'ops-alias-app',
          workspaceId: 'alias-workspace',
          groupId: 'room',
          sessionId: 'session',
          principalId: 'alice',
          expiresAtEpochMs: 1_700_000_060_000,
        },
      },
    ] as const
  ) {
    await withPGliteSql(async (sql) => {
      await sql`
        insert into runtime_state_store (
          store_namespace, store_key, store_value, expire_at_ts
        ) values (
          'group-state:groups',
          'app=ops-alias-app:ws=alias-workspace:group=room',
          ${
        JSON.stringify({
          applicationId: 'ops-alias-app',
          workspaceId: 'alias-workspace',
          groupId: 'room',
          status: 'active',
        })
      },
          ${new Date('9999-12-31T23:59:59Z')}
        )
      `;
      await sql`
        insert into runtime_state_store (
          store_namespace, store_key, store_value, expire_at_ts
        ) values (
          ${input.namespace}, ${input.key}, ${JSON.stringify(input.value)},
          ${new Date('9999-12-31T23:59:59Z')}
        )
      `;
      const reader = new PSqlAdminOperationsStatsReader(sql, {
        now: () => 1_700_000_000_100,
      });

      await assert.rejects(
        () =>
          reader.readState({
            adminSession: createAdminSession(),
            scope: {
              applicationId: 'ops-alias-app',
              workspaceId: 'alias-workspace',
            },
          }),
        (error) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'admin-operations-state-invariant-corruption',
      );
    });
  }
});

Deno.test('PSqlAdminOperationsStatsReader treats encoded scope prefixes literally', async () => {
  await withPGliteSql(async (sql) => {
    const applicationId = 'ops/app';
    const workspaceId = 'workspace:blue';
    const literalPrefix = `app=${encodeURIComponent(applicationId)}:ws=${
      encodeURIComponent(workspaceId)
    }`;
    const wildcardCollisionPrefix = 'app=opsZZ2Fapp:ws=workspaceZZ3Ablue';

    await insertRuntimeState(sql, {
      namespace: 'client-state:principals',
      key: `${literalPrefix}:principal=alice`,
      value: { applicationId, workspaceId, principalId: 'alice', status: 'active' },
    });
    await insertRuntimeState(sql, {
      namespace: 'client-state:principals',
      key: `${wildcardCollisionPrefix}:principal=bob`,
      value: {
        applicationId: 'opsZZ2Fapp',
        workspaceId: 'workspaceZZ3Ablue',
        principalId: 'bob',
        status: 'active',
      },
    });
    await insertRuntimeState(sql, {
      namespace: 'client-state:sessions',
      key: `${literalPrefix}:principal=alice:instance=browser:session=s1`,
      value: {
        applicationId,
        workspaceId,
        status: 'active',
        principalId: 'alice',
        expiresAtEpochMs: 1_700_000_060_000,
      },
    });
    await insertRuntimeState(sql, {
      namespace: 'client-state:sessions',
      key: `${wildcardCollisionPrefix}:principal=bob:instance=browser:session=s2`,
      value: {
        applicationId: 'opsZZ2Fapp',
        workspaceId: 'workspaceZZ3Ablue',
        status: 'active',
        principalId: 'bob',
        expiresAtEpochMs: 1_700_000_060_000,
      },
    });

    const reader = new PSqlAdminOperationsStatsReader(sql, {
      now: () => 1_700_000_000_000,
    });

    const state = await reader.readState({
      adminSession: createAdminSession(),
      scope: { applicationId, workspaceId },
    });

    assert.equal(state.clients.totalPrincipals, 1);
    assert.equal(state.clients.onlinePrincipals, 1);
    assert.equal(state.clients.activeSessions, 1);
  });
});

Deno.test('PSqlAdminOperationsStatsReader excludes inactive domain state from active counts', async () => {
  await withPGliteSql(async (sql) => {
    const keyPrefix = 'app=app-1:ws=workspace-1';
    for (
      const input of [
        {
          namespace: 'client-state:principals',
          key: `${keyPrefix}:principal=alice`,
          value: { status: 'active' },
        },
        {
          namespace: 'client-state:sessions',
          key: `${keyPrefix}:principal=alice:instance=browser:session=s1`,
          value: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            status: 'active',
            principalId: 'alice',
            presenceState: 'online',
            expiresAtEpochMs: 1_700_000_060_000,
          },
        },
        {
          namespace: 'client-state:sessions',
          key: `${keyPrefix}:principal=alice:instance=phone:session=s2`,
          value: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            status: 'active',
            principalId: 'alice',
            presenceState: 'away',
            expiresAtEpochMs: 1_700_000_060_000,
          },
        },
        {
          namespace: 'client-state:sessions',
          key: `${keyPrefix}:principal=bob:instance=browser:session=s3`,
          value: {
            status: 'disconnected',
            principalId: 'bob',
            presenceState: 'offline',
            expiresAtEpochMs: 1_700_000_060_000,
            disconnectedAtEpochMs: 1_700_000_000_000,
          },
        },
        {
          namespace: 'group-state:groups',
          key: `${keyPrefix}:group=room-1`,
          value: { status: 'active' },
        },
        {
          namespace: 'group-state:groups',
          key: `${keyPrefix}:group=room-2`,
          value: { status: 'archived' },
        },
        {
          namespace: 'group-state:members',
          key: `${keyPrefix}:group=room-1:member=alice`,
          value: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            status: 'active',
            principalId: 'alice',
          },
        },
        {
          namespace: 'group-state:members',
          key: `${keyPrefix}:group=room-1:member=bob`,
          value: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            status: 'removed',
            principalId: 'bob',
          },
        },
        {
          namespace: 'group-state:sessions',
          key: `${keyPrefix}:group=room-1:session=s1`,
          value: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            principalId: 'alice',
            expiresAtEpochMs: 1_700_000_060_000,
          },
        },
        {
          namespace: 'group-state:sessions',
          key: `${keyPrefix}:group=room-1:session=s2`,
          value: {
            principalId: 'bob',
            expiresAtEpochMs: 1_700_000_060_000,
            disconnectedAtEpochMs: 1_700_000_000_000,
          },
        },
      ] as const
    ) {
      await insertRuntimeState(sql, input);
    }

    const reader = new PSqlAdminOperationsStatsReader(sql, {
      now: () => 1_700_000_000_000,
    });

    const state = await reader.readState({
      adminSession: createAdminSession(),
      scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
    });

    assert.equal(state.clients.totalPrincipals, 1);
    assert.equal(state.clients.onlinePrincipals, 1);
    assert.equal(state.clients.activeSessions, 2);
    assert.equal(state.groups.activeGroups, 1);
    assert.equal(state.groups.totalActiveMembers, 1);
    assert.equal(state.groups.onlineMembers, 1);
  });
});

Deno.test('PSqlAdminOperationsStatsReader excludes expired retained sessions from active counts', async () => {
  await withPGliteSql(async (sql) => {
    const keyPrefix = 'app=app-1:ws=workspace-1';
    for (
      const input of [
        {
          namespace: 'client-state:sessions',
          key: `${keyPrefix}:principal=alice:instance=browser:session=active`,
          value: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            status: 'active',
            principalId: 'alice',
            expiresAtEpochMs: 1_700_000_060_000,
          },
        },
        {
          namespace: 'client-state:sessions',
          key: `${keyPrefix}:principal=bob:instance=browser:session=expired`,
          value: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            status: 'active',
            principalId: 'bob',
            expiresAtEpochMs: 1_699_999_999_000,
          },
        },
        {
          namespace: 'group-state:members',
          key: `${keyPrefix}:group=room-1:member=alice`,
          value: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            status: 'active',
            principalId: 'alice',
          },
        },
        {
          namespace: 'group-state:members',
          key: `${keyPrefix}:group=room-1:member=bob`,
          value: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            status: 'active',
            principalId: 'bob',
          },
        },
        {
          namespace: 'group-state:sessions',
          key: `${keyPrefix}:group=room-1:session=active`,
          value: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            principalId: 'alice',
            expiresAtEpochMs: 1_700_000_060_000,
          },
        },
        {
          namespace: 'group-state:sessions',
          key: `${keyPrefix}:group=room-1:session=expired`,
          value: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            principalId: 'bob',
            expiresAtEpochMs: 1_699_999_999_000,
          },
        },
      ] as const
    ) {
      await insertRuntimeState(sql, input);
    }

    const reader = new PSqlAdminOperationsStatsReader(sql, {
      now: () => 1_700_000_000_000,
    });

    const state = await reader.readState({
      adminSession: createAdminSession(),
      scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
    });

    assert.equal(state.clients.onlinePrincipals, 1);
    assert.equal(state.clients.activeSessions, 1);
    assert.equal(state.groups.onlineMembers, 1);
  });
});

Deno.test('PSqlAdminOperationsStatsReader keeps online identity scoped globally', async () => {
  await withPGliteSql(async (sql) => {
    for (
      const input of [
        {
          namespace: 'client-state:sessions',
          key: 'app=app-1:ws=workspace-1:principal=sam:instance=browser:session=s1',
          value: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            status: 'active',
            principalId: 'sam',
            expiresAtEpochMs: 1_700_000_060_000,
          },
        },
        {
          namespace: 'client-state:sessions',
          key: 'app=app-2:ws=workspace-2:principal=sam:instance=browser:session=s2',
          value: {
            applicationId: 'app-2',
            workspaceId: 'workspace-2',
            status: 'active',
            principalId: 'sam',
            expiresAtEpochMs: 1_700_000_060_000,
          },
        },
        {
          namespace: 'group-state:members',
          key: 'app=app-1:ws=workspace-1:group=room-1:member=sam',
          value: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            status: 'active',
            principalId: 'sam',
          },
        },
        {
          namespace: 'group-state:members',
          key: 'app=app-1:ws=workspace-1:group=room-2:member=sam',
          value: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-2',
            status: 'active',
            principalId: 'sam',
          },
        },
        {
          namespace: 'group-state:sessions',
          key: 'app=app-1:ws=workspace-1:group=room-1:session=s1',
          value: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            principalId: 'sam',
            expiresAtEpochMs: 1_700_000_060_000,
          },
        },
      ] as const
    ) {
      await insertRuntimeState(sql, input);
    }

    const reader = new PSqlAdminOperationsStatsReader(sql, {
      now: () => 1_700_000_000_000,
    });

    const state = await reader.readState({
      adminSession: createAdminSession(),
    });

    assert.equal(state.clients.onlinePrincipals, 2);
    assert.equal(state.clients.activeSessions, 2);
    assert.equal(state.groups.totalActiveMembers, 2);
    assert.equal(state.groups.onlineMembers, 1);
  });
});

Deno.test('PSqlAdminOperationsStatsReader keeps colon-bearing identities distinct globally', async () => {
  await withPGliteSql(async (sql) => {
    for (
      const input of [
        {
          applicationId: 'app',
          workspaceId: 'workspace:blue',
          principalId: 'sam',
          sessionId: 's1',
        },
        {
          applicationId: 'app:workspace',
          workspaceId: 'blue',
          principalId: 'sam',
          sessionId: 's2',
        },
      ] as const
    ) {
      const keyPrefix = `app=${encodeURIComponent(input.applicationId)}:ws=${
        encodeURIComponent(input.workspaceId)
      }`;
      await insertRuntimeState(sql, {
        namespace: 'client-state:sessions',
        key: `${keyPrefix}:principal=${
          encodeURIComponent(input.principalId)
        }:instance=browser:session=${input.sessionId}`,
        value: {
          applicationId: input.applicationId,
          workspaceId: input.workspaceId,
          status: 'active',
          principalId: input.principalId,
          expiresAtEpochMs: 1_700_000_060_000,
        },
      });
    }

    const reader = new PSqlAdminOperationsStatsReader(sql, {
      now: () => 1_700_000_000_000,
    });

    const state = await reader.readState({
      adminSession: createAdminSession(),
    });

    assert.equal(state.clients.onlinePrincipals, 2);
    assert.equal(state.clients.activeSessions, 2);
  });
});

Deno.test('PSqlAdminOperationsStatsReader fails closed on corrupt global group rows', async () => {
  await withPGliteSql(async (sql) => {
    await insertRawRuntimeState(sql, {
      namespace: 'group-state:members',
      key: 'app=ops-global-corrupt:ws=_:group=room:member=alice',
      value: {
        applicationId: 'ops-global-corrupt',
        workspaceId: '_',
        groupId: 'room',
        principalId: 'alice',
        status: 'active',
      },
    });
    const reader = new PSqlAdminOperationsStatsReader(sql, {
      now: () => 1_700_000_000_000,
    });

    await assert.rejects(
      () => reader.readState({ adminSession: createAdminSession() }),
      (error) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'admin-operations-state-invariant-corruption',
    );
  });
});

Deno.test('PSqlAdminOperationsStatsReader rejects global noncanonical group keys', async () => {
  for (
    const input of [
      {
        namespace: 'group-state:groups',
        key: 'app=ops-global-alias:ws=workspace:group=%72oom',
        value: {
          applicationId: 'ops-global-alias',
          workspaceId: 'workspace',
          groupId: 'room',
          status: 'active',
        },
      },
      {
        namespace: 'group-state:members',
        key: 'app=ops-global-alias:ws=workspace:group=room:member=%61lice',
        value: {
          applicationId: 'ops-global-alias',
          workspaceId: 'workspace',
          groupId: 'room',
          principalId: 'alice',
          status: 'active',
        },
      },
      {
        namespace: 'group-state:sessions',
        key: 'app=ops-global-alias:ws=workspace:group=room:session=%73ession',
        value: {
          applicationId: 'ops-global-alias',
          workspaceId: 'workspace',
          groupId: 'room',
          sessionId: 'session',
          principalId: 'alice',
          expiresAtEpochMs: 1_700_000_060_000,
        },
      },
    ] as const
  ) {
    await withPGliteSql(async (sql) => {
      await sql`
        insert into runtime_state_store (
          store_namespace, store_key, store_value, expire_at_ts
        ) values (
          ${input.namespace}, ${input.key}, ${JSON.stringify(input.value)},
          ${new Date('9999-12-31T23:59:59Z')}
        )
      `;
      const reader = new PSqlAdminOperationsStatsReader(sql, {
        now: () => 1_700_000_000_000,
      });

      await assert.rejects(
        () => reader.readState({ adminSession: createAdminSession() }),
        (error) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'admin-operations-state-invariant-corruption',
      );
    });
  }
});

Deno.test('PSqlAdminOperationsStatsReader distinguishes absent and explicit sentinel workspaces globally', async () => {
  await withPGliteSql(async (sql) => {
    await insertRuntimeState(sql, {
      namespace: 'group-state:members',
      key: 'app=ops-global-sentinel:ws=_:group=room:member=alice',
      value: { status: 'active' },
    });
    await insertRuntimeState(sql, {
      namespace: 'group-state:sessions',
      key: 'app=ops-global-sentinel:ws=%5F:group=room:session=explicit-session',
      value: {
        principalId: 'alice',
        expiresAtEpochMs: 1_700_000_060_000,
      },
    });
    const reader = new PSqlAdminOperationsStatsReader(sql, {
      now: () => 1_700_000_000_000,
    });

    const state = await reader.readState({ adminSession: createAdminSession() });

    assert.equal(state.groups.totalActiveMembers, 1);
    assert.equal(state.groups.onlineMembers, 0);
  });
});

Deno.test('PSqlAdminOperationsStatsReader validates the three global group row families', async () => {
  await withPGliteSql(async (sql) => {
    const guard = createRuntimeJsonScanGuard(sql);
    const reader = new PSqlAdminOperationsStatsReader(guard.guardedSql, {
      now: () => 1_700_000_000_000,
    });

    await reader.readState({ adminSession: createAdminSession() });

    assert.equal(guard.runtimeJsonScanCount, 3);
  });
});

Deno.test('PSqlAdminOperationsPruner counts and deletes only expired supported rows', async () => {
  await withPGliteSql(async (sql) => {
    await seedAdminOperationsRows(sql);
    const pruner = new PSqlAdminOperationsPruner(sql);
    const cutoff = { cutoffEpochMs: Date.now() };
    assert.equal(await pruner.countExpired('runtime-state', cutoff), 2);
    assert.equal(await pruner.countExpired('resource-inbox', cutoff), 1);
    assert.equal(await pruner.countExpired('resource-inbox-results', cutoff), 1);
    assert.equal(
      await pruner.countExpired('app-data', {
        ...cutoff, appData: { namespace: 'app-ns', storeName: 'settings' },
      }),
      1,
    );

    assert.equal(await pruner.pruneExpired('runtime-state', cutoff), 2);
    assert.equal(await pruner.pruneExpired('resource-inbox', cutoff), 1);
    assert.equal(await pruner.pruneExpired('resource-inbox-results', cutoff), 1);
    assert.equal(
      await pruner.pruneExpired('app-data', {
        ...cutoff, appData: { namespace: 'app-ns', storeName: 'settings' },
      }),
      1,
    );

    assert.equal(await pruner.countExpired('runtime-state', cutoff), 0);
    assert.equal(await pruner.countExpired('resource-inbox', cutoff), 0);
    assert.equal(await pruner.countExpired('resource-inbox-results', cutoff), 0);
    assert.equal(
      await pruner.countExpired('app-data', {
        ...cutoff, appData: { namespace: 'app-ns', storeName: 'settings' },
      }),
      0,
    );
  });
});

async function seedAdminOperationsRows(sql: PGliteSql): Promise<void> {
  await sql`
    insert into resource_inbox (
      ri_resource_id, ri_topic_id, ri_resource, ri_type_id, ri_status,
      fk_ext_bank_id, system_date, created_by, created_ts, start_ts, expire_ts
    )
    values
      (${'ri-1'}, ${'topic-1'}, ${'payload'}, ${'WS_INBOX'}, ${'PENDING'},
       ${'bank-1'}, ${'2026-07-08'}, ${'test'}, ${new Date('2026-07-08T10:00:00Z')},
       ${null}, ${new Date('9999-12-31T23:59:59Z')}),
      (${'ri-2'}, ${'topic-2'}, ${'payload'}, ${'WS_OUTBOX'}, ${'RESERVED'},
       ${'bank-2'}, ${'2026-07-08'}, ${'test'}, ${new Date('2026-07-08T10:00:00Z')},
       ${new Date('2026-07-08T10:01:00Z')}, ${new Date('2000-01-01T00:00:00Z')}),
      (${'ri-3'}, ${'app-outbox.rtc-topology'}, ${'payload'}, ${'APP_OUTBOX'}, ${'PENDING'},
       ${'bank-3'}, ${'2026-07-08'}, ${'test'}, ${new Date('2026-07-08T10:00:00Z')},
       ${null}, ${new Date('9999-12-31T23:59:59Z')})
  `;

  await sql`
    insert into resource_inbox_results (
      ris_resource_id, ris_topic_id, ris_resource, ris_type_id, ris_status,
      fk_ext_bank_id, system_date, created_by, created_ts, expire_ts
    )
    values
      (${'ris-1'}, ${'topic-1'}, ${'payload'}, ${'APP_INBOX'}, ${'COMPLETED'},
       ${'bank-1'}, ${'2026-07-08'}, ${'test'}, ${new Date('2026-07-08T10:00:00Z')},
       ${new Date('9999-12-31T23:59:59Z')}),
      (${'ris-2'}, ${'topic-2'}, ${'payload'}, ${'APP_INBOX'}, ${'FAILED'},
       ${'bank-2'}, ${'2026-07-08'}, ${'test'}, ${new Date('2026-07-08T10:00:00Z')},
       ${new Date('2000-01-01T00:00:00Z')})
  `;

  for (
    const [namespace, key, value, expireAt] of [
      [
        'client-state:principals',
        'app=app-1:ws=workspace-1:principal=alice',
        { status: 'active' },
        '9999-12-31T23:59:59Z',
      ],
      [
        'client-state:sessions',
        'app=app-1:ws=workspace-1:principal=alice:instance=browser:session=s1',
        {
          applicationId: 'app-1',
          workspaceId: 'workspace-1',
          status: 'active',
          principalId: 'alice',
          presenceState: 'online',
          expiresAtEpochMs: 1_700_000_060_000,
        },
        '9999-12-31T23:59:59Z',
      ],
      [
        'client-state:sessions',
        'app=app-1:ws=workspace-1:principal=bob:instance=browser:session=s2',
        { status: 'expired', principalId: 'bob', presenceState: 'offline' },
        '2000-01-01T00:00:00Z',
      ],
      [
        'group-state:groups',
        'app=app-1:ws=workspace-1:group=room-1',
        { status: 'active' },
        '9999-12-31T23:59:59Z',
      ],
      [
        'group-state:members',
        'app=app-1:ws=workspace-1:group=room-1:member=alice',
        {
          applicationId: 'app-1',
          workspaceId: 'workspace-1',
          groupId: 'room-1',
          status: 'active',
          principalId: 'alice',
        },
        '9999-12-31T23:59:59Z',
      ],
      [
        'group-state:sessions',
        'app=app-1:ws=workspace-1:group=room-1:session=s1',
        {
          applicationId: 'app-1',
          workspaceId: 'workspace-1',
          groupId: 'room-1',
          principalId: 'alice',
          expiresAtEpochMs: 1_700_000_060_000,
        },
        '9999-12-31T23:59:59Z',
      ],
      ['admin-test:expired', 'expired-key', {}, '2000-01-01T00:00:00Z'],
    ] as const
  ) {
    await insertRuntimeState(sql, {
      namespace,
      key,
      value,
      expireAt,
    });
  }

  await sql`
    insert into client_state_events (
      application_id, workspace_key, principal_id, event_id, event_type,
      snapshot_version, occurred_at_epoch_ms, event_json
    )
    values (${'app-1'}, ${'workspace-1'}, ${'alice'}, ${'ce-1'}, ${'session-connected'}, ${1}, ${1_700_000_000_000}, ${'{}'})
  `;

  await sql`
    insert into group_state_events (
      application_id, workspace_key, group_id, event_id, event_type,
      snapshot_version, occurred_at_epoch_ms, event_json
    )
    values (${'app-1'}, ${'workspace-1'}, ${'room-1'}, ${'ge-1'}, ${'session-connected'}, ${1}, ${1_700_000_000_000}, ${'{}'})
  `;

  await sql`
    insert into app_data_store (
      app_namespace, store_name, data_key, data_value, expire_at_ts
    )
    values
      (${'app-ns'}, ${'settings'}, ${'active'}, ${'{}'}, ${new Date('9999-12-31T23:59:59Z')}),
      (${'app-ns'}, ${'settings'}, ${'expired'}, ${'{}'}, ${new Date('2000-01-01T00:00:00Z')})
  `;

  await sql`
    insert into crdt_documents (
      document_key, application_id, workspace_id, document_scope, document_type,
      document_id, document_ref, lifecycle, update_count, snapshot_count,
      stored_update_bytes
    )
    values (
      ${'doc-key-1'}, ${'app-1'}, ${'workspace-1'}, ${'room'}, ${'map'},
      ${'doc-1'}, ${'{}'}, ${'active'}, ${3}, ${1}, ${42}
    )
  `;
}

async function insertResourceInbox(
  sql: PGliteSql,
  input: Readonly<{
    id: string;
    typeId: string;
    status: string;
  }>,
): Promise<void> {
  await sql`
    insert into resource_inbox (
      ri_resource_id, ri_topic_id, ri_resource, ri_type_id, ri_status,
      fk_ext_bank_id, system_date, created_by, created_ts, expire_ts
    )
    values (
      ${`ri-${input.id}`},
      ${`topic-${input.id}`},
      ${'payload'},
      ${input.typeId},
      ${input.status},
      ${'bank-1'},
      ${'2026-07-08'},
      ${'test'},
      ${new Date('2026-07-08T10:00:00Z')},
      ${new Date('9999-12-31T23:59:59Z')}
    )
  `;
}

async function insertResourceInboxResult(
  sql: PGliteSql,
  input: Readonly<{
    id: string;
    typeId: string;
    status: string;
  }>,
): Promise<void> {
  await sql`
    insert into resource_inbox_results (
      ris_resource_id, ris_topic_id, ris_resource, ris_type_id, ris_status,
      fk_ext_bank_id, system_date, created_by, created_ts, expire_ts
    )
    values (
      ${`ris-${input.id}`},
      ${`topic-${input.id}`},
      ${'payload'},
      ${input.typeId},
      ${input.status},
      ${'bank-1'},
      ${'2026-07-08'},
      ${'test'},
      ${new Date('2026-07-08T10:00:00Z')},
      ${new Date('9999-12-31T23:59:59Z')}
    )
  `;
}

async function insertRuntimeState(
  sql: PGliteSql,
  input: Readonly<{
    namespace: string;
    key: string;
    value: unknown;
    expireAt?: string;
  }>,
): Promise<void> {
  const value = withCanonicalRuntimeIdentity(
    input.namespace,
    input.key,
    input.value,
  );
  await sql`
    insert into runtime_state_store (store_namespace, store_key, store_value, expire_at_ts)
    values (
      ${input.namespace},
      ${input.key},
      ${JSON.stringify(value)},
      ${new Date(input.expireAt ?? '9999-12-31T23:59:59Z')}
    )
  `;
}

async function insertRawRuntimeState(
  sql: PGliteSql,
  input: Readonly<{
    namespace: string;
    key: string;
    value: unknown;
    expireAt?: string;
  }>,
): Promise<void> {
  await sql`
    insert into runtime_state_store (store_namespace, store_key, store_value, expire_at_ts)
    values (
      ${input.namespace},
      ${input.key},
      ${JSON.stringify(input.value)},
      ${new Date(input.expireAt ?? '9999-12-31T23:59:59Z')}
    )
  `;
}

const CANONICAL_AUDIT = Object.freeze({
  atEpochMs: 1_700_000_000_000,
  actor: Object.freeze({
    kind: 'principal',
    principalId: 'admin-test-owner',
  }),
  reason: null,
  traceId: null,
  requestId: 'admin-test-request',
});

function canonicalGroupRuntimeValue(
  key: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const identity = decodeGroupStateGroupStorageKey(key);
  const value: Record<string, unknown> = {
    ...identity,
    slug: null,
    displayName: identity.groupId,
    description: null,
    kind: 'room',
    status: 'active',
    joinMode: 'open',
    maxMembers: null,
    maxSessionsPerMember: null,
    metadata: {},
    activeMemberCount: 1,
    ownerPrincipalId: 'admin-test-owner',
    snapshotVersion: 1,
    metadataVersion: 1,
    rosterVersion: 1,
    presenceVersion: 0,
    created: CANONICAL_AUDIT,
    updated: CANONICAL_AUDIT,
    archived: null,
    deleted: null,
    expiresAtEpochMs: null,
    emptySinceEpochMs: null,
    purgeAfterEpochMs: null,
    ...overrides,
  };
  if (value.status === 'archived' && !Object.hasOwn(overrides, 'archived')) {
    value.archived = CANONICAL_AUDIT;
  }
  if (value.status === 'deleted' && !Object.hasOwn(overrides, 'deleted')) {
    value.deleted = CANONICAL_AUDIT;
  }
  return value;
}

function canonicalMemberRuntimeValue(
  key: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const value: Record<string, unknown> = {
    ...decodeGroupStateMemberStorageKey(key),
    role: 'member',
    status: 'active',
    joined: CANONICAL_AUDIT,
    updated: CANONICAL_AUDIT,
    left: null,
    removed: null,
    banned: null,
    invitedByPrincipalId: null,
    invitationExpiresAtEpochMs: null,
    ...overrides,
  };
  if (value.status === 'invited' && !Object.hasOwn(overrides, 'joined')) value.joined = null;
  if (value.status === 'left' && !Object.hasOwn(overrides, 'left')) {
    value.left = CANONICAL_AUDIT;
  }
  if (value.status === 'removed' && !Object.hasOwn(overrides, 'removed')) {
    value.removed = CANONICAL_AUDIT;
  }
  if (value.status === 'banned' && !Object.hasOwn(overrides, 'banned')) {
    value.banned = CANONICAL_AUDIT;
  }
  return value;
}

function canonicalSessionRuntimeValue(
  key: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const identity = decodeGroupStatePresenceSessionStorageKey(key);
  const requestedExpiry = overrides.expiresAtEpochMs;
  const connectedAtEpochMs = typeof requestedExpiry === 'number' && requestedExpiry > 1_000
    ? Math.min(1_700_000_000_000, requestedExpiry - 1_000)
    : 1_700_000_000_000;
  const value: Record<string, unknown> = {
    ...identity,
    principalId: 'admin-test-owner',
    generationId: `${identity.sessionId}-generation`,
    generationVersion: connectedAtEpochMs,
    status: 'active',
    connectedAtEpochMs,
    lastHeartbeatAtEpochMs: connectedAtEpochMs,
    expiresAtEpochMs: connectedAtEpochMs + 60_000,
    disconnectedAtEpochMs: null,
    disconnectReason: null,
    ...overrides,
  };
  if (
    value.disconnectedAtEpochMs !== null &&
    !Object.hasOwn(overrides, 'status')
  ) {
    value.status = 'disconnected';
  }
  if (
    value.disconnectedAtEpochMs !== null &&
    !Object.hasOwn(overrides, 'disconnectReason')
  ) {
    value.disconnectReason = 'admin-test-disconnect';
  }
  return value;
}

function withCanonicalRuntimeIdentity(
  namespace: string,
  key: string,
  value: unknown,
): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  const overrides = value as Readonly<Record<string, unknown>>;
  try {
    if (namespace === 'client-state:principals') {
      return { ...decodeClientPrincipalStorageKey(key), ...overrides };
    }
    if (namespace === 'client-state:sessions') {
      return { ...decodeClientSessionStorageKey(key), ...overrides };
    }
  } catch {
    return value;
  }
  return namespace === 'group-state:groups'
    ? canonicalGroupRuntimeValue(key, overrides)
    : namespace === 'group-state:members'
    ? canonicalMemberRuntimeValue(key, overrides)
    : namespace === 'group-state:sessions'
    ? canonicalSessionRuntimeValue(key, overrides)
    : value;
}

function createRuntimeJsonScanGuard(
  sql: PGliteSql,
): Readonly<{ guardedSql: PSqlSql; runtimeJsonScanCount: number }> {
  let runtimeJsonScanCount = 0;
  const guarded = ((
    stringsOrValues: TemplateStringsArray | readonly unknown[],
    ...values: unknown[]
  ) => {
    if ('raw' in stringsOrValues) {
      const queryText = Array.from(stringsOrValues).join('?').toLowerCase();
      if (
        queryText.includes('select store_key, store_value') &&
        queryText.includes('from runtime_state_store') &&
        values.some(
          (value) => typeof value === 'string' && value.startsWith('group-state:'),
        )
      ) {
        runtimeJsonScanCount += 1;
      }
      return sql(stringsOrValues, ...values);
    }
    return sql(stringsOrValues);
  }) as PSqlSql;
  guarded.begin = sql.begin;
  return {
    guardedSql: guarded,
    get runtimeJsonScanCount() {
      return runtimeJsonScanCount;
    },
  };
}

function createAdminSession() {
  return {
    clientId: 'platform-admin',
    username: 'admin',
    accessToken: 'access-token',
    sessionId: 'admin-session',
    expiresAtEpochMs: 1_700_000_060_000,
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
