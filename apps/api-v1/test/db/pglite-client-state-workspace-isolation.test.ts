import assert from 'node:assert/strict';

import { PSqlAdminOperationsStatsReader } from '@shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts';
import { PSqlClientStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-repository.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';

import { createTestGroup } from '../../../../packages/tests/create-test-group.ts';
import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';
import { delayAdminRuntimeFactQueries } from './pglite-admin-query-scheduling-test-boundary.ts';
import { withPGliteSql } from './pglite-auth-test-harness.ts';

const WORKSPACE_CASES = [
    { workspaceId: '_', workspaceKey: '_' },
    { workspaceId: '%5F', workspaceKey: '%255F' },
    { workspaceId: 'a:b', workspaceKey: 'a%3Ab' },
    { workspaceId: 'a%3Ab', workspaceKey: 'a%253Ab' }
] as const;

Deno.test('PGlite client events isolate lookalike workspace keys across every read shape', async () => {
    await withPGliteSql(async (sql) => {
        const repository = new PSqlClientStateEventRepository(sql);
        const applicationId = 'client-event-workspace-isolation';
        const principalId = 'shared-principal';

        for (const { workspaceId } of WORKSPACE_CASES) {
            const firstEvent = createClientEvent({
                applicationId,
                workspaceId,
                principalId,
                eventId: 'shared-event',
                eventType: 'session-connected',
                snapshotVersion: 1,
                occurredAtEpochMs: 1_000
            });
            const secondEvent = createClientEvent({
                applicationId,
                workspaceId,
                principalId,
                eventId: 'shared-next-event',
                eventType: 'principal-updated',
                snapshotVersion: 2,
                occurredAtEpochMs: 2_000
            });

            await repository.appendClientEvent(firstEvent);
            await repository.appendClientEvent(structuredClone(firstEvent));
            await repository.appendClientEvent(secondEvent);

            const ref = { applicationId, workspaceId, principalId };
            assert.deepEqual(await repository.listClientEvents(ref), [firstEvent, secondEvent]);
            assert.deepEqual(
                await repository.listRecentClientEvents(ref, { limit: 1 }),
                [secondEvent]
            );
            assert.deepEqual(
                await repository.listRecentClientEvents(ref, {
                    eventTypes: ['session-connected'],
                    limit: 1
                }),
                [firstEvent]
            );

            const firstPage = await repository.listClientEventPage(ref, { limit: 1 });
            assert.deepEqual(firstPage.events, [firstEvent]);
            assert.deepEqual(
                (
                    await repository.listClientEventPage(ref, {
                        after: firstPage.nextCursor,
                        limit: 1
                    })
                ).events,
                [secondEvent]
            );
            assert.deepEqual(
                (
                    await repository.listClientEventPage(ref, {
                        eventTypes: ['session-connected'],
                        limit: 1
                    })
                ).events,
                [firstEvent]
            );
            assert.deepEqual(
                (
                    await repository.listClientEventPage(ref, {
                        after: firstPage.nextCursor,
                        eventTypes: ['principal-updated'],
                        limit: 1
                    })
                ).events,
                [secondEvent]
            );
        }

        const rows = await sql<ReadonlyArray<{ workspace_key: string; event_json: string; }>>`
      select workspace_key, event_json
      from client_state_events
      where application_id = ${applicationId}
        and principal_id = ${principalId}
        and event_id = 'shared-event'
    `;
        assert.equal(rows.length, WORKSPACE_CASES.length);
        assert.deepEqual(
            Object.fromEntries(
                rows.map((row) => [JSON.parse(row.event_json).workspaceId, row.workspace_key])
            ),
            {
                _: '_',
                '%5F': '%255F',
                'a:b': 'a%3Ab',
                'a%3Ab': 'a%253Ab'
            }
        );
    });
});

Deno.test('PGlite admin state scopes recent events while system totals stay global', async () => {
    await withPGliteSql(async (sql) => {
        const nowEpochMs = 1_700_000_000_000;
        const applicationId = 'admin-client-event-workspace-isolation';

        for (const { workspaceKey } of WORKSPACE_CASES) {
            await sql`
        insert into client_state_events (
          application_id, workspace_key, principal_id, event_id, event_type,
          snapshot_version, occurred_at_epoch_ms, event_json
        )
        values (
          ${applicationId}, ${workspaceKey}, ${'shared-principal'}, ${'shared-event'},
          ${'session-connected'}, ${1}, ${nowEpochMs}, ${'{}'}
        )
      `;
        }

        const reader = new PSqlAdminOperationsStatsReader(sql, { now: () => nowEpochMs });
        for (const { workspaceId } of WORKSPACE_CASES) {
            const state = await reader.readState({
                adminSession: createAdminSession(),
                scope: { applicationId, workspaceId }
            });
            assert.equal(state.events.recentClientEvents, 1, workspaceId);
        }

        const system = await reader.readSystem({
            adminSession: createAdminSession(),
            scope: { applicationId, workspaceId: '_' }
        });
        assert.equal(system.stateEvents.clientEvents, WORKSPACE_CASES.length);
    });
});

Deno.test('PGlite admin online principals exclude omitted persisted workspace identity', async () => {
    await withPGliteSql(async (sql) => {
        await insertClientSession(sql, {
            keyWorkspace: '_',
            principalId: 'kept',
            workspaceId: '_'
        });
        await insertClientSession(sql, {
            keyWorkspace: 'missing',
            principalId: 'omitted'
        });

        const state = await readGlobalAdminState(sql);

        assert.equal(state.clients.onlinePrincipals, 1);
        assert.equal(state.clients.activeSessions, 1);
    });
});

Deno.test('PGlite admin online principals exclude empty persisted workspace identity', async () => {
    await withPGliteSql(async (sql) => {
        await insertClientSession(sql, {
            keyWorkspace: '_',
            principalId: 'kept',
            workspaceId: '_'
        });
        await insertClientSession(sql, {
            keyWorkspace: 'empty',
            principalId: 'empty',
            workspaceId: ''
        });

        const state = await readGlobalAdminState(sql);

        assert.equal(state.clients.onlinePrincipals, 1);
        assert.equal(state.clients.activeSessions, 1);
    });
});

Deno.test('PGlite admin online principals exclude non-string persisted workspace identity', async () => {
    await withPGliteSql(async (sql) => {
        await insertClientSession(sql, {
            keyWorkspace: '_',
            principalId: 'kept',
            workspaceId: '_'
        });
        await insertClientSession(sql, {
            keyWorkspace: 'malformed',
            principalId: 'malformed',
            workspaceId: ['x']
        });

        const state = await readGlobalAdminState(sql);

        assert.equal(state.clients.onlinePrincipals, 1);
        assert.equal(state.clients.activeSessions, 1);
    });
});

Deno.test('PGlite scoped admin state starts events before facts and shares activity cutoff', async () => {
    await withPGliteSql(async (sql) => {
        const recentEventWindowMs = 100;
        const activityCutoffEpochMs = 3_000;
        const applicationId = 'shared-activity-cutoff';
        await insertClientSession(sql, {
            applicationId,
            keyWorkspace: '_',
            principalId: 'boundary-client',
            workspaceId: '_',
            expiresAtEpochMs: activityCutoffEpochMs + 1
        });
        await insertActiveGroup(sql, {
            applicationId,
            workspaceId: '_',
            groupId: 'boundary-group',
            expiresAtEpochMs: activityCutoffEpochMs + 1
        });
        await insertAdminStateEventBoundaries(sql, {
            applicationId,
            clientObservedAtEpochMs: 1_000,
            groupObservedAtEpochMs: 2_000,
            recentEventWindowMs
        });
        const delayed = delayAdminRuntimeFactQueries(sql);
        const clockValues = [1_000, 2_000, activityCutoffEpochMs, 4_000];
        let clockCalls = 0;
        const reader = new PSqlAdminOperationsStatsReader(delayed.sql, {
            now: () => {
                const value = clockValues[clockCalls];
                clockCalls += 1;
                assert.notEqual(value, undefined, 'unexpected clock observation');
                return value;
            },
            recentEventWindowMs
        });

        const statePromise = reader.readState({
            adminSession: createAdminSession(),
            scope: { applicationId, workspaceId: '_' }
        });
        const launchEvidence = delayed.readLaunchEvidence();
        const clockCallsBeforeRelease = clockCalls;
        delayed.releaseRuntimeFacts();
        const state = await statePromise;

        assert.deepEqual(launchEvidence.recentEventQueries, ['client', 'group']);
        assert.equal(launchEvidence.runtimeFactQueries, 5);
        assert.equal(clockCallsBeforeRelease, 2);
        assert.equal(clockCalls, 4);
        assert.equal(state.generatedAtEpochMs, 4_000);
        assert.equal(state.clients.activeSessions, 1);
        assert.equal(state.groups.activeGroups, 1);
        assert.equal(state.events.recentClientEvents, 1);
        assert.equal(state.events.recentGroupEvents, 1);
    });
});

Deno.test('PGlite global admin state preserves independent query and response clocks', async () => {
    await withPGliteSql(async (sql) => {
        const recentEventWindowMs = 100;
        const applicationId = 'global-query-clocks';
        await insertClientSession(sql, {
            applicationId,
            keyWorkspace: '_',
            principalId: 'boundary-client',
            workspaceId: '_',
            expiresAtEpochMs: 1_500
        });
        await insertActiveGroup(sql, {
            applicationId,
            workspaceId: '_',
            groupId: 'boundary-group',
            expiresAtEpochMs: 5_001
        });
        await insertAdminStateEventBoundaries(sql, {
            applicationId,
            clientObservedAtEpochMs: 3_000,
            groupObservedAtEpochMs: 4_000,
            recentEventWindowMs
        });
        const delayed = delayAdminRuntimeFactQueries(sql);
        const clockValues = [1_000, 2_000, 3_000, 4_000, 5_000, 6_000];
        let clockCalls = 0;
        const reader = new PSqlAdminOperationsStatsReader(delayed.sql, {
            now: () => {
                const value = clockValues[clockCalls];
                clockCalls += 1;
                assert.notEqual(value, undefined, 'unexpected clock observation');
                return value;
            },
            recentEventWindowMs
        });

        const statePromise = reader.readState({ adminSession: createAdminSession() });
        const launchEvidence = delayed.readLaunchEvidence();
        const clockCallsBeforeRelease = clockCalls;
        delayed.releaseRuntimeFacts();
        const state = await statePromise;

        assert.deepEqual(launchEvidence.recentEventQueries, ['client', 'group']);
        assert.equal(launchEvidence.runtimeFactQueries, 6);
        assert.equal(clockCallsBeforeRelease, 4);
        assert.equal(clockCalls, 6);
        assert.equal(state.generatedAtEpochMs, 6_000);
        assert.equal(state.clients.onlinePrincipals, 1);
        assert.equal(state.clients.activeSessions, 0);
        assert.equal(state.groups.activeGroups, 1);
        assert.equal(state.events.recentClientEvents, 1);
        assert.equal(state.events.recentGroupEvents, 1);
    });
});

function createClientEvent(
    input: Readonly<{
        applicationId: string;
        workspaceId: string;
        principalId: string;
        eventId: string;
        eventType: ClientEvent['eventType'];
        snapshotVersion: number;
        occurredAtEpochMs: number;
    }>
): ClientEvent {
    return {
        ...input,
        clientInstanceId: 'shared-instance',
        sessionId: 'shared-session',
        actor: { kind: 'service', serviceId: 'pglite-workspace-isolation-test' },
        reason: null,
        traceId: null,
        requestId: null,
        payload: {}
    };
}

async function insertClientSession(
    sql: PGliteSql,
    input: Readonly<{
        applicationId?: string;
        keyWorkspace: string;
        principalId: string;
        workspaceId?: unknown;
        expiresAtEpochMs?: number;
    }>
): Promise<void> {
    const applicationId = input.applicationId ?? 'workspace-required';
    const value = JSON.stringify({
        applicationId,
        workspaceId: input.workspaceId,
        principalId: input.principalId,
        clientInstanceId: 'browser',
        sessionId: input.principalId,
        status: 'active',
        expiresAtEpochMs: input.expiresAtEpochMs ?? 1_700_000_060_000
    });
    await sql`
    insert into runtime_state_store (
      store_namespace, store_key, store_value, expire_at_ts
    )
    values (
      ${'client-state:sessions'},
      ${`app=${applicationId}:ws=${input.keyWorkspace}:principal=${input.principalId}:instance=browser:session=${input.principalId}`},
      ${value},
      ${new Date('9999-12-31T23:59:59Z')}
    )
  `;
}

async function insertActiveGroup(
    sql: PGliteSql,
    input: Readonly<{
        applicationId: string;
        workspaceId: string;
        groupId: string;
        expiresAtEpochMs: number;
    }>
): Promise<void> {
    const audit = {
        atEpochMs: 1_700_000_000_000,
        actor: { kind: 'principal' as const, principalId: 'boundary-owner' },
        reason: null,
        traceId: null,
        requestId: 'shared-cutoff-request'
    };
    const value = JSON.stringify(createTestGroup({
        ...input,
        displayName: input.groupId,
        activeMemberCount: 1,
        ownerPrincipalId: 'boundary-owner',
        snapshotVersion: 1,
        metadataVersion: 1,
        rosterVersion: 1,
        presenceVersion: 0,
        created: audit,
        updated: audit
    }));
    await sql`
    insert into runtime_state_store (
      store_namespace, store_key, store_value, expire_at_ts
    )
    values (
      ${'group-state:groups'},
      ${`app=${input.applicationId}:ws=_:group=${input.groupId}`},
      ${value},
      ${new Date('9999-12-31T23:59:59Z')}
    )
  `;
}

async function insertAdminStateEventBoundaries(
    sql: PGliteSql,
    input: Readonly<{
        applicationId: string;
        clientObservedAtEpochMs: number;
        groupObservedAtEpochMs: number;
        recentEventWindowMs: number;
    }>
): Promise<void> {
    await sql`
    insert into client_state_events (
      application_id, workspace_key, principal_id, event_id, event_type,
      snapshot_version, occurred_at_epoch_ms, event_json
    )
    values
      (${input.applicationId}, ${'_'}, ${'boundary-client'}, ${'client-old'},
        ${'session-connected'}, ${1},
        ${input.clientObservedAtEpochMs - input.recentEventWindowMs - 1}, ${'{}'}),
      (${input.applicationId}, ${'_'}, ${'boundary-client'}, ${'client-recent'},
        ${'session-connected'}, ${1},
        ${input.clientObservedAtEpochMs - input.recentEventWindowMs + 1}, ${'{}'})
  `;
    await sql`
    insert into group_state_events (
      application_id, workspace_key, group_id, event_id, event_type,
      snapshot_version, occurred_at_epoch_ms, event_json
    )
    values
      (${input.applicationId}, ${'_'}, ${'boundary-group'}, ${'group-old'},
        ${'session-connected'}, ${1},
        ${input.groupObservedAtEpochMs - input.recentEventWindowMs - 1}, ${'{}'}),
      (${input.applicationId}, ${'_'}, ${'boundary-group'}, ${'group-recent'},
        ${'session-connected'}, ${1},
        ${input.groupObservedAtEpochMs - input.recentEventWindowMs + 1}, ${'{}'})
  `;
}

async function readGlobalAdminState(sql: PGliteSql) {
    const reader = new PSqlAdminOperationsStatsReader(sql, {
        now: () => 1_700_000_000_000
    });
    return await reader.readState({ adminSession: createAdminSession() });
}

function createAdminSession() {
    return {
        clientId: 'platform-admin',
        username: 'admin',
        accessToken: 'access-token',
        sessionId: 'admin-session',
        expiresAtEpochMs: 1_700_000_060_000
    };
}
