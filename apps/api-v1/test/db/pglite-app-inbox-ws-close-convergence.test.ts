import assert from 'node:assert/strict';

import type { StateScope } from '@shared/api/state-types.ts';
import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import {
  type GroupCreateAppInboxPayload,
  type GroupPresenceConnectAppInboxPayload,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';
import { toAuthorisedWsClientConnectEnqueue } from '@shared-server/rallar-system/services/authorised-ws-client-app-inbox.ts';
import {
  type GroupStateWritten,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import { toResilienceDto } from '../../src/middleware-resilience.ts';
import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';
import { FUTURE_MS, waitForPGliteQueueRow, withPGliteSql } from './pglite-auth-test-harness.ts';
import {
  assertPGliteQueuedTypes as assertQueuedTypes,
  assertPGliteQueueRetriedAndCompleted as assertQueueRetriedAndCompleted,
  createPGliteAppInboxWsCloseHarness as createHarness,
  pauseNextPGliteLifecycleRead as pauseNextLifecycleRead,
} from './pglite-app-inbox-ws-close-test-harness.ts';

const SCOPE: StateScope = { applicationId: 'ar-eye-hunter', workspaceId: 'default' };

Deno.test('PGlite client connect conflicts when close commits after lifecycle read', async () => {
  await withPGliteSql(async (sql) => {
    const harness = await createHarness(sql);
    const generationId = 'pglite-client-interleaved';
    const connectedAtEpochMs = Date.now() - 1_000;
    const connectInput = {
      authSession: harness.authority,
      generationId,
      input: { ...SCOPE, connectedAtEpochMs, expiresAtEpochMs: FUTURE_MS },
    } as const;
    const pause = pauseNextLifecycleRead(harness.clientState);
    const connectEntry = await harness.client.enqueueAuthorisedWsClientConnect(connectInput);
    const staleConnect = processNext(harness.reader);
    await pause.reached;

    await harness.client.enqueueAuthorisedWsClientDisconnect({
      connection: toAuthorisedWsClientConnectEnqueue(connectInput).data,
      disconnectedAtEpochMs: connectedAtEpochMs + 1,
      reason: 'socket-closed',
    });
    await processNext(harness.secondReader);
    pause.resume();
    await staleConnect;

    assert.deepEqual(
      (await harness.clients.readSnapshot({
        ...SCOPE,
        principalId: harness.authority.clientId,
      }))?.activeSessions ?? [],
      [],
    );
    await assertQueueRetriedAndCompleted(sql, connectEntry.key);
    assert.deepEqual(
      (await harness.clients.readSnapshot({
        ...SCOPE,
        principalId: harness.authority.clientId,
      }))?.activeSessions ?? [],
      [],
    );
  });
});

Deno.test('PGlite group connect conflicts when cleanup commits after lifecycle read', async () => {
  await withPGliteSql(async (sql) => {
    const harness = await createHarness(sql);
    const groupId = 'pglite-group-interleaved';
    await createRoom(harness, groupId, sql);
    const wsGenerationId = 'pglite-group-ws-interleaved';
    const wsStartedAtEpochMs = Date.now() - 900;
    const presenceGenerationId = crypto.randomUUID();
    const pause = pauseNextLifecycleRead(harness.groupState);
    const pending = harness.group.processAuthenticatedEntryUntilCompletion<
      GroupPresenceConnectAppInboxPayload,
      GroupStateWritten
    >({
      type: AppInboxType.GROUP_PRESENCE_CONNECT,
      resourceId: `presence-${presenceGenerationId}`,
      contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`,
      senderId: harness.authority.clientId,
      data: {
        scope: SCOPE,
        groupId,
        sessionId: harness.authority.sessionId,
        request: {
          principalId: harness.authority.clientId,
          generationId: presenceGenerationId,
          connectedAtEpochMs: wsStartedAtEpochMs - 50,
          lastHeartbeatAtEpochMs: wsStartedAtEpochMs - 50,
          expiresAtEpochMs: FUTURE_MS,
          actorPrincipalId: harness.authority.clientId,
          actorSessionId: harness.authority.sessionId,
          requestId: `presence-${presenceGenerationId}`,
        },
      },
    }, harness.authority);
    const connectKey = await waitForTypeKey(sql, AppInboxType.GROUP_PRESENCE_CONNECT);
    const staleConnect = processNext(harness.reader);
    await pause.reached;

    await harness.group.enqueueGroupSessionCleanup({
      connection: toAuthorisedWsClientConnectEnqueue({
        authSession: harness.authority,
        generationId: wsGenerationId,
        input: { ...SCOPE, connectedAtEpochMs: wsStartedAtEpochMs },
      }).data,
      disconnectedAtEpochMs: wsStartedAtEpochMs + 1,
      reason: 'socket-closed',
    });
    await processNext(harness.secondReader);
    pause.resume();
    await staleConnect;

    assert.deepEqual(
      (await harness.groups.readSnapshot({ ...SCOPE, groupId }))
        ?.activeSessions ?? [],
      [],
    );
    await assertQueueRetriedAndCompleted(sql, connectKey);
    assert.ok((await pending).right);
    assert.deepEqual(
      (await harness.groups.readSnapshot({ ...SCOPE, groupId }))
        ?.activeSessions ?? [],
      [],
    );
  });
});

Deno.test('PGlite client close tombstone suppresses a delayed AppInbox connect row', async () => {
  await withPGliteSql(async (sql) => {
    const harness = await createHarness(sql);
    const generationId = 'pglite-client-close-first';
    const connectedAtEpochMs = Date.now() - 1_000;
    const connectInput = {
      authSession: harness.authority,
      generationId,
      input: { ...SCOPE, connectedAtEpochMs, expiresAtEpochMs: FUTURE_MS },
    } as const;

    const connectEntry = await harness.client.enqueueAuthorisedWsClientConnect(connectInput);
    await delay(sql, connectEntry.key);
    await harness.client.enqueueAuthorisedWsClientDisconnect({
      connection: toAuthorisedWsClientConnectEnqueue(connectInput).data,
      disconnectedAtEpochMs: connectedAtEpochMs + 1,
      reason: 'socket-closed',
    });
    await processNext(harness.reader);
    await release(sql, connectEntry.key);
    await processNext(harness.reader);

    const snapshot = await harness.clients.readSnapshot({
      ...SCOPE,
      principalId: harness.authority.clientId,
    });
    assert.equal(snapshot?.isOnline ?? false, false);
    assert.deepEqual(snapshot?.activeSessions ?? [], []);
    await assertQueuedTypes(sql, [
      AppInboxType.CLIENT_AUTHORISED_WS_CONNECT,
      AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT,
    ]);
  });
});

Deno.test('PGlite group cleanup tombstone suppresses a delayed presence connect row', async () => {
  await withPGliteSql(async (sql) => {
    const harness = await createHarness(sql);
    const groupId = 'pglite-cleanup-first';
    await createRoom(harness, groupId, sql);
    const wsGenerationId = 'pglite-ws-generation-close-first';
    const wsStartedAtEpochMs = Date.now() - 900;
    const presenceGenerationId = crypto.randomUUID();
    const presenceConnectedAtEpochMs = wsStartedAtEpochMs - 50;
    const pending = harness.group.processAuthenticatedEntryUntilCompletion<
      GroupPresenceConnectAppInboxPayload,
      GroupStateWritten
    >({
      type: AppInboxType.GROUP_PRESENCE_CONNECT,
      resourceId: `presence-${presenceGenerationId}`,
      contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`,
      senderId: harness.authority.clientId,
      data: {
        scope: SCOPE,
        groupId,
        sessionId: harness.authority.sessionId,
        request: {
          principalId: harness.authority.clientId,
          generationId: presenceGenerationId,
          connectedAtEpochMs: presenceConnectedAtEpochMs,
          lastHeartbeatAtEpochMs: presenceConnectedAtEpochMs,
          expiresAtEpochMs: FUTURE_MS,
          actorPrincipalId: harness.authority.clientId,
          actorSessionId: harness.authority.sessionId,
          requestId: `presence-${presenceGenerationId}`,
        },
      },
    }, harness.authority);
    const connectKey = await waitForTypeKey(sql, AppInboxType.GROUP_PRESENCE_CONNECT);
    await delay(sql, connectKey);
    assert.equal(
      await harness.group.enqueueGroupSessionCleanup({
        connection: toAuthorisedWsClientConnectEnqueue({
          authSession: harness.authority,
          generationId: wsGenerationId,
          input: { ...SCOPE, connectedAtEpochMs: wsStartedAtEpochMs },
        }).data,
        disconnectedAtEpochMs: wsStartedAtEpochMs + 1,
        reason: 'socket-closed',
      }),
      1,
    );
    await processNext(harness.reader);
    await release(sql, connectKey);
    await processNext(harness.reader);
    assert.ok((await pending).right);

    const snapshot = await harness.groups.readSnapshot({ ...SCOPE, groupId });
    assert.deepEqual(snapshot?.activeSessions ?? [], []);
    await assertQueuedTypes(sql, [
      AppInboxType.GROUP_PRESENCE_CONNECT,
      AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
    ]);
  });
});

Deno.test('PGlite lost-close group guard has bounded physical expiry before cleanup', async () => {
  await withPGliteSql(async (sql) => {
    const harness = await createHarness(sql);
    const groupId = 'pglite-independent-presence';
    await createRoom(harness, groupId, sql);
    const wsStartedAtEpochMs = Date.now() - 500;
    const presenceGenerationId = crypto.randomUUID();
    const pending = harness.group.processAuthenticatedEntryUntilCompletion<
      GroupPresenceConnectAppInboxPayload,
      GroupStateWritten
    >({
      type: AppInboxType.GROUP_PRESENCE_CONNECT,
      resourceId: `presence-${presenceGenerationId}`,
      contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`,
      senderId: harness.authority.clientId,
      data: {
        scope: SCOPE,
        groupId,
        sessionId: harness.authority.sessionId,
        request: {
          principalId: harness.authority.clientId,
          generationId: presenceGenerationId,
          connectedAtEpochMs: wsStartedAtEpochMs - 50,
          lastHeartbeatAtEpochMs: wsStartedAtEpochMs - 50,
          expiresAtEpochMs: FUTURE_MS,
          actorPrincipalId: harness.authority.clientId,
          actorSessionId: harness.authority.sessionId,
          requestId: `presence-${presenceGenerationId}`,
        },
      },
    }, harness.authority);
    await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
    await processNext(harness.reader);
    assert.ok((await pending).right);
    assert.equal(
      (await harness.groups.listAllPresenceSessions()).filter((session) =>
        session.groupId === groupId && session.disconnectedAtEpochMs === null
      ).length,
      1,
    );
    const lifecycle = await harness.groupState.sessionGenerationLifecycle.read({
      scope: {
        kind: 'group',
        ...SCOPE,
        principalId: harness.authority.clientId,
      },
      sessionId: harness.authority.sessionId,
    });
    const expectedExpiry = resourceInboxRetryExpiryAtEpochMs(wsStartedAtEpochMs - 50);
    assert.equal(lifecycle.state?.status, 'open');
    assert.equal(lifecycle.state?.expireAtEpochMs, expectedExpiry);
    assert.equal(lifecycle.entry?.expireAtTimestamp, expectedExpiry);
    assert.ok(expectedExpiry < FUTURE_MS);

    await harness.group.enqueueGroupSessionCleanup({
      connection: toAuthorisedWsClientConnectEnqueue({
        authSession: harness.authority,
        generationId: 'different-ws-generation',
        input: { ...SCOPE, connectedAtEpochMs: wsStartedAtEpochMs },
      }).data,
      disconnectedAtEpochMs: wsStartedAtEpochMs + 100,
      reason: 'socket-closed',
    });
    await processNext(harness.reader);

    assert.deepEqual(
      (await harness.groups.listAllPresenceSessions()).filter((session) =>
        session.groupId === groupId && session.disconnectedAtEpochMs === null
      ),
      [],
    );
    const closed = await harness.groupState.sessionGenerationLifecycle.read(lifecycle.identity);
    const expectedCloseExpiry = resourceInboxRetryExpiryAtEpochMs(wsStartedAtEpochMs + 100);
    assert.equal(closed.state?.status, 'closed');
    assert.equal(closed.state?.expireAtEpochMs, expectedCloseExpiry);
    assert.equal(closed.entry?.expireAtTimestamp, expectedCloseExpiry);
  });
});

async function createRoom(
  harness: Awaited<ReturnType<typeof createHarness>>,
  groupId: string,
  sql: PGliteSql,
): Promise<void> {
  const pending = harness.group.processAuthenticatedEntryUntilCompletion<
    GroupCreateAppInboxPayload,
    GroupStateWritten
  >({
    type: AppInboxType.GROUP_CREATE,
    resourceId: `create-${groupId}`,
    contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`,
    senderId: harness.authority.clientId,
    data: {
      scope: SCOPE,
      request: {
        groupId,
        displayName: groupId,
        kind: 'room',
        joinMode: 'open',
        createdByPrincipalId: harness.authority.clientId,
        actorPrincipalId: harness.authority.clientId,
        actorSessionId: harness.authority.sessionId,
        requestId: `create-${groupId}`,
      },
    },
  }, harness.authority);
  await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
  await processNext(harness.reader);
  assert.ok((await pending).right);
}

async function processNext(reader: InboxQueueReader): Promise<void> {
  await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, toResilienceDto());
}

type QueueKey = Readonly<{ topicId: string; resourceId: string; contextId: string }>;

async function waitForTypeKey(sql: PGliteSql, type: AppInboxType): Promise<QueueKey> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await sql<{
      topic_id: string;
      resource_id: string;
      context_id: string;
    }[]>`
      select ri_topic_id as topic_id, ri_resource_id as resource_id,
             fk_ext_bank_id as context_id
      from resource_inbox
      where ri_type_id = 'APP_INBOX' and ri_status = 'NEW'
        and ri_resource like ${`%${type}%`}
      order by ri_row_id
      limit 1
    `;
    if (row) {
      return {
        topicId: row.topic_id,
        resourceId: row.resource_id,
        contextId: row.context_id,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

async function delay(sql: PGliteSql, key: QueueKey): Promise<void> {
  await sql`
    update resource_inbox
    set ri_status = 'RETRY', next_ts = timestamp '9999-01-01 00:00:00',
        start_ts = null, end_ts = null
    where ri_topic_id = ${key.topicId} and ri_resource_id = ${key.resourceId}
      and fk_ext_bank_id = ${key.contextId}
  `;
}

async function release(sql: PGliteSql, key: QueueKey): Promise<void> {
  await sql`
    update resource_inbox
    set ri_status = 'NEW', next_ts = null, start_ts = null, end_ts = null
    where ri_topic_id = ${key.topicId} and ri_resource_id = ${key.resourceId}
      and fk_ext_bank_id = ${key.contextId}
  `;
}
