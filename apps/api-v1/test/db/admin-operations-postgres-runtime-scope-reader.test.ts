import { PSqlAdminStateReader } from '@shared-server/rallar-system/admin-operations/postgres/p-sql-admin-state-reader.ts';
import assert from 'node:assert/strict';
import {
    createAdminSession,
    createRuntimeJsonScanGuard,
    insertRawRuntimeState,
    insertRuntimeState,
    withPGliteSql
} from './admin-operations-postgres-test-runtime.ts';

Deno.test('admin state reader uses encoded runtime-state scope keys', async () => {
    await withPGliteSql(async (sql) => {
        const applicationId = 'ops app/1';
        const workspaceId = 'workspace:blue';
        const keyPrefix = `app=${encodeURIComponent(applicationId)}:ws=${encodeURIComponent(workspaceId)}`;
        await insertRuntimeState(sql, {
            namespace: 'client-state:principals',
            key: `${keyPrefix}:principal=alice`,
            value: { status: 'active' }
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
                expiresAtEpochMs: 1_700_000_060_000
            }
        });
        await insertRuntimeState(sql, {
            namespace: 'group-state:groups',
            key: `${keyPrefix}:group=room-1`,
            value: { status: 'active' }
        });

        const reader = new PSqlAdminStateReader(sql, {
            nowEpochMs: () => 1_700_000_000_000
        });

        const state = await reader.execute({
            adminSession: createAdminSession(),
            scope: { applicationId, workspaceId }
        });

        assert.equal(state.clients.totalPrincipals, 1);
        assert.equal(state.clients.onlinePrincipals, 1);
        assert.equal(state.clients.activeSessions, 1);
        assert.equal(state.groups.activeGroups, 1);
    });
});

Deno.test(
    'admin state reader reads the current underscore workspace identity',
    async () => {
        await withPGliteSql(async (sql) => {
            const applicationId = 'ops-sentinel-app';
            await insertRuntimeState(sql, {
                namespace: 'group-state:groups',
                key: `app=${applicationId}:ws=_:group=current-group`,
                value: {
                    applicationId,
                    workspaceId: '_',
                    groupId: 'current-group',
                    status: 'active'
                }
            });
            await sql`
      insert into group_state_events (
        application_id, workspace_key, group_id, event_id, event_type,
        snapshot_version, occurred_at_epoch_ms, event_json
      ) values (
        ${applicationId}, '_', 'current-group', 'current-event',
        'group-updated', 1, 1700000000001,
        ${
                JSON.stringify({
                    applicationId,
                    workspaceId: '_',
                    groupId: 'current-group',
                    eventId: 'current-event'
                })
            }
      )
    `;

            const reader = new PSqlAdminStateReader(sql, {
                nowEpochMs: () => 1_700_000_000_100
            });
            const state = await reader.execute({
                adminSession: createAdminSession(),
                scope: { applicationId, workspaceId: '_' }
            });

            assert.equal(state.groups.activeGroups, 1);
            assert.equal(state.events.recentGroupEvents, 1);
        });
    }
);

Deno.test(
    'admin state reader fails closed on wrong-scope group runtime values',
    async () => {
        await withPGliteSql(async (sql) => {
            const scope = {
                applicationId: 'ops-corrupt-scope-app',
                workspaceId: '_'
            };
            await insertRuntimeState(sql, {
                namespace: 'group-state:groups',
                key: `app=${scope.applicationId}:ws=_:group=corrupt-group`,
                value: {
                    applicationId: scope.applicationId,
                    workspaceId: 'wrong-workspace',
                    groupId: 'corrupt-group',
                    status: 'active'
                }
            });
            const reader = new PSqlAdminStateReader(sql, {
                nowEpochMs: () => 1_700_000_000_100
            });

            await assert.rejects(
                () => reader.execute({ adminSession: createAdminSession(), scope }),
                (error) =>
                    error instanceof Error &&
                    'code' in error &&
                    error.code === 'admin-operations-state-invariant-corruption'
            );
        });
    }
);

Deno.test(
    'admin state reader rejects noncanonical group child-key aliases',
    async () => {
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
                        status: 'active'
                    }
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
                        expiresAtEpochMs: 1_700_000_060_000
                    }
                }
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
                        status: 'active'
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
                const reader = new PSqlAdminStateReader(sql, {
                    nowEpochMs: () => 1_700_000_000_100
                });

                await assert.rejects(
                    () =>
                        reader.execute({
                            adminSession: createAdminSession(),
                            scope: {
                                applicationId: 'ops-alias-app',
                                workspaceId: 'alias-workspace'
                            }
                        }),
                    (error) =>
                        error instanceof Error &&
                        'code' in error &&
                        error.code === 'admin-operations-state-invariant-corruption'
                );
            });
        }
    }
);

Deno.test('admin state reader treats encoded scope prefixes literally', async () => {
    await withPGliteSql(async (sql) => {
        const applicationId = 'ops/app';
        const workspaceId = 'workspace:blue';
        const literalPrefix = `app=${encodeURIComponent(applicationId)}:ws=${encodeURIComponent(workspaceId)}`;
        const wildcardCollisionPrefix = 'app=opsZZ2Fapp:ws=workspaceZZ3Ablue';

        await insertRuntimeState(sql, {
            namespace: 'client-state:principals',
            key: `${literalPrefix}:principal=alice`,
            value: { applicationId, workspaceId, principalId: 'alice', status: 'active' }
        });
        await insertRuntimeState(sql, {
            namespace: 'client-state:principals',
            key: `${wildcardCollisionPrefix}:principal=bob`,
            value: {
                applicationId: 'opsZZ2Fapp',
                workspaceId: 'workspaceZZ3Ablue',
                principalId: 'bob',
                status: 'active'
            }
        });
        await insertRuntimeState(sql, {
            namespace: 'client-state:sessions',
            key: `${literalPrefix}:principal=alice:instance=browser:session=s1`,
            value: {
                applicationId,
                workspaceId,
                status: 'active',
                principalId: 'alice',
                expiresAtEpochMs: 1_700_000_060_000
            }
        });
        await insertRuntimeState(sql, {
            namespace: 'client-state:sessions',
            key: `${wildcardCollisionPrefix}:principal=bob:instance=browser:session=s2`,
            value: {
                applicationId: 'opsZZ2Fapp',
                workspaceId: 'workspaceZZ3Ablue',
                status: 'active',
                principalId: 'bob',
                expiresAtEpochMs: 1_700_000_060_000
            }
        });

        const reader = new PSqlAdminStateReader(sql, {
            nowEpochMs: () => 1_700_000_000_000
        });

        const state = await reader.execute({
            adminSession: createAdminSession(),
            scope: { applicationId, workspaceId }
        });

        assert.equal(state.clients.totalPrincipals, 1);
        assert.equal(state.clients.onlinePrincipals, 1);
        assert.equal(state.clients.activeSessions, 1);
    });
});

Deno.test(
    'admin state reader excludes inactive domain state from active counts',
    async () => {
        await withPGliteSql(async (sql) => {
            const keyPrefix = 'app=app-1:ws=workspace-1';
            for (
                const input of [
                    {
                        namespace: 'client-state:principals',
                        key: `${keyPrefix}:principal=alice`,
                        value: { status: 'active' }
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
                            expiresAtEpochMs: 1_700_000_060_000
                        }
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
                            expiresAtEpochMs: 1_700_000_060_000
                        }
                    },
                    {
                        namespace: 'client-state:sessions',
                        key: `${keyPrefix}:principal=bob:instance=browser:session=s3`,
                        value: {
                            status: 'disconnected',
                            principalId: 'bob',
                            presenceState: 'offline',
                            expiresAtEpochMs: 1_700_000_060_000,
                            disconnectedAtEpochMs: 1_700_000_000_000
                        }
                    },
                    {
                        namespace: 'group-state:groups',
                        key: `${keyPrefix}:group=room-1`,
                        value: { status: 'active' }
                    },
                    {
                        namespace: 'group-state:groups',
                        key: `${keyPrefix}:group=room-2`,
                        value: { status: 'archived' }
                    },
                    {
                        namespace: 'group-state:members',
                        key: `${keyPrefix}:group=room-1:member=alice`,
                        value: {
                            applicationId: 'app-1',
                            workspaceId: 'workspace-1',
                            groupId: 'room-1',
                            status: 'active',
                            principalId: 'alice'
                        }
                    },
                    {
                        namespace: 'group-state:members',
                        key: `${keyPrefix}:group=room-1:member=bob`,
                        value: {
                            applicationId: 'app-1',
                            workspaceId: 'workspace-1',
                            groupId: 'room-1',
                            status: 'removed',
                            principalId: 'bob'
                        }
                    },
                    {
                        namespace: 'group-state:sessions',
                        key: `${keyPrefix}:group=room-1:session=s1`,
                        value: {
                            applicationId: 'app-1',
                            workspaceId: 'workspace-1',
                            groupId: 'room-1',
                            principalId: 'alice',
                            expiresAtEpochMs: 1_700_000_060_000
                        }
                    },
                    {
                        namespace: 'group-state:sessions',
                        key: `${keyPrefix}:group=room-1:session=s2`,
                        value: {
                            principalId: 'bob',
                            expiresAtEpochMs: 1_700_000_060_000,
                            disconnectedAtEpochMs: 1_700_000_000_000
                        }
                    }
                ] as const
            ) {
                await insertRuntimeState(sql, input);
            }

            const reader = new PSqlAdminStateReader(sql, {
                nowEpochMs: () => 1_700_000_000_000
            });

            const state = await reader.execute({
                adminSession: createAdminSession(),
                scope: { applicationId: 'app-1', workspaceId: 'workspace-1' }
            });

            assert.equal(state.clients.totalPrincipals, 1);
            assert.equal(state.clients.onlinePrincipals, 1);
            assert.equal(state.clients.activeSessions, 2);
            assert.equal(state.groups.activeGroups, 1);
            assert.equal(state.groups.totalActiveMembers, 1);
            assert.equal(state.groups.onlineMembers, 1);
        });
    }
);

Deno.test(
    'admin state reader excludes expired retained sessions from active counts',
    async () => {
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
                            expiresAtEpochMs: 1_700_000_060_000
                        }
                    },
                    {
                        namespace: 'client-state:sessions',
                        key: `${keyPrefix}:principal=bob:instance=browser:session=expired`,
                        value: {
                            applicationId: 'app-1',
                            workspaceId: 'workspace-1',
                            status: 'active',
                            principalId: 'bob',
                            expiresAtEpochMs: 1_699_999_999_000
                        }
                    },
                    {
                        namespace: 'group-state:members',
                        key: `${keyPrefix}:group=room-1:member=alice`,
                        value: {
                            applicationId: 'app-1',
                            workspaceId: 'workspace-1',
                            groupId: 'room-1',
                            status: 'active',
                            principalId: 'alice'
                        }
                    },
                    {
                        namespace: 'group-state:members',
                        key: `${keyPrefix}:group=room-1:member=bob`,
                        value: {
                            applicationId: 'app-1',
                            workspaceId: 'workspace-1',
                            groupId: 'room-1',
                            status: 'active',
                            principalId: 'bob'
                        }
                    },
                    {
                        namespace: 'group-state:sessions',
                        key: `${keyPrefix}:group=room-1:session=active`,
                        value: {
                            applicationId: 'app-1',
                            workspaceId: 'workspace-1',
                            groupId: 'room-1',
                            principalId: 'alice',
                            expiresAtEpochMs: 1_700_000_060_000
                        }
                    },
                    {
                        namespace: 'group-state:sessions',
                        key: `${keyPrefix}:group=room-1:session=expired`,
                        value: {
                            applicationId: 'app-1',
                            workspaceId: 'workspace-1',
                            groupId: 'room-1',
                            principalId: 'bob',
                            expiresAtEpochMs: 1_699_999_999_000
                        }
                    }
                ] as const
            ) {
                await insertRuntimeState(sql, input);
            }

            const reader = new PSqlAdminStateReader(sql, {
                nowEpochMs: () => 1_700_000_000_000
            });

            const state = await reader.execute({
                adminSession: createAdminSession(),
                scope: { applicationId: 'app-1', workspaceId: 'workspace-1' }
            });

            assert.equal(state.clients.onlinePrincipals, 1);
            assert.equal(state.clients.activeSessions, 1);
            assert.equal(state.groups.onlineMembers, 1);
        });
    }
);

Deno.test('admin state reader keeps online identity scoped globally', async () => {
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
                        expiresAtEpochMs: 1_700_000_060_000
                    }
                },
                {
                    namespace: 'client-state:sessions',
                    key: 'app=app-2:ws=workspace-2:principal=sam:instance=browser:session=s2',
                    value: {
                        applicationId: 'app-2',
                        workspaceId: 'workspace-2',
                        status: 'active',
                        principalId: 'sam',
                        expiresAtEpochMs: 1_700_000_060_000
                    }
                },
                {
                    namespace: 'group-state:members',
                    key: 'app=app-1:ws=workspace-1:group=room-1:member=sam',
                    value: {
                        applicationId: 'app-1',
                        workspaceId: 'workspace-1',
                        groupId: 'room-1',
                        status: 'active',
                        principalId: 'sam'
                    }
                },
                {
                    namespace: 'group-state:members',
                    key: 'app=app-1:ws=workspace-1:group=room-2:member=sam',
                    value: {
                        applicationId: 'app-1',
                        workspaceId: 'workspace-1',
                        groupId: 'room-2',
                        status: 'active',
                        principalId: 'sam'
                    }
                },
                {
                    namespace: 'group-state:sessions',
                    key: 'app=app-1:ws=workspace-1:group=room-1:session=s1',
                    value: {
                        applicationId: 'app-1',
                        workspaceId: 'workspace-1',
                        groupId: 'room-1',
                        principalId: 'sam',
                        expiresAtEpochMs: 1_700_000_060_000
                    }
                }
            ] as const
        ) {
            await insertRuntimeState(sql, input);
        }

        const reader = new PSqlAdminStateReader(sql, {
            nowEpochMs: () => 1_700_000_000_000
        });

        const state = await reader.execute({
            adminSession: createAdminSession()
        });

        assert.equal(state.clients.onlinePrincipals, 2);
        assert.equal(state.clients.activeSessions, 2);
        assert.equal(state.groups.totalActiveMembers, 2);
        assert.equal(state.groups.onlineMembers, 1);
    });
});

Deno.test(
    'admin state reader keeps colon-bearing identities distinct globally',
    async () => {
        await withPGliteSql(async (sql) => {
            for (
                const input of [
                    {
                        applicationId: 'app',
                        workspaceId: 'workspace:blue',
                        principalId: 'sam',
                        sessionId: 's1'
                    },
                    {
                        applicationId: 'app:workspace',
                        workspaceId: 'blue',
                        principalId: 'sam',
                        sessionId: 's2'
                    }
                ] as const
            ) {
                const keyPrefix = `app=${encodeURIComponent(input.applicationId)}:ws=${encodeURIComponent(input.workspaceId)}`;
                await insertRuntimeState(sql, {
                    namespace: 'client-state:sessions',
                    key: `${keyPrefix}:principal=${encodeURIComponent(input.principalId)}:instance=browser:session=${input.sessionId}`,
                    value: {
                        applicationId: input.applicationId,
                        workspaceId: input.workspaceId,
                        status: 'active',
                        principalId: input.principalId,
                        expiresAtEpochMs: 1_700_000_060_000
                    }
                });
            }

            const reader = new PSqlAdminStateReader(sql, {
                nowEpochMs: () => 1_700_000_000_000
            });

            const state = await reader.execute({
                adminSession: createAdminSession()
            });

            assert.equal(state.clients.onlinePrincipals, 2);
            assert.equal(state.clients.activeSessions, 2);
        });
    }
);

Deno.test('admin state reader fails closed on corrupt global group rows', async () => {
    await withPGliteSql(async (sql) => {
        await insertRawRuntimeState(sql, {
            namespace: 'group-state:members',
            key: 'app=ops-global-corrupt:ws=_:group=room:member=alice',
            value: {
                applicationId: 'ops-global-corrupt',
                workspaceId: '_',
                groupId: 'room',
                principalId: 'alice',
                status: 'active'
            }
        });
        const reader = new PSqlAdminStateReader(sql, {
            nowEpochMs: () => 1_700_000_000_000
        });

        await assert.rejects(
            () => reader.execute({ adminSession: createAdminSession() }),
            (error) =>
                error instanceof Error &&
                'code' in error &&
                error.code === 'admin-operations-state-invariant-corruption'
        );
    });
});

Deno.test('admin state reader rejects global noncanonical group keys', async () => {
    for (
        const input of [
            {
                namespace: 'group-state:groups',
                key: 'app=ops-global-alias:ws=workspace:group=%72oom',
                value: {
                    applicationId: 'ops-global-alias',
                    workspaceId: 'workspace',
                    groupId: 'room',
                    status: 'active'
                }
            },
            {
                namespace: 'group-state:members',
                key: 'app=ops-global-alias:ws=workspace:group=room:member=%61lice',
                value: {
                    applicationId: 'ops-global-alias',
                    workspaceId: 'workspace',
                    groupId: 'room',
                    principalId: 'alice',
                    status: 'active'
                }
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
                    expiresAtEpochMs: 1_700_000_060_000
                }
            }
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
            const reader = new PSqlAdminStateReader(sql, {
                nowEpochMs: () => 1_700_000_000_000
            });

            await assert.rejects(
                () => reader.execute({ adminSession: createAdminSession() }),
                (error) =>
                    error instanceof Error &&
                    'code' in error &&
                    error.code === 'admin-operations-state-invariant-corruption'
            );
        });
    }
});

Deno.test(
    'admin state reader joins current group member and session identities globally',
    async () => {
        await withPGliteSql(async (sql) => {
            await insertRuntimeState(sql, {
                namespace: 'group-state:members',
                key: 'app=ops-global-sentinel:ws=_:group=room:member=alice',
                value: {
                    applicationId: 'ops-global-sentinel',
                    workspaceId: '_',
                    groupId: 'room',
                    principalId: 'alice',
                    status: 'active'
                }
            });
            await insertRuntimeState(sql, {
                namespace: 'group-state:sessions',
                key: 'app=ops-global-sentinel:ws=_:group=room:session=current-session',
                value: {
                    applicationId: 'ops-global-sentinel',
                    workspaceId: '_',
                    groupId: 'room',
                    principalId: 'alice',
                    sessionId: 'current-session',
                    disconnectedAtEpochMs: null,
                    expiresAtEpochMs: 1_700_000_060_000
                }
            });
            const reader = new PSqlAdminStateReader(sql, {
                nowEpochMs: () => 1_700_000_000_000
            });

            const state = await reader.execute({ adminSession: createAdminSession() });

            assert.equal(state.groups.totalActiveMembers, 1);
            assert.equal(state.groups.onlineMembers, 1);
        });
    }
);

Deno.test(
    'admin state reader validates the three global group row families',
    async () => {
        await withPGliteSql(async (sql) => {
            const guard = createRuntimeJsonScanGuard(sql);
            const reader = new PSqlAdminStateReader(guard.guardedSql, {
                nowEpochMs: () => 1_700_000_000_000
            });

            await reader.execute({ adminSession: createAdminSession() });

            assert.equal(guard.runtimeJsonScanCount, 3);
        });
    }
);
