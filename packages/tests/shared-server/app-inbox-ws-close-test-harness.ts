import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/services/AppClientInboxService.ts';
import { AppGroupInboxService } from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import {
  type ClientStateService,
  createClientStateService,
} from '@shared-server/rallar-system/services/client-state-service.ts';
import {
  createGroupStateService,
  type GroupStateService,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import { TestResourceInbox, TestResourceInboxResults } from './auth/auth-app-inbox-test-runtime.ts';
import { createAppInboxTestDatabase } from './app-inbox-test-database.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

const NOW_EPOCH_MS = 1_800_000_000_000;
const SCOPE: StateScope = { applicationId: 'ar-eye-hunter', workspaceId: 'default' };

export interface AuthorisedWsCloseFacts {
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

export function createAuthorisedWsCloseFacts(
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

export async function createAppInboxWsCloseHarness(options: Readonly<{
  onRollback?: () => void;
  onConditionalWrite?: (
    operation: 'insertIfAbsent' | 'upsertIfRevision' | 'deleteIfRevision',
    namespace: string,
    key: string,
  ) => void;
}> = {}) {
  const queue = new TestResourceInbox();
  const reader = new InboxQueueReader(queue);
  const secondReader = new InboxQueueReader(queue);
  const results = new TestResourceInboxResults();
  const runtimeRepository = new FakeRuntimeStateRepository();
  runtimeRepository.beforeConditionalWrite = options.onConditionalWrite;
  const database = createAppInboxTestDatabase(queue, results, {
    runtimeRepository,
    onTransactionRollback: options.onRollback,
  });
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
  const clientState = createClientStateService({
    runtimeRepository,
    createClientStateEventStore: () => database.clientEventStore,
    serviceId: 'server-12345678',
  });
  const client = new AppClientInboxService(
    reader,
    queue as never,
    results as never,
    database,
    clientState,
    'server-12345678',
  );
  const group = new AppGroupInboxService(
    reader,
    queue as never,
    results as never,
    database,
    groupState,
    'server-12345678',
  );
  new AppClientInboxService(
    secondReader,
    queue as never,
    results as never,
    database,
    clientState,
    'server-12345678',
  );
  new AppGroupInboxService(
    secondReader,
    queue as never,
    results as never,
    database,
    groupState,
    'server-12345678',
  );
  return {
    queue,
    reader,
    secondReader,
    authSession,
    client,
    group,
    clientState,
    groupState,
    clients: new ClientStateRepository(runtimeRepository),
    groups: new GroupStateRepository(runtimeRepository, { events: database.groupEventStore }),
  };
}

export function pauseNextLifecycleRead(
  state: Pick<ClientStateService | GroupStateService, 'sessionGenerationLifecycle'>,
): Readonly<{ reached: Promise<void>; resume(): void }> {
  const lifecycle = state.sessionGenerationLifecycle;
  const originalRead = lifecycle.read.bind(lifecycle);
  let release!: () => void;
  let announce!: () => void;
  const reached = new Promise<void>((resolve) => announce = resolve);
  const resumed = new Promise<void>((resolve) => release = resolve);
  let pause = true;
  lifecycle.read = async (identity) => {
    const read = await originalRead(identity);
    if (pause) {
      pause = false;
      announce();
      await resumed;
    }
    return read;
  };
  return { reached, resume: release };
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
