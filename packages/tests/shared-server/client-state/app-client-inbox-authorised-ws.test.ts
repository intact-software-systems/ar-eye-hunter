import { Temporal } from '@js-temporal/polyfill';
import { expect, it } from 'vitest';

import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/Resilience.ts';
import { Either } from '@shared/resilience/Either.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import {
  AuthSessionRepository,
  type IssuedAuthSession,
} from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
// prettier-ignore
import {
  AppClientInboxService,
} from
'@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
// prettier-ignore
import {
  toAuthorisedWsClientConnectEnqueue,
} from
'@shared-server/rallar-system/client-state/inbox/authorised-ws-client-app-inbox.ts';
import {
  type ClientMutationWritten,
  type ClientStateWritten,
  createClientStateService,
} from '@shared-server/rallar-system/client-state/client-state-service.ts';

import { createAppInboxTestDatabase } from '../app-inbox-test-database.ts';
import { TestResourceInbox, TestResourceInboxResults } from '../app-auth-inbox-test-harness.ts';
import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';

const SERVICE_ID = 'server-12345678';

it('rejects authorised websocket disconnect after durable auth revocation', async () => {
  const queue = new TestResourceInbox();
  const reader = new InboxQueueReader(queue);
  const results = new TestResourceInboxResults();
  const authSession = issuedSession('alice', 'alice-ws-session');
  const runtimeRepository = new FakeRuntimeStateRepository();
  const authSessions = new AuthSessionRepository(runtimeRepository);
  await authSessions.putSession(authSession);
  const database = createAppInboxTestDatabase(queue, results, { runtimeRepository });
  const service = createAuthorisedWsService({
    database,
    queue,
    reader,
    results,
    runtimeRepository,
  });

  const connectInput = {
    authSession,
    generationId: 'generation-1',
    input: {
      expiresAtEpochMs: Date.now() + 60_000,
      userAgent: 'Browser',
    },
  } as const;
  const connected = await processAppInboxMethod(reader, () =>
    service.processAuthorisedWsClientConnect(connectInput),
  );
  await authSessions.deleteSession(authSession);
  const disconnected = await processAppInboxMethod(reader, () =>
    service.processAuthorisedWsClientDisconnect({
      connection: toAuthorisedWsClientConnectEnqueue(connectInput).data,
      disconnectedAtEpochMs: Date.now(),
      reason: 'socket-closed',
    }),
  );
  expect(disconnected.left).toMatch(/authority|auth session/i);

  expect(requireRightSnapshot(connected).activeSessions).toHaveLength(1);
  expect(requireRightSnapshot(connected).instances[0]).toMatchObject({
    clientInstanceId: 'alice',
    userAgent: 'Browser',
  });
  expect(requireRightSnapshot(connected).activeSessions).toHaveLength(1);
});

it('processes authorised websocket connects in the requested state scope', async () => {
  const queue = new TestResourceInbox();
  const reader = new InboxQueueReader(queue);
  const results = new TestResourceInboxResults();
  const authSession = issuedSession('admin', 'admin-ws-session');
  const runtimeRepository = new FakeRuntimeStateRepository();
  await new AuthSessionRepository(runtimeRepository).putSession(authSession);
  const database = createAppInboxTestDatabase(queue, results, { runtimeRepository });
  const service = createAuthorisedWsService({
    database,
    queue,
    reader,
    results,
    runtimeRepository,
  });

  const connected = await processAppInboxMethod(reader, () =>
    service.processAuthorisedWsClientConnect({
      authSession,
      generationId: 'generation-admin',
      input: {
        applicationId: 'ar-eye-hunter',
        workspaceId: 'default',
        expiresAtEpochMs: Date.now() + 60_000,
        userAgent: 'Browser',
      },
    }),
  );

  const snapshot = requireRightSnapshot(connected);
  expect(snapshot.principal).toMatchObject({
    applicationId: 'ar-eye-hunter',
    workspaceId: 'default',
    principalId: 'admin',
    username: 'admin',
  });
  expect(snapshot.instances[0]).toMatchObject({
    applicationId: 'ar-eye-hunter',
    workspaceId: 'default',
    clientInstanceId: 'admin',
    userAgent: 'Browser',
  });
  expect(snapshot.activeSessions[0]).toMatchObject({
    applicationId: 'ar-eye-hunter',
    workspaceId: 'default',
    clientInstanceId: 'admin',
    sessionId: 'admin-ws-session',
    transport: 'ws',
  });
});

it('processes authorised websocket connects independently per state scope', async () => {
  const queue = new TestResourceInbox();
  const reader = new InboxQueueReader(queue);
  const results = new TestResourceInboxResults();
  const authSession = issuedSession('admin', 'admin-ws-session');
  const runtimeRepository = new FakeRuntimeStateRepository();
  await new AuthSessionRepository(runtimeRepository).putSession(authSession);
  const database = createAppInboxTestDatabase(queue, results, { runtimeRepository });
  const service = createAuthorisedWsService({
    database,
    queue,
    reader,
    results,
    runtimeRepository,
  });

  const defaultConnect = await processAppInboxMethod(reader, () =>
    service.processAuthorisedWsClientConnect({
      authSession,
      generationId: 'generation-default',
      input: {
        applicationId: 'rallar-server',
        workspaceId: 'default',
      },
    }),
  );
  const scopedConnect = await processAppInboxMethod(reader, () =>
    service.processAuthorisedWsClientConnect({
      authSession,
      generationId: 'generation-scoped',
      input: {
        applicationId: 'ar-eye-hunter',
        workspaceId: 'default',
      },
    }),
  );

  expect(requireRightSnapshot(defaultConnect).principal).toMatchObject({
    applicationId: 'rallar-server',
    workspaceId: 'default',
  });
  expect(requireRightSnapshot(scopedConnect).principal).toMatchObject({
    applicationId: 'ar-eye-hunter',
    workspaceId: 'default',
  });
});

it(
  [
    'disconnects authorised websocket sessions from their connected state scope',
    'while auth exists',
  ].join(' '),
  async () => {
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new TestResourceInboxResults();
    const authSession = issuedSession('admin', 'admin-ws-session');
    const runtimeRepository = new FakeRuntimeStateRepository();
    await new AuthSessionRepository(runtimeRepository).putSession(authSession);
    const database = createAppInboxTestDatabase(queue, results, { runtimeRepository });
    const service = createAuthorisedWsService({
      database,
      queue,
      reader,
      results,
      runtimeRepository,
    });

    const connectInput = {
      authSession,
      generationId: 'generation-scoped',
      input: {
        applicationId: 'ar-eye-hunter',
        workspaceId: 'default',
        expiresAtEpochMs: Date.now() + 60_000,
      },
    } as const;
    await processAppInboxMethod(reader, () =>
      service.processAuthorisedWsClientConnect(connectInput),
    );
    const disconnected = await processAppInboxMethod(reader, () =>
      service.processAuthorisedWsClientDisconnect({
        connection: toAuthorisedWsClientConnectEnqueue(connectInput).data,
        disconnectedAtEpochMs: Date.now(),
        reason: 'socket-closed',
      }),
    );

    expect(requireRightSnapshot(disconnected).principal).toMatchObject({
      applicationId: 'ar-eye-hunter',
      workspaceId: 'default',
      principalId: 'admin',
    });
    expect(requireRightSnapshot(disconnected).activeSessions).toHaveLength(0);
    expect(requireRightWritten(disconnected).event).toMatchObject({
      applicationId: 'ar-eye-hunter',
      workspaceId: 'default',
      eventType: 'session-disconnected',
    });
  },
);

interface CreateAuthorisedWsServiceInput {
  readonly database: ReturnType<typeof createAppInboxTestDatabase>;
  readonly queue: TestResourceInbox;
  readonly reader: InboxQueueReader;
  readonly results: TestResourceInboxResults;
  readonly runtimeRepository: FakeRuntimeStateRepository;
}

function createAuthorisedWsService(input: CreateAuthorisedWsServiceInput): AppClientInboxService {
  return new AppClientInboxService(
    input.reader,
    input.queue as never,
    input.results as never,
    input.database,
    createClientStateService({
      runtimeRepository: input.runtimeRepository,
      createClientStateEventStore: () => input.database.clientEventStore,
      serviceId: SERVICE_ID,
    }),
    SERVICE_ID,
  );
}

function requireRightSnapshot(result: Either<string, ClientStateWritten>): ClientSnapshot {
  if (!result.right) throw new Error(result.left ?? 'Expected client app-inbox right result');
  return requireClientMutationWritten(result.right).snapshot;
}

function requireRightWritten(result: Either<string, ClientStateWritten>): ClientMutationWritten {
  if (!result.right) throw new Error(result.left ?? 'Expected client app-inbox right result');
  return requireClientMutationWritten(result.right);
}

function requireClientMutationWritten(written: ClientStateWritten): ClientMutationWritten {
  const result = written.result as
    ClientStateWritten['result'] | { left?: string; right?: ClientMutationWritten };
  if ('fold' in result && typeof result.fold === 'function') {
    return result.fold(
      (error) => {
        throw new Error(error);
      },
      (value) => value,
    );
  }
  if (result.right) return result.right;
  throw new Error(result.left ?? 'Client mutation failed');
}

function issuedSession(clientId: string, sessionId: string): IssuedAuthSession {
  const nowEpochMs = Date.now();
  return {
    clientId,
    accessToken: `${clientId}-token`,
    username: clientId,
    sessionId,
    issuedAtEpochMs: nowEpochMs - 1_000,
    expiresAtEpochMs: nowEpochMs + 60_000,
  };
}

async function processAppInboxMethod<R>(
  reader: InboxQueueReader,
  run: () => Promise<R>,
): Promise<R> {
  const resultPromise = run();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
  return await resultPromise;
}

function createResilience(): ResilienceDto {
  const duration = Temporal.Duration.from({ seconds: 10 });
  return ResilienceDto.toResilienceDto(
    new CircuitBreakerPolicy(10, duration, duration, duration),
    1,
    10,
    1,
    1,
  );
}
