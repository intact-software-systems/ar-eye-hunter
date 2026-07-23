import { describe, expect, it } from 'vitest';

import type { StateScope } from '@shared/api/state-types.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import {
  AppClientInboxService,
  AppInboxType,
} from '@shared-server/rallar-system/services/AppClientInboxService.ts';
import {
  AppGroupInboxService,
  type AppInboxEnqueueInput,
  type GroupCreateAppInboxPayload,
  type GroupPresenceConnectAppInboxPayload,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import { createClientStateService } from '@shared-server/rallar-system/services/client-state-service.ts';
import { toAuthorisedWsClientConnectEnqueue } from '@shared-server/rallar-system/services/authorised-ws-client-app-inbox.ts';
import {
  createGroupStateService,
  type GroupStateWritten,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import { createAppInboxTestDatabase } from './app-inbox-test-database.ts';
import { TestResourceInbox, TestResourceInboxResults } from './app-auth-inbox-test-harness.ts';
import {
  delayEntry,
  groupPresenceFacts,
  processNext,
  queuedTypes,
  releaseEntry,
  requireQueuedType,
  waitForQueuedType,
} from './app-inbox-queue-entry-test-helpers.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

const SCOPE: StateScope = {
  applicationId: 'ar-eye-hunter',
  workspaceId: 'default',
};
const NOW_EPOCH_MS = 1_800_000_000_000;
interface AuthorisedWsCloseFacts {
  readonly authSession: IssuedAuthSession;
  readonly generationId: string;
  readonly input: Readonly<{
    applicationId: string;
    workspaceId: string;
    connectedAtEpochMs: number;
    expiresAtEpochMs: number;
  }>;
  readonly disconnectedAtEpochMs: number;
  readonly reason: string;
}
describe('AppInbox websocket close convergence', () => {
  it('processes connect then disconnect to an inactive client session', async () => {
    const harness = await createHarness();
    const facts = closeFacts(harness.authSession, 'client-connect-first', 10);

    await harness.client.enqueueAuthorisedWsClientConnect({
      authSession: facts.authSession,
      generationId: facts.generationId,
      input: facts.input,
    });
    await processNext(harness.reader);
    await enqueueClientClose(harness.client, facts);
    await processNext(harness.reader);

    const snapshot = await harness.clients.readSnapshot({
      ...SCOPE,
      principalId: harness.authSession.clientId,
    });
    expect(snapshot?.isOnline).toBe(false);
    expect(snapshot?.activeSessions).toEqual([]);
  });

  it('processes disconnect before delayed connect without an orphan active client', async () => {
    const harness = await createHarness();
    const facts = closeFacts(harness.authSession, 'client-disconnect-first', 20);

    await harness.client.enqueueAuthorisedWsClientConnect({
      authSession: facts.authSession,
      generationId: facts.generationId,
      input: facts.input,
    });
    const connect = await requireQueuedType(
      harness.queue,
      AppInboxType.CLIENT_AUTHORISED_WS_CONNECT,
    );
    await delayEntry(harness.queue, connect);
    await enqueueClientClose(harness.client, facts);
    await processNext(harness.reader);
    await releaseEntry(harness.queue, connect);
    await processNext(harness.reader);

    const snapshot = await harness.clients.readSnapshot({
      ...SCOPE,
      principalId: harness.authSession.clientId,
    });
    expect(snapshot?.isOnline ?? false).toBe(false);
    expect(snapshot?.activeSessions ?? []).toEqual([]);
    expect(await queuedTypes(harness.queue)).toContain(
      AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT,
    );
  });

  it('always enqueues one group cleanup fact and converges connect then cleanup', async () => {
    const harness = await createHarness();
    await createRoom(harness, 'connect-first-room');
    const facts = closeFacts(harness.authSession, 'group-connect-first', 30);
    const presence = groupPresenceFacts(facts, 'presence-connect-first', -50);

    const pending = enqueueGroupConnect(harness, 'connect-first-room', facts, presence);
    await waitForQueuedType(harness.queue, AppInboxType.GROUP_PRESENCE_CONNECT);
    await processNext(harness.reader);
    expect((await pending).right).toBeDefined();
    expect(await activeGroupSessionCount(harness, 'connect-first-room')).toBe(1);
    const cleanupCount = await enqueueGroupClose(harness.group, facts);
    expect(cleanupCount).toBe(1);
    await processNext(harness.reader);

    expect(await activeGroupSessionCount(harness, 'connect-first-room')).toBe(0);
  });

  it('processes group cleanup before delayed presence connect without orphan presence', async () => {
    const harness = await createHarness();
    await createRoom(harness, 'cleanup-first-room');
    const facts = closeFacts(harness.authSession, 'group-cleanup-first', 40);
    const presence = groupPresenceFacts(facts, 'presence-cleanup-first', -50);

    const pending = enqueueGroupConnect(harness, 'cleanup-first-room', facts, presence);
    const connect = await waitForQueuedType(
      harness.queue,
      AppInboxType.GROUP_PRESENCE_CONNECT,
    );
    await delayEntry(harness.queue, connect);
    const cleanupCount = await enqueueGroupClose(harness.group, facts);
    expect(cleanupCount).toBe(1);
    await processNext(harness.reader);
    await releaseEntry(harness.queue, connect);
    await processNext(harness.reader);
    await pending;

    expect(await activeGroupSessionCount(harness, 'cleanup-first-room')).toBe(0);
    expect(await queuedTypes(harness.queue)).toContain(
      AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
    );
  });

  it('suppresses an older delayed client generation after a newer generation closes first', async () => {
    const harness = await createHarness();
    const older = closeFacts(harness.authSession, 'client-generation-a', 50);
    const newer = closeFacts(harness.authSession, 'client-generation-b', 60);
    const olderConnect = await harness.client.enqueueAuthorisedWsClientConnect({
      authSession: older.authSession,
      generationId: older.generationId,
      input: older.input,
    });
    const newerConnect = await harness.client.enqueueAuthorisedWsClientConnect({
      authSession: newer.authSession,
      generationId: newer.generationId,
      input: newer.input,
    });
    await delayEntry(harness.queue, olderConnect);
    await delayEntry(harness.queue, newerConnect);

    await enqueueClientClose(harness.client, newer);
    await processNext(harness.reader);
    await releaseEntry(harness.queue, olderConnect);
    await processNext(harness.reader);
    await releaseEntry(harness.queue, newerConnect);
    await processNext(harness.reader);

    const snapshot = await harness.clients.readSnapshot({
      ...SCOPE,
      principalId: harness.authSession.clientId,
    });
    expect(snapshot?.activeSessions ?? []).toEqual([]);
  });

  it('does not let an older close disconnect a newer active client generation', async () => {
    const harness = await createHarness();
    const older = closeFacts(harness.authSession, 'client-generation-a', 70);
    const newer = closeFacts(harness.authSession, 'client-generation-b', 80);

    await harness.client.enqueueAuthorisedWsClientConnect({
      authSession: newer.authSession,
      generationId: newer.generationId,
      input: newer.input,
    });
    await processNext(harness.reader);
    await enqueueClientClose(harness.client, older);
    await processNext(harness.reader);

    const snapshot = await harness.clients.readSnapshot({
      ...SCOPE,
      principalId: harness.authSession.clientId,
    });
    expect(snapshot?.activeSessions.map((session) => session.generationId)).toEqual([
      newer.generationId,
    ]);
  });
});
async function createHarness() {
  const queue = new TestResourceInbox();
  const reader = new InboxQueueReader(queue);
  const results = new TestResourceInboxResults();
  const runtimeRepository = new FakeRuntimeStateRepository();
  const database = createAppInboxTestDatabase(queue, results, { runtimeRepository });
  const authSessions = new AuthSessionRepository(runtimeRepository);
  const authSession = issuedSession('owner', 'owner-session');
  await authSessions.putSession(authSession);
  const groupState = createGroupStateService({
    runtimeRepository,
    authSessionRepository: authSessions,
    createGroupStateEventStore: () => database.groupEventStore,
    serviceId: 'server-12345678',
    now: () => NOW_EPOCH_MS,
  });
  return {
    queue,
    reader,
    authSession,
    client: new AppClientInboxService(
      reader,
      queue as never,
      results as never,
      database,
      createClientStateService({
        runtimeRepository,
        createClientStateEventStore: () => database.clientEventStore,
        serviceId: 'server-12345678',
      }),
      'server-12345678',
    ),
    group: new AppGroupInboxService(
      reader,
      queue as never,
      results as never,
      database,
      groupState,
      'server-12345678',
    ),
    clients: new ClientStateRepository(runtimeRepository),
    groups: new GroupStateRepository(runtimeRepository, { events: database.groupEventStore }),
  };
}
function closeFacts(
  authSession: IssuedAuthSession,
  generationId: string,
  offset: number,
): AuthorisedWsCloseFacts {
  const connectedAtEpochMs = NOW_EPOCH_MS - 1_000 + offset;
  return {
    authSession,
    generationId,
    input: {
      ...SCOPE,
      connectedAtEpochMs,
      expiresAtEpochMs: connectedAtEpochMs + 60_000,
    },
    disconnectedAtEpochMs: connectedAtEpochMs + 1,
    reason: 'socket-closed',
  };
}

async function enqueueClientClose(
  service: AppClientInboxService,
  facts: AuthorisedWsCloseFacts,
): Promise<void> {
  const close = service.enqueueAuthorisedWsClientDisconnect as unknown as (
    input: Readonly<{
      connection: ReturnType<typeof toAuthorisedWsClientConnectEnqueue>['data'];
      disconnectedAtEpochMs: number;
      reason: string;
    }>,
  ) => Promise<unknown>;
  await close.call(service, {
    connection: toAuthorisedWsClientConnectEnqueue({
      authSession: facts.authSession,
      generationId: facts.generationId,
      input: facts.input,
    }).data,
    disconnectedAtEpochMs: facts.disconnectedAtEpochMs,
    reason: facts.reason,
  });
}

async function enqueueGroupClose(
  service: AppGroupInboxService,
  facts: AuthorisedWsCloseFacts,
): Promise<number> {
  return await service.enqueueGroupSessionCleanup({
    connection: toAuthorisedWsClientConnectEnqueue({
      authSession: facts.authSession,
      generationId: facts.generationId,
      input: facts.input,
    }).data,
    disconnectedAtEpochMs: facts.disconnectedAtEpochMs,
    reason: facts.reason,
  });
}

async function createRoom(
  harness: Awaited<ReturnType<typeof createHarness>>,
  groupId: string,
): Promise<void> {
  const pending = processAuthenticated<GroupCreateAppInboxPayload, GroupStateWritten>(
    harness.group,
    harness.authSession,
    {
      type: AppInboxType.GROUP_CREATE,
      resourceId: `create-${groupId}`,
      contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`,
      senderId: harness.authSession.clientId,
      data: {
        scope: SCOPE,
        request: {
          groupId,
          displayName: groupId,
          kind: 'room',
          joinMode: 'open',
          createdByPrincipalId: harness.authSession.clientId,
          actorPrincipalId: harness.authSession.clientId,
          actorSessionId: harness.authSession.sessionId,
          requestId: `create-${groupId}`,
        },
      },
    },
  );
  await waitForQueuedType(harness.queue, AppInboxType.GROUP_CREATE);
  await processNext(harness.reader);
  expect((await pending).right?.status).toBe('created');
}

function enqueueGroupConnect(
  harness: Awaited<ReturnType<typeof createHarness>>,
  groupId: string,
  facts: AuthorisedWsCloseFacts,
  presence: Readonly<{
    generationId: string;
    connectedAtEpochMs: number;
    expiresAtEpochMs: number;
  }> = groupPresenceFacts(facts, facts.generationId, 0),
) {
  return processAuthenticated<GroupPresenceConnectAppInboxPayload, GroupStateWritten>(
    harness.group,
    harness.authSession,
    {
      type: AppInboxType.GROUP_PRESENCE_CONNECT,
      resourceId: `presence-${groupId}-${presence.generationId}`,
      contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`,
      senderId: harness.authSession.clientId,
      data: {
        scope: SCOPE,
        groupId,
        sessionId: facts.authSession.sessionId,
        request: {
          principalId: facts.authSession.clientId,
          generationId: presence.generationId,
          connectedAtEpochMs: presence.connectedAtEpochMs,
          lastHeartbeatAtEpochMs: presence.connectedAtEpochMs,
          expiresAtEpochMs: presence.expiresAtEpochMs,
          actorPrincipalId: facts.authSession.clientId,
          actorSessionId: facts.authSession.sessionId,
          requestId: `presence-${groupId}-${presence.generationId}`,
        },
      },
    },
  );
}

function processAuthenticated<V, R>(
  service: AppGroupInboxService,
  authority: IssuedAuthSession,
  enqueue: AppInboxEnqueueInput<V>,
): Promise<import('@shared/resilience/Either.ts').Either<string, R>> {
  return service.processAuthenticatedEntryUntilCompletion<V, R>(enqueue, authority);
}

async function activeGroupSessionCount(
  harness: Awaited<ReturnType<typeof createHarness>>,
  groupId: string,
): Promise<number> {
  return (await harness.groups.listAllPresenceSessions()).filter((session) =>
    session.groupId === groupId && session.disconnectedAtEpochMs === null
  ).length;
}

function issuedSession(clientId: string, sessionId: string): IssuedAuthSession {
  return {
    clientId,
    sessionId,
    accessToken: `${clientId}-token`,
    username: clientId,
    issuedAtEpochMs: NOW_EPOCH_MS - 1_000,
    expiresAtEpochMs: NOW_EPOCH_MS + 60_000,
  };
}
