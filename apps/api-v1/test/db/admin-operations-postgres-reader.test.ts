import assert from 'node:assert/strict';
import {
  PSqlAdminOperationsPruner,
  PSqlAdminOperationsStatsReader,
} from '@shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
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
    assert.equal(queues.queueRows.total, 2);
    assert.equal(queues.queueRows.expired, 1);
    assert.deepEqual(queues.queueRows.byTypeStatus, [
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

Deno.test('PSqlAdminOperationsStatsReader excludes malformed group expiries in both scopes', async () => {
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
          `${keyPrefix}:group=string-expiry`,
          { status: 'active', expiresAtEpochMs: 'not-an-epoch' },
        ],
        [
          `${keyPrefix}:group=object-expiry`,
          { status: 'active', expiresAtEpochMs: { value: nowEpochMs + 1 } },
        ],
      ] as const
    ) {
      await insertRuntimeState(sql, {
        namespace: 'group-state:groups',
        key,
        value,
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
          key: `${keyPrefix}:group=room-1:principal=alice`,
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
          key: `${keyPrefix}:group=room-1:principal=bob`,
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
          key: `${keyPrefix}:group=room-1:principal=alice`,
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
          key: `${keyPrefix}:group=room-1:principal=bob`,
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
          key: 'app=app-1:ws=workspace-1:group=room-1:principal=sam',
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
          key: 'app=app-1:ws=workspace-1:group=room-2:principal=sam',
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

Deno.test('PSqlAdminOperationsStatsReader avoids unbounded global runtime JSON scans', async () => {
  await withPGliteSql(async (sql) => {
    const guard = createRuntimeJsonScanGuard(sql);
    const reader = new PSqlAdminOperationsStatsReader(guard.guardedSql, {
      now: () => 1_700_000_000_000,
    });

    await reader.readState({ adminSession: createAdminSession() });

    assert.equal(guard.runtimeJsonScanCount, 0);
  });
});

Deno.test('PSqlAdminOperationsPruner counts and deletes only expired supported rows', async () => {
  await withPGliteSql(async (sql) => {
    await seedAdminOperationsRows(sql);
    const pruner = new PSqlAdminOperationsPruner(sql);

    assert.equal(await pruner.countExpired('runtime-state', {}), 2);
    assert.equal(await pruner.countExpired('resource-inbox', {}), 1);
    assert.equal(await pruner.countExpired('resource-inbox-results', {}), 1);
    assert.equal(
      await pruner.countExpired('app-data', {
        appData: { namespace: 'app-ns', storeName: 'settings' },
      }),
      1,
    );

    assert.equal(await pruner.pruneExpired('runtime-state', {}), 2);
    assert.equal(await pruner.pruneExpired('resource-inbox', {}), 1);
    assert.equal(await pruner.pruneExpired('resource-inbox-results', {}), 1);
    assert.equal(
      await pruner.pruneExpired('app-data', {
        appData: { namespace: 'app-ns', storeName: 'settings' },
      }),
      1,
    );

    assert.equal(await pruner.countExpired('runtime-state', {}), 0);
    assert.equal(await pruner.countExpired('resource-inbox', {}), 0);
    assert.equal(await pruner.countExpired('resource-inbox-results', {}), 0);
    assert.equal(
      await pruner.countExpired('app-data', {
        appData: { namespace: 'app-ns', storeName: 'settings' },
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
       ${new Date('2026-07-08T10:01:00Z')}, ${new Date('2000-01-01T00:00:00Z')})
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
        'app=app-1:ws=workspace-1:principal=alice:session=s1',
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
        'app=app-1:ws=workspace-1:principal=bob:session=s2',
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
        'app=app-1:ws=workspace-1:group=room-1:principal=alice',
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
        queryText.includes('from runtime_state_store')
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
