import { describe, expect, it } from 'vitest';

import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { InMemoryClientStateEventStore } from '@shared-server/rallar-system/repositories/StateEventStore.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import {
  AppClientInboxService,
  AppInboxType,
} from '@shared-server/rallar-system/services/AppClientInboxService.ts';
import {
  createClientStateService,
  toClientMutationCommand,
  toClientMutationIssuedSessionAuthority,
  toUpsertPrincipalCommandInput,
} from '@shared-server/rallar-system/services/client-state-service.ts';

import { createAppInboxTestDatabase } from '../app-inbox-test-database.ts';
import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';
import {
  CLIENT_STATE_TEST_SCOPE as SCOPE,
  TestResourceInbox,
  TestResourceInboxResults,
  createResilience,
  issuedSession,
  processAuthenticatedClientMutation,
  readEntries,
} from './app-client-inbox-mutation-test-harness.ts';

describe('AppClientInbox authentication', () => {
  it('does not trust a persisted Mallory actor claim for Alice authority', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const authSessions = new AuthSessionRepository(runtimeRepository);
    const mallory = issuedSession('mallory', 'mallory-session');
    await authSessions.putSession(mallory);
    const service = createClientStateService({
      runtimeRepository,
      serviceId: 'server-12345678',
    });
    const command = await toClientMutationCommand(
      toUpsertPrincipalCommandInput(
        SCOPE,
        'alice',
        {
          username: 'alice',
          displayName: 'Mallory controlled',
          actorPrincipalId: 'mallory',
          actorSessionId: 'mallory-session',
          requestId: 'direct-mallory-targets-alice',
        },
        'direct-mallory-targets-alice',
      ),
      {
        nowEpochMs: Date.now(),
        serviceId: 'server-12345678',
        eventId: 'direct-mallory-targets-alice-event',
        attemptCount: 1,
        expireAtEpochMs: Date.now() + 60_000,
      },
      toClientMutationIssuedSessionAuthority(mallory, SCOPE, 'upsertPrincipal'),
    );
    const read = await service.read(command);
    const computed = service.compute(command, read);

    expect(() => service.validate(command, read, computed)).toThrow(
      /authority|authenticated|principal/i,
    );
  });

  it('rejects a durable Mallory authority targeting Alice before any domain write', async () => {
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new TestResourceInboxResults();
    const runtimeRepository = new FakeRuntimeStateRepository();
    const database = createAppInboxTestDatabase(queue, results, {
      runtimeRepository,
    });
    const authSessions = new AuthSessionRepository(runtimeRepository);
    const mallory = issuedSession('mallory', 'mallory-session');
    await authSessions.putSession(mallory);
    const service = new AppClientInboxService(
      reader,
      queue as never,
      results as never,
      database,
      createClientStateService({
        runtimeRepository,
        createClientStateEventStore: () => new InMemoryClientStateEventStore(),
        serviceId: 'server-12345678',
      }),
      'server-12345678',
    );

    await expect(
      processAuthenticatedClientMutation(
        service,
        {
          type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
          resourceId: 'mallory-targets-alice',
          contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:alice`,
          senderId: 'mallory',
          data: {
            scope: SCOPE,
            principalId: 'alice',
            request: {
              username: 'alice',
              displayName: 'Mallory controlled',
              actorPrincipalId: 'mallory',
              requestId: 'mallory-targets-alice',
            },
          },
        },
        mallory,
      ),
    ).rejects.toThrow(/principal|authority|authenticated/i);

    expect(
      await new ClientStateRepository(runtimeRepository).readSnapshot({
        ...SCOPE,
        principalId: 'alice',
      }),
    ).toBeUndefined();
    expect(database.outboxEntries.size).toBe(0);
  });

  it('rereads revoked durable authority after an outer AppInbox CAS retry', async () => {
    const harness = await createRevokedAuthorityRetryHarness();
    const pending = startRevokedAuthorityMutation(harness);

    await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
    await new Promise((resolve) => setTimeout(resolve, 2));
    await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

    const result = await pending;
    expect(result.left).toMatch(/expired|missing|revoked|authority|authenticated/i);
    expect(harness.wasRevoked()).toBe(true);
    expect(
      await new ClientStateRepository(harness.runtimeRepository).readSnapshot({
        ...SCOPE,
        principalId: 'alice',
      }),
    ).toBeUndefined();
    expect(harness.database.outboxEntries.size).toBe(0);
    const [entry] = await readEntries(harness.queue);
    expect(entry.dequeueAudit.attempts).toBe(2);
  });
});

async function createRevokedAuthorityRetryHarness() {
  const queue = new TestResourceInbox();
  const reader = new InboxQueueReader(queue);
  const results = new TestResourceInboxResults();
  const runtimeRepository = new FakeRuntimeStateRepository();
  const authSessions = new AuthSessionRepository(runtimeRepository);
  const alice = issuedSession('alice', 'alice-session');
  await authSessions.putSession(alice);
  let injectedConflict = false;
  runtimeRepository.beforeConditionalWrite = async (operation, namespace, key) => {
    if (
      !injectedConflict &&
      operation === 'insertIfAbsent' &&
      namespace === 'client-state:principals'
    ) {
      injectedConflict = true;
      runtimeRepository.data.set(`${namespace}::${key}`, {
        key,
        value: JSON.stringify({ competing: true }),
        expireAtTimestamp: Number.MAX_SAFE_INTEGER,
        updatedTimestamp: new Date().toISOString(),
        revision: 0,
      });
    }
  };
  let revoked = false;
  const database = createAppInboxTestDatabase(queue, results, {
    runtimeRepository,
    onTransactionRollback: async () => {
      if (injectedConflict && !revoked) {
        revoked = true;
        await authSessions.deleteSession(alice);
      }
    },
  });
  const service = new AppClientInboxService(
    reader,
    queue as never,
    results as never,
    database,
    createClientStateService({
      runtimeRepository,
      createClientStateEventStore: () => new InMemoryClientStateEventStore(),
      serviceId: 'server-12345678',
    }),
    'server-12345678',
  );
  return { alice, database, queue, reader, runtimeRepository, service, wasRevoked: () => revoked };
}

type RevokedAuthorityRetryHarness = Awaited<ReturnType<typeof createRevokedAuthorityRetryHarness>>;

function startRevokedAuthorityMutation(harness: RevokedAuthorityRetryHarness) {
  return processAuthenticatedClientMutation(
    harness.service,
    {
      type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
      resourceId: 'alice-revoked-after-conflict',
      contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:alice`,
      senderId: 'alice',
      data: {
        scope: SCOPE,
        principalId: 'alice',
        request: {
          username: 'alice',
          displayName: 'Must not commit',
          actorPrincipalId: 'alice',
          requestId: 'alice-revoked-after-conflict',
        },
      },
    },
    harness.alice,
  );
}
