import assert from 'node:assert/strict';

import type { ClientEvent } from '@shared/api/client-types.ts';
import { PSqlAdminOperationsStatsReader } from '@shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts';
import { PSqlClientStateEventRepository } from '@shared-server/postgres/rallar-system/PSqlStateEventRepository.ts';

import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';
import { withPGliteSql } from './pglite-auth-test-harness.ts';

const WORKSPACE_CASES = [
  { workspaceId: '_', workspaceKey: '%5F' },
  { workspaceId: '%5F', workspaceKey: '%255F' },
  { workspaceId: 'a:b', workspaceKey: 'a%3Ab' },
  { workspaceId: 'a%3Ab', workspaceKey: 'a%253Ab' },
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
        occurredAtEpochMs: 1_000,
      });
      const secondEvent = createClientEvent({
        applicationId,
        workspaceId,
        principalId,
        eventId: 'shared-next-event',
        eventType: 'principal-updated',
        snapshotVersion: 2,
        occurredAtEpochMs: 2_000,
      });

      await repository.appendClientEvent(firstEvent);
      await repository.appendClientEvent(structuredClone(firstEvent));
      await repository.appendClientEvent(secondEvent);

      const ref = { applicationId, workspaceId, principalId };
      assert.deepEqual(await repository.listClientEvents(ref), [firstEvent, secondEvent]);
      assert.deepEqual(
        await repository.listRecentClientEvents(ref, { limit: 1 }),
        [secondEvent],
      );
      assert.deepEqual(
        await repository.listRecentClientEvents(ref, {
          eventTypes: ['session-connected'],
          limit: 1,
        }),
        [firstEvent],
      );

      const firstPage = await repository.listClientEventPage(ref, { limit: 1 });
      assert.deepEqual(firstPage.events, [firstEvent]);
      assert.deepEqual(
        (
          await repository.listClientEventPage(ref, {
            after: firstPage.nextCursor,
            limit: 1,
          })
        ).events,
        [secondEvent],
      );
      assert.deepEqual(
        (
          await repository.listClientEventPage(ref, {
            eventTypes: ['session-connected'],
            limit: 1,
          })
        ).events,
        [firstEvent],
      );
      assert.deepEqual(
        (
          await repository.listClientEventPage(ref, {
            after: firstPage.nextCursor,
            eventTypes: ['principal-updated'],
            limit: 1,
          })
        ).events,
        [secondEvent],
      );
    }

    const rows = await sql<
      ReadonlyArray<{ workspace_key: string; event_json: string }>
    >`
      select workspace_key, event_json
      from client_state_events
      where application_id = ${applicationId}
        and principal_id = ${principalId}
        and event_id = 'shared-event'
    `;
    assert.equal(rows.length, WORKSPACE_CASES.length);
    assert.deepEqual(
      Object.fromEntries(
        rows.map((row) => [JSON.parse(row.event_json).workspaceId, row.workspace_key]),
      ),
      {
        _: '%5F',
        '%5F': '%255F',
        'a:b': 'a%3Ab',
        'a%3Ab': 'a%253Ab',
      },
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
        scope: { applicationId, workspaceId },
      });
      assert.equal(state.events.recentClientEvents, 1, workspaceId);
    }

    const system = await reader.readSystem({
      adminSession: createAdminSession(),
      scope: { applicationId, workspaceId: '_' },
    });
    assert.equal(system.stateEvents.clientEvents, WORKSPACE_CASES.length);
  });
});

Deno.test('PGlite admin online principals exclude omitted persisted workspace identity', async () => {
  await withPGliteSql(async (sql) => {
    await insertClientSession(sql, {
      keyWorkspace: '%5F',
      principalId: 'kept',
      workspaceId: '_',
    });
    await insertClientSession(sql, {
      keyWorkspace: 'missing',
      principalId: 'omitted',
    });

    const state = await readGlobalAdminState(sql);

    assert.equal(state.clients.onlinePrincipals, 1);
    assert.equal(state.clients.activeSessions, 2);
  });
});

Deno.test('PGlite admin online principals exclude empty persisted workspace identity', async () => {
  await withPGliteSql(async (sql) => {
    await insertClientSession(sql, {
      keyWorkspace: '%5F',
      principalId: 'kept',
      workspaceId: '_',
    });
    await insertClientSession(sql, {
      keyWorkspace: 'empty',
      principalId: 'empty',
      workspaceId: '',
    });

    const state = await readGlobalAdminState(sql);

    assert.equal(state.clients.onlinePrincipals, 1);
    assert.equal(state.clients.activeSessions, 2);
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
  }>,
): ClientEvent {
  return {
    ...input,
    clientInstanceId: 'shared-instance',
    sessionId: 'shared-session',
    actor: { kind: 'service', serviceId: 'pglite-workspace-isolation-test' },
    reason: null,
    traceId: null,
    requestId: null,
    payload: {},
  };
}

async function insertClientSession(
  sql: PGliteSql,
  input: Readonly<{
    keyWorkspace: string;
    principalId: string;
    workspaceId?: string;
  }>,
): Promise<void> {
  const value = JSON.stringify({
    applicationId: 'workspace-required',
    workspaceId: input.workspaceId,
    status: 'active',
    principalId: input.principalId,
    expiresAtEpochMs: 1_700_000_060_000,
  });
  await sql`
    insert into runtime_state_store (
      store_namespace, store_key, store_value, expire_at_ts
    )
    values (
      ${'client-state:sessions'},
      ${`app=workspace-required:ws=${input.keyWorkspace}:principal=${input.principalId}:instance=browser:session=${input.principalId}`},
      ${value},
      ${new Date('9999-12-31T23:59:59Z')}
    )
  `;
}

async function readGlobalAdminState(sql: PGliteSql) {
  const reader = new PSqlAdminOperationsStatsReader(sql, {
    now: () => 1_700_000_000_000,
  });
  return await reader.readState({ adminSession: createAdminSession() });
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
