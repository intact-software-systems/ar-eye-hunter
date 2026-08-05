import { expect, it, vi } from 'vitest';

import type { ClientPrincipalRef } from '@shared/api/client-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
// prettier-ignore
import {
  ClientStateRepository,
} from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import {
  type ClientStateService,
  type ClientStateWritten,
  createClientStateService,
} from '@shared-server/rallar-system/client-state/client-state-service.ts';
// prettier-ignore
import {
  AppClientInboxService,
} from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import {
  type ClientExpiredSessionsAppInboxPayload,
  type ClientSessionConnectAppInboxPayload,
} from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-contracts.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';

import { createAppInboxTestDatabase } from '../app-inbox-test-database.ts';
import { createResilience } from '../app-auth-inbox-test-harness.ts';
import { createClientStatePhaseTestDriver } from '../client-state-phase-test-driver.ts';
import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';
import {
  ClientExpiryTestResourceInbox,
  ClientExpiryTestResourceInboxResults,
  createClientExpiryTestIssuedAuthority,
  listActiveClientExpiryTestEntries,
  readClientExpiryTestEnqueueData,
  readClientExpiryTestEntries,
} from './app-client-inbox-expiry-fixtures.ts';

const SCOPE: StateScope = { applicationId: 'ar-eye-hunter', workspaceId: 'default' };

interface SeedClientExpirySessionInput {
  readonly expiresAtEpochMs: number;
  readonly runtimeRepository: FakeRuntimeStateRepository;
}

// prettier-ignore
it(
  'processes expired client sessions through the inbox and publishes written mutations',
  async () => {
    const queue = new ClientExpiryTestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new ClientExpiryTestResourceInboxResults();
    const runtimeRepository = new FakeRuntimeStateRepository();
    const publisher = createPublisher();
    const expiresAtEpochMs = Date.now() - 1_000;
    const database = createAppInboxTestDatabase(queue, results, { runtimeRepository });
    const clientStateService = createClientStateService({
      runtimeRepository,
      createClientStateEventStore: () => database.clientEventStore,
      serviceId: 'server-12345678',
    });
    const service = new AppClientInboxService(
      reader,
      queue as never,
      results as never,
      database,
      clientStateService,
      'server-12345678',
    );
    await seedClientExpirySession(service, reader, { expiresAtEpochMs, runtimeRepository });

    const expired = await processClientInbox(reader, () =>
      service.processExpiredSessions(expiresAtEpochMs + 1),
    );

    expect(expired.right).toHaveLength(1);
    expect(expired.right?.[0].result.right?.event).toMatchObject({
      eventType: 'session-expired',
      reason: 'expired',
      sessionId: 'alice-session',
    });
    expect(expired.right?.[0].result.right?.snapshot.activeSessions).toEqual([]);
    expect(publisher.publishClientSnapshot).not.toHaveBeenCalled();
    expect(publisher.publishClientEvent).not.toHaveBeenCalled();
  },
);

it('keeps at most one active waiting client expiry entry across timestamps', async () => {
  const queue = new ClientExpiryTestResourceInbox();
  const reader = new InboxQueueReader(queue);
  const results = new ClientExpiryTestResourceInboxResults();
  const listExpiredSessionCandidates = vi.fn(async () => []);
  const service = new AppClientInboxService(
    reader,
    queue as never,
    results as never,
    createAppInboxTestDatabase(queue, results),
    createClientStateServiceStub({ listExpiredSessionCandidates }),
    'server-12345678',
  );

  const first = service.processExpiredSessions(60_000);
  const second = service.processExpiredSessions(120_000);

  await waitForQueueEntryCount(queue, 1);
  const entries = await readClientExpiryTestEntries(queue);

  expect(listActiveClientExpiryTestEntries(entries)).toHaveLength(1);
  expect(entries[0].key.resourceId).toBe('expire-client-sessions');
  expect(
    readClientExpiryTestEnqueueData<ClientExpiredSessionsAppInboxPayload>(entries[0]).atEpochMs,
  ).toBe(60_000);

  await dequeueClientInbox(reader);

  await expect(first).resolves.toMatchObject({ right: [] });
  await expect(second).resolves.toMatchObject({ right: [] });
  expect(listExpiredSessionCandidates).toHaveBeenCalledTimes(1);
  expect(listExpiredSessionCandidates).toHaveBeenLastCalledWith(60_000);
});

it('durably enqueues each client expiry reconciliation tick', async () => {
  const queue = new ClientExpiryTestResourceInbox();
  const reader = new InboxQueueReader(queue);
  const results = new ClientExpiryTestResourceInboxResults();
  const listExpiredSessionCandidates = vi.fn(async () => []);
  const service = new AppClientInboxService(
    reader,
    queue as never,
    results as never,
    createAppInboxTestDatabase(queue, results),
    createClientStateServiceStub({ listExpiredSessionCandidates }),
    'server-12345678',
  );

  const first = await service.enqueueExpiredSessions(60_000);
  const second = await service.enqueueExpiredSessions(120_000);
  expect(first.key.resourceId).toBe('expire-client-sessions-60000');
  expect(second.key.resourceId).toBe('expire-client-sessions-120000');
  expect(await readClientExpiryTestEntries(queue)).toHaveLength(2);
  expect(listExpiredSessionCandidates).not.toHaveBeenCalled();
});

it('expires stale sessions once and leaves publication to the app inbox', async () => {
  const runtimeRepository = new FakeRuntimeStateRepository();
  const expiresAtEpochMs = Date.now() - 1_000;
  await seedConnectedSession(runtimeRepository, expiresAtEpochMs);

  const publisher = createPublisher();
  const now = expiresAtEpochMs + 1;
  const service = createClientStatePhaseTestDriver(runtimeRepository, () => now);
  const principalRef = toClientPrincipalRef('alice');

  const first = await service.expireExpiredSessions(now);
  const second = await service.expireExpiredSessions(now);

  expect(first).toHaveLength(1);
  expect(second).toEqual([]);
  expect(first[0].result.right?.event).toMatchObject({
    eventType: 'session-expired',
    reason: 'expired',
    sessionId: 'session-1',
  });
  expect(first[0].result.right?.snapshot).toMatchObject({
    principal: { snapshotVersion: 2, presenceVersion: 2 },
    activeSessions: [],
    isOnline: false,
  });

  const repository = new ClientStateRepository(runtimeRepository);
  expect(
    await repository.findSession({
      ...principalRef,
      clientInstanceId: 'alice-browser',
      sessionId: 'session-1',
    }),
  ).toMatchObject({
    status: 'expired',
    disconnectReason: 'expired',
    disconnectedAtEpochMs: expiresAtEpochMs,
  });
  expect((await repository.listEvents(principalRef)).map((event) => event.eventType)).toEqual([
    'session-connected',
    'session-expired',
  ]);
  expect(publisher.publishClientSnapshot).not.toHaveBeenCalled();
  expect(publisher.publishClientEvent).not.toHaveBeenCalled();
});

it('does not rewrite an expired session when a late disconnect cleanup arrives', async () => {
  const runtimeRepository = new FakeRuntimeStateRepository();
  const expiresAtEpochMs = Date.now() - 1_000;
  await seedConnectedSession(runtimeRepository, expiresAtEpochMs);
  runtimeRepository.locks.splice(0);

  const now = expiresAtEpochMs + 1;
  const service = createClientStatePhaseTestDriver(runtimeRepository, () => now);
  const principalRef = toClientPrincipalRef('alice');

  await service.expireExpiredSessions(now);
  const lateDisconnect = await service.disconnectSession(
    SCOPE,
    principalRef.principalId,
    'alice-browser',
    'session-1',
    {
      generationId: 'generation-session-1',
      reason: 'socket-closed',
      actorPrincipalId: 'alice',
      actorSessionId: 'session-1',
      requestId: 'late-disconnect-after-expiry',
    },
  );

  expect(lateDisconnect.result.right?.event).toBeNull();
  const repository = new ClientStateRepository(runtimeRepository);
  expect(
    await repository.findSession({
      ...principalRef,
      clientInstanceId: 'alice-browser',
      sessionId: 'session-1',
    }),
  ).toMatchObject({
    status: 'expired',
    disconnectReason: 'expired',
    disconnectedAtEpochMs: expiresAtEpochMs,
  });
  expect((await repository.listEvents(principalRef)).map((event) => event.eventType)).toEqual([
    'session-connected',
    'session-expired',
  ]);
  expect(runtimeRepository.locks).toEqual([]);
});

it('ignores a late heartbeat from an expired connection generation', async () => {
  const runtimeRepository = new FakeRuntimeStateRepository();
  const expiresAtEpochMs = Date.now() - 1_000;
  await seedConnectedSession(runtimeRepository, expiresAtEpochMs);

  const now = expiresAtEpochMs + 1;
  const service = createClientStatePhaseTestDriver(runtimeRepository, () => now);
  const principalRef = toClientPrincipalRef('alice');

  await service.expireExpiredSessions(now);
  const lateHeartbeat = await service.heartbeatSession(
    SCOPE,
    principalRef.principalId,
    'alice-browser',
    'session-1',
    {
      generationId: 'generation-session-1',
      presenceState: 'online',
      actorPrincipalId: 'alice',
      actorSessionId: 'session-1',
      lastHeartbeatAtEpochMs: now + 1,
      expiresAtEpochMs: now + 60_000,
      requestId: 'late-heartbeat-after-expiry',
    },
  );

  expect(lateHeartbeat.result.right?.event).toBeNull();
  expect(lateHeartbeat.result.right?.snapshot.activeSessions).toHaveLength(0);

  const repository = new ClientStateRepository(runtimeRepository);
  expect(
    await repository.findSession({
      ...principalRef,
      clientInstanceId: 'alice-browser',
      sessionId: 'session-1',
    }),
  ).toMatchObject({ status: 'expired', disconnectReason: 'expired' });
  expect((await repository.listEvents(principalRef)).map((event) => event.eventType)).toEqual([
    'session-connected',
    'session-expired',
  ]);
});

async function seedClientExpirySession(
  service: AppClientInboxService,
  reader: InboxQueueReader,
  input: SeedClientExpirySessionInput,
): Promise<void> {
  const authority = await createClientExpiryTestIssuedAuthority(
    input.runtimeRepository,
    'alice',
    'alice-session',
  );
  const seeded = service.processAuthenticatedEntryUntilCompletion<
    ClientSessionConnectAppInboxPayload,
    ClientStateWritten
  >(
    {
      type: AppInboxType.CLIENT_SESSION_CONNECT,
      resourceId: 'seed-client-expiry-session',
      contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:alice`,
      senderId: 'alice',
      data: {
        scope: SCOPE,
        principalId: 'alice',
        clientInstanceId: 'alice-browser',
        sessionId: 'alice-session',
        request: {
          generationId: 'generation-alice-session',
          presenceState: 'online',
          actorPrincipalId: 'alice',
          actorSessionId: 'alice-session',
          connectedAtEpochMs: input.expiresAtEpochMs - 2_000,
          lastHeartbeatAtEpochMs: input.expiresAtEpochMs - 1_000,
          expiresAtEpochMs: input.expiresAtEpochMs,
          requestId: 'seed-client-expiry-session',
        },
      },
    },
    authority,
  );
  await dequeueClientInbox(reader);
  await seeded;
}

async function processClientInbox<R>(reader: InboxQueueReader, run: () => Promise<R>): Promise<R> {
  const pending = run();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await dequeueClientInbox(reader);
  return await pending;
}

async function dequeueClientInbox(reader: InboxQueueReader): Promise<void> {
  await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
}

async function waitForQueueEntryCount(
  queue: ClientExpiryTestResourceInbox,
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await readClientExpiryTestEntries(queue)).length >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Expected at least ${count} app inbox entries`);
}

function createClientStateServiceStub(overrides: Partial<ClientStateService>): ClientStateService {
  return {
    sessionGenerationLifecycle: {} as never,
    listSnapshots: vi.fn(),
    readSnapshot: vi.fn(),
    readPresenceSnapshot: vi.fn(),
    listEvents: vi.fn(),
    listEventPage: vi.fn(),
    read: vi.fn(),
    compute: vi.fn(),
    validate: vi.fn(),
    write: vi.fn(),
    listExpiredSessionCandidates: vi.fn(async () => []),
    findSessionBySessionId: vi.fn(),
    readIssuedAuthSession: vi.fn(),
    observeSnapshot: vi.fn(async (snapshot) => snapshot),
    ...overrides,
  };
}

async function seedConnectedSession(
  runtimeRepository: FakeRuntimeStateRepository,
  expiresAtEpochMs: number,
): Promise<void> {
  await createClientStatePhaseTestDriver(runtimeRepository, () => 2_000).connectSession(
    SCOPE,
    'alice',
    'alice-browser',
    'session-1',
    {
      generationId: 'generation-session-1',
      presenceState: 'online',
      actorPrincipalId: 'alice',
      actorSessionId: 'session-1',
      connectedAtEpochMs: 2_000,
      lastHeartbeatAtEpochMs: expiresAtEpochMs - 1_000,
      expiresAtEpochMs,
      requestId: 'seed-session-1',
    },
  );
}

function toClientPrincipalRef(principalId: string): ClientPrincipalRef {
  return { ...SCOPE, principalId };
}

function createPublisher() {
  return {
    publishClientSnapshot: vi.fn(async () => undefined),
    publishClientEvent: vi.fn(async () => undefined),
    publishGroupSnapshot: vi.fn(async () => undefined),
    publishGroupEvent: vi.fn(async () => undefined),
  };
}
