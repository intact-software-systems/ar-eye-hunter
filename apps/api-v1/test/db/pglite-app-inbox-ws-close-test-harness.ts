import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import {
  createClientStateEventRepository,
  createGroupStateEventRepository,
} from '@shared-server/postgres/rallar-system/createStateRepositories.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
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
import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';
import { FUTURE_MS } from './pglite-auth-test-harness.ts';

export async function createPGliteAppInboxWsCloseHarness(sql: PGliteSql) {
  const runtime = new PSqlRuntimeStateRepository(sql);
  const resourceInbox = new ResourceInboxRepository(sql);
  const resourceResults = new ResourceInboxResultsRepository(sql);
  const reader = new InboxQueueReader(new PSqlQueueBox(resourceInbox));
  const secondReader = new InboxQueueReader(new PSqlQueueBox(resourceInbox));
  const authority = {
    clientId: 'owner',
    username: 'owner',
    sessionId: 'owner-session',
    accessToken: 'owner-token',
    issuedAtEpochMs: Date.now() - 2_000,
    expiresAtEpochMs: FUTURE_MS,
  };
  const authSessions = new AuthSessionRepository(runtime);
  await authSessions.putSession(authority);
  const options = {
    waitMaxElapsedMsecs: 5_000,
    waitRetryIntervalMsecs: 1,
    waitMaxRetryIntervalMsecs: 4,
    waitJitterRatio: 0,
  } as const;
  const groupEvents = createGroupStateEventRepository(runtime);
  const clientState = createClientStateService({
    runtimeRepository: runtime,
    createClientStateEventStore: createClientStateEventRepository,
    serviceId: 'pglite-close-test',
  });
  const groupState = createGroupStateService({
    runtimeRepository: runtime,
    createGroupStateEventStore: createGroupStateEventRepository,
    authSessionRepository: authSessions,
    serviceId: 'pglite-close-test',
  });
  const client = new AppClientInboxService(
    reader,
    resourceInbox,
    resourceResults,
    sql,
    clientState,
    'pglite-close-test',
    undefined,
    options,
  );
  const group = new AppGroupInboxService(
    reader,
    resourceInbox,
    resourceResults,
    sql,
    groupState,
    'pglite-close-test',
    undefined,
    options,
  );
  new AppClientInboxService(
    secondReader,
    resourceInbox,
    resourceResults,
    sql,
    clientState,
    'pglite-close-test',
    undefined,
    options,
  );
  new AppGroupInboxService(
    secondReader,
    resourceInbox,
    resourceResults,
    sql,
    groupState,
    'pglite-close-test',
    undefined,
    options,
  );
  return {
    authority,
    reader,
    secondReader,
    client,
    group,
    clientState,
    groupState,
    clients: new ClientStateRepository(runtime, {
      events: createClientStateEventRepository(runtime),
    }),
    groups: new GroupStateRepository(runtime, { events: groupEvents }),
  };
}

export function pauseNextPGliteLifecycleRead(
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
