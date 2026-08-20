import { expect } from 'vitest';

import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { ClientSessionConnectAppInboxPayload } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-contracts.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import type { ClientStateWritten } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { InMemoryClientStateEventStore } from '@shared-server/rallar-system/repositories/StateEventStore.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';

import { createAppInboxTestDatabase } from '../app-inbox-test-database.ts';
import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';
import {
  TestResourceInbox,
  TestResourceInboxResults,
  createAutoAuthorizingClientStateService,
  processAppInbox,
} from './app-client-inbox-mutation-test-harness.ts';

const SCOPE = { applicationId: 'ar-eye-hunter', workspaceId: 'default' } as const;

export async function createRollbackHarness() {
  const queue = new TestResourceInbox();
  const reader = new InboxQueueReader(queue);
  const results = new TestResourceInboxResults();
  const runtimeRepository = new FakeRuntimeStateRepository();
  const eventStore = new InMemoryClientStateEventStore();
  const repository = new ClientStateRepository(runtimeRepository, { events: eventStore });
  const key = {
    topicId: 'app-inbox.client-state',
    resourceId: 'connect-client-rollback',
    contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:alice`,
  };
  let failOutbox = true;
  let rollbackAssertions = 0;
  let database!: ReturnType<typeof createAppInboxTestDatabase>;
  database = createAppInboxTestDatabase(queue, results, {
    runtimeRepository,
    clientEventStore: eventStore,
    shouldFailOutboxWrite: () => {
      if (!failOutbox) return false;
      failOutbox = false;
      return true;
    },
    withTransaction: async (write) => restoreEventsAfterFailure(eventStore, write),
    onTransactionRollback: async () => {
      rollbackAssertions += 1;
      await expectRolledBackMutationState({ database, key, queue, repository, results });
    },
  });
  const service = new AppClientInboxService(
    {
      inboxQueueReader: reader,
      resourceInboxRepository: queue,
      resourceInboxResultsRepository: results,
      database: database,
      clientStateService: createAutoAuthorizingClientStateService(
        runtimeRepository,
        database,
        eventStore,
      ),
    },
    {
      serviceId: 'server-12345678',
    },
  );
  return { key, queue, reader, results, service, rollbackAssertions: () => rollbackAssertions };
}

type RollbackHarness = Awaited<ReturnType<typeof createRollbackHarness>>;

export function processRollbackMutation(harness: RollbackHarness) {
  const connectedAtEpochMs = Date.now();
  return processAppInbox<ClientSessionConnectAppInboxPayload, ClientStateWritten>(
    harness.service,
    harness.reader,
    {
      type: AppInboxType.CLIENT_SESSION_CONNECT,
      ...harness.key,
      senderId: 'alice',
      data: {
        scope: SCOPE,
        principalId: 'alice',
        clientInstanceId: 'alice-browser',
        sessionId: 'alice-session',
        request: {
          generationId: 'rollback-generation',
          connectedAtEpochMs,
          lastHeartbeatAtEpochMs: connectedAtEpochMs,
          expiresAtEpochMs: connectedAtEpochMs + 60_000,
          actorPrincipalId: 'alice',
          actorSessionId: 'alice-session',
          requestId: 'connect-client-rollback',
        },
      },
    },
  );
}

async function restoreEventsAfterFailure<T>(
  eventStore: InMemoryClientStateEventStore,
  write: () => Promise<T>,
): Promise<T> {
  const before = [...eventStore.events];
  try {
    return await write();
  } catch (error) {
    eventStore.events.length = 0;
    eventStore.events.push(...before);
    throw error;
  }
}

interface RolledBackMutationState {
  readonly database: ReturnType<typeof createAppInboxTestDatabase>;
  readonly key: {
    readonly topicId: string;
    readonly resourceId: string;
    readonly contextId: string;
  };
  readonly queue: TestResourceInbox;
  readonly repository: ClientStateRepository;
  readonly results: TestResourceInboxResults;
}

async function expectRolledBackMutationState(state: RolledBackMutationState): Promise<void> {
  const principalRef = { ...SCOPE, principalId: 'alice' };
  expect(await state.repository.findPrincipal(principalRef)).toBeUndefined();
  expect(
    await state.repository.findInstance({ ...principalRef, clientInstanceId: 'alice-browser' }),
  ).toBeUndefined();
  expect(
    await state.repository.findSession({
      ...principalRef,
      clientInstanceId: 'alice-browser',
      sessionId: 'alice-session',
    }),
  ).toBeUndefined();
  expect(
    await state.repository.findIdempotentClientMutationReceipt(
      principalRef,
      'connect-client-rollback',
    ),
  ).toBeUndefined();
  expect(await state.repository.listEvents(principalRef)).toEqual([]);
  expect(state.database.outboxEntries.size).toBe(0);
  expect(await state.results.findByKey(state.key)).toBeUndefined();
  expect((await state.queue.getItem(state.key))?.status).toBe(EntityStatus.RESERVED);
}
