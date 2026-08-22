import { PSqlAdminOperationsStatsReader } from '@shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts';
import assert from 'node:assert/strict';
import {
    canonicalGroupRuntimeValue,
    canonicalMemberRuntimeValue,
    canonicalSessionRuntimeValue,
    createAdminSession,
    insertRawRuntimeState,
    insertResourceInbox,
    insertResourceInboxResult,
    insertRuntimeState,
    seedAdminOperationsRows,
    withPGliteSql
} from './admin-operations-postgres-test-runtime.ts';

Deno.test('PSqlAdminOperationsStatsReader aggregates admin read statistics', async () => {
    await withPGliteSql(async (sql) => {
        await seedAdminOperationsRows(sql);
        const reader = new PSqlAdminOperationsStatsReader(sql, {
            now: () => 1_700_000_000_000,
            serverId: 'test-server',
            sqlBackend: 'pglite-memory',
            dbPubSub: 'local'
        });

        const queues = await reader.readQueues({ adminSession: createAdminSession() });
        assert.equal(queues.queueRows.total, 3);
        assert.equal(queues.queueRows.expired, 1);
        assert.deepEqual(queues.queueRows.byTypeStatus, [
            { typeId: 'APP_OUTBOX', status: 'PENDING', count: 1 },
            { typeId: 'WS_INBOX', status: 'PENDING', count: 1 },
            { typeId: 'WS_OUTBOX', status: 'RESERVED', count: 1 }
        ]);
        assert.equal(queues.resultRows.total, 2);
        assert.equal(queues.resultRows.expired, 1);

        const state = await reader.readState({
            adminSession: createAdminSession(),
            scope: { applicationId: 'app-1', workspaceId: 'workspace-1' }
        });
        assert.equal(state.clients.totalPrincipals, 1);
        assert.equal(state.clients.activeSessions, 1);
        assert.equal(state.groups.activeGroups, 1);
        assert.equal(state.groups.onlineMembers, 1);
        assert.equal(state.events.recentClientEvents, 1);
        assert.equal(state.events.recentGroupEvents, 1);

        const crdt = await reader.readCrdt({
            adminSession: createAdminSession(),
            scope: { applicationId: 'app-1', workspaceId: 'workspace-1' }
        });
        assert.equal(crdt.documents.total, 1);
        assert.deepEqual(crdt.documents.byLifecycle, [
            { status: 'active', count: 1 }
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
            dbPubSub: 'local'
        });
    });
});

Deno.test('admin stats bound recent events and expire active groups logically', async () => {
    await withPGliteSql(async (sql) => {
        const nowEpochMs = 1_700_000_000_000;
        const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };
        const keyPrefix = 'app=app-1:ws=workspace-1';

        for (
            const [key, value] of [
                [`${keyPrefix}:group=no-expiry`, { status: 'active' }],
                [
                    `${keyPrefix}:group=future-expiry`,
                    { status: 'active', expiresAtEpochMs: nowEpochMs + 1 }
                ],
                [
                    `${keyPrefix}:group=expired-now`,
                    { status: 'active', expiresAtEpochMs: nowEpochMs }
                ]
            ] as const
        ) {
            await insertRuntimeState(sql, {
                namespace: 'group-state:groups',
                key,
                value
            });
        }

        await sql`
      insert into client_state_events (
        application_id, workspace_key, principal_id, event_id, event_type,
        snapshot_version, occurred_at_epoch_ms, event_json
      )
      values
        (
          ${'app-1'}, ${'workspace-1'}, ${'alice'}, ${'client-old'},
          ${'connected'}, ${1}, ${1_699_999_099_999}, ${'{}'}
        ),
        (
          ${'app-1'}, ${'workspace-1'}, ${'alice'}, ${'client-boundary'},
          ${'connected'}, ${1}, ${1_699_999_100_000}, ${'{}'}
        )
    `;
        await sql`
      insert into group_state_events (
        application_id, workspace_key, group_id, event_id, event_type,
        snapshot_version, occurred_at_epoch_ms, event_json
      )
      values
        (
          ${'app-1'}, ${'workspace-1'}, ${'room-1'}, ${'group-old'},
          ${'connected'}, ${1}, ${1_699_999_099_999}, ${'{}'}
        ),
        (
          ${'app-1'}, ${'workspace-1'}, ${'room-1'}, ${'group-boundary'},
          ${'connected'}, ${1}, ${1_699_999_100_000}, ${'{}'}
        )
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

Deno.test('admin stats fail closed on contract violations in both scopes', async () => {
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
                value: missingUpdated
            },
            {
                label: 'wrong group discriminant primitive',
                namespace: 'group-state:groups',
                key: `${keyPrefix}:group=wrong-status`,
                value: canonicalGroupRuntimeValue(`${keyPrefix}:group=wrong-status`, { status: 1 })
            },
            {
                label: 'missing group expiry',
                namespace: 'group-state:groups',
                key: `${keyPrefix}:group=missing-expiry`,
                value: missingExpiry
            },
            {
                label: 'wrong member role primitive',
                namespace: 'group-state:members',
                key: `${keyPrefix}:group=room:member=alice`,
                value: canonicalMemberRuntimeValue(`${keyPrefix}:group=room:member=alice`, { role: 2 })
            },
            {
                label: 'session heartbeat after expiry',
                namespace: 'group-state:sessions',
                key: `${keyPrefix}:group=room:session=session-a`,
                value: canonicalSessionRuntimeValue(`${keyPrefix}:group=room:session=session-a`, {
                    lastHeartbeatAtEpochMs: nowEpochMs + 2_000,
                    expiresAtEpochMs: nowEpochMs + 1_000
                })
            }
        ] as const
    ) {
        await withPGliteSql(async (sql) => {
            await insertRawRuntimeState(sql, input);
            const reader = new PSqlAdminOperationsStatsReader(sql, { now: () => nowEpochMs });
            for (
                const read of [
                    () => reader.readState({ adminSession: createAdminSession() }),
                    () => reader.readState({ adminSession: createAdminSession(), scope })
                ]
            ) {
                await assert.rejects(
                    read,
                    (error) =>
                        error instanceof Error &&
                        'code' in error &&
                        error.code === 'admin-operations-state-invariant-corruption',
                    input.label
                );
            }
        });
    }
});

Deno.test('admin stats count canonical group expiries in both scopes', async () => {
    await withPGliteSql(async (sql) => {
        const nowEpochMs = 1_700_000_000_000;
        const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };
        const keyPrefix = 'app=app-1:ws=workspace-1';
        for (
            const [groupId, expiresAtEpochMs] of [
                ['no-expiry', undefined],
                ['future-expiry', nowEpochMs + 1],
                ['expired-now', nowEpochMs]
            ] as const
        ) {
            const key = `${keyPrefix}:group=${groupId}`;
            await insertRawRuntimeState(sql, {
                namespace: 'group-state:groups',
                key,
                value: canonicalGroupRuntimeValue(key, {
                    expiresAtEpochMs: expiresAtEpochMs ?? null
                })
            });
        }
        const reader = new PSqlAdminOperationsStatsReader(sql, { now: () => nowEpochMs });
        const globalState = await reader.readState({ adminSession: createAdminSession() });
        const scopedState = await reader.readState({ adminSession: createAdminSession(), scope });
        assert.equal(globalState.groups.activeGroups, 2);
        assert.equal(scopedState.groups.activeGroups, 2);
    });
});

Deno.test('admin stats apply a custom recent-event window within scope', async () => {
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
        (${'app-1'}, ${'workspace-1'}, ${'alice'}, ${'client-old'}, ${'connected'}, ${1}, ${nowEpochMs - recentEventWindowMs - 1}, ${'{}'}),
        (${'app-1'}, ${'workspace-1'}, ${'alice'}, ${'client-boundary'}, ${'connected'}, ${1}, ${nowEpochMs - recentEventWindowMs}, ${'{}'}),
        (
          ${'app-2'}, ${'workspace-2'}, ${'bob'}, ${'client-decoy'},
          ${'connected'}, ${1}, ${nowEpochMs}, ${'{}'}
        )
    `;
        await sql`
      insert into group_state_events (
        application_id, workspace_key, group_id, event_id, event_type,
        snapshot_version, occurred_at_epoch_ms, event_json
      )
      values
        (${'app-1'}, ${'workspace-1'}, ${'room-1'}, ${'group-old'}, ${'connected'}, ${1}, ${nowEpochMs - recentEventWindowMs - 1}, ${'{}'}),
        (${'app-1'}, ${'workspace-1'}, ${'room-1'}, ${'group-boundary'}, ${'connected'}, ${1}, ${nowEpochMs - recentEventWindowMs}, ${'{}'}),
        (
          ${'app-2'}, ${'workspace-2'}, ${'room-2'}, ${'group-decoy'},
          ${'connected'}, ${1}, ${nowEpochMs}, ${'{}'}
        )
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

Deno.test('admin stats order queue topPressure by descending count', async () => {
    await withPGliteSql(async (sql) => {
        for (
            const input of [
                { id: 'low', typeId: 'AA_LOW', status: 'PENDING' },
                { id: 'high-1', typeId: 'ZZ_HIGH', status: 'PENDING' },
                { id: 'high-2', typeId: 'ZZ_HIGH', status: 'PENDING' },
                { id: 'high-3', typeId: 'ZZ_HIGH', status: 'PENDING' },
                { id: 'mid-1', typeId: 'MM_MID', status: 'RESERVED' },
                { id: 'mid-2', typeId: 'MM_MID', status: 'RESERVED' }
            ] as const
        ) {
            await insertResourceInbox(sql, input);
        }
        for (
            const input of [
                { id: 'low', typeId: 'AA_RESULT', status: 'FAILED' },
                { id: 'high-1', typeId: 'ZZ_RESULT', status: 'COMPLETED' },
                { id: 'high-2', typeId: 'ZZ_RESULT', status: 'COMPLETED' }
            ] as const
        ) {
            await insertResourceInboxResult(sql, input);
        }

        const reader = new PSqlAdminOperationsStatsReader(sql, {
            now: () => 1_700_000_000_000
        });

        const queues = await reader.readQueues({ adminSession: createAdminSession() });

        assert.deepEqual(queues.queueRows.topPressure.slice(0, 3), [
            { typeId: 'ZZ_HIGH', status: 'PENDING', count: 3 },
            { typeId: 'MM_MID', status: 'RESERVED', count: 2 },
            { typeId: 'AA_LOW', status: 'PENDING', count: 1 }
        ]);
        assert.deepEqual(queues.resultRows.topPressure.slice(0, 2), [
            { typeId: 'ZZ_RESULT', status: 'COMPLETED', count: 2 },
            { typeId: 'AA_RESULT', status: 'FAILED', count: 1 }
        ]);
    });
});
