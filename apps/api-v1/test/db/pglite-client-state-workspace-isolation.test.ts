import assert from 'node:assert/strict';
import type { ClientEvent } from '@shared/api/client-types.ts';
import { PSqlClientStateEventRepository } from '@shared-server/postgres/rallar-system/PSqlStateEventRepository.ts';
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
