import { describe, expect, it, vi } from 'vitest';

import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
// prettier-ignore
import {
  AppClientInboxService,
} from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
// prettier-ignore
import {
  toUpsertPrincipalCommandInput,
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-command.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';
// prettier-ignore
import {
  RuntimeStateWriteConflictError,
} from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';

import { createAppInboxTestDatabase } from '../app-inbox-test-database.ts';
import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';
import {
  createAutoAuthorizingClientStateService,
  createClientStateServiceStub,
  createResilience,
  issuedSession,
  processAppInbox,
  processAuthenticatedClientMutation,
  readEntries,
} from './app-client-inbox-mutation-test-harness.ts';
import {
  TestResourceInbox,
  TestResourceInboxResults,
} from './app-client-inbox-resource-fixtures.ts';
import { createHandlerHarness } from './client-mutation-transaction-boundary-fixture.ts';
import {
  createRollbackHarness,
  processRollbackMutation,
} from './client-mutation-rollback-test-harness.ts';

const SCOPE = { applicationId: 'ar-eye-hunter', workspaceId: 'default' } as const;
const EXPECTED_DURABLE_JSON =
  '{"status":"ok","result":{"right":{"snapshot":{"snapshotVersion":4,"stateRevision":3},' +
  '"event":{"eventId":"event-4"}}}}';

describe('client mutation transaction and outbox', () => {
  it('persists durable JSON bytes before observing the exact committed snapshot', async () => {
    const harness = await createHandlerHarness();

    const result = await harness.handler.processCommand(
      harness.context,
      toUpsertPrincipalCommandInput(
        SCOPE,
        'alice',
        {
          username: 'alice',
          actorPrincipalId: 'alice',
          actorSessionId: 'alice-session',
          requestId: 'client-transaction-result',
        },
        'client-transaction-result',
      ),
    );

    const persisted = await harness.results.findByKey(harness.context.entry.key);
    expect(persisted?.status).toBe(EntityStatus.COMPLETED);
    expect(persisted?.resource).toBe(EXPECTED_DURABLE_JSON);
    expect(Object.keys(JSON.parse(persisted!.resource) as Record<string, unknown>)).toEqual([
      'status',
      'result',
    ]);
    expect(harness.actions).toEqual(['write', 'commit', 'observe']);
    expect(harness.observedSnapshots).toHaveLength(1);
    expect(harness.observedSnapshots[0]).toBe(harness.committedSnapshot);
    expect(result.result.right?.snapshot).toBe(harness.committedSnapshot);
  });

  it('does not observe a snapshot when transaction finalization rejects', async () => {
    const harness = await createHandlerHarness({ failTransaction: true });

    await expect(
      harness.handler.processCommand(
        harness.context,
        toUpsertPrincipalCommandInput(
          SCOPE,
          'alice',
          {
            username: 'alice',
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            requestId: 'client-transaction-failure',
          },
          'client-transaction-failure',
        ),
      ),
    ).rejects.toThrow('injected transaction failure');

    expect(harness.actions).toEqual([]);
    expect(harness.observedSnapshots).toEqual([]);
    expect(await harness.results.findByKey(harness.context.entry.key)).toBeUndefined();
  });
});

describe('client mutation AppInbox retry and rollback', () => {
  it('restarts client phases from read after an AppInbox CAS conflict', async () => {
    const harness = createRetryHarness();

    const resultPromise = processAuthenticatedClientMutation(
      harness.service,
      {
        type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
        resourceId: 'retry-client-alice',
        contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:alice`,
        senderId: 'alice',
        data: {
          scope: SCOPE,
          principalId: 'alice',
          request: {
            username: 'alice',
            displayName: 'recomputed-successor',
            actorPrincipalId: 'alice',
            requestId: 'retry-client-alice',
          },
        },
      },
      issuedSession('alice', 'alice-test-session'),
    );

    await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
    await new Promise((resolve) => setTimeout(resolve, 2));
    await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
    await resultPromise;

    expect(harness.state.phases).toEqual([
      'read',
      'compute',
      'validate',
      'write-conflict',
      'read',
      'compute',
      'validate',
      'write-accepted',
    ]);
    expect(harness.state.serviceLocalSleeps).toEqual([]);
    const [entry] = await readEntries(harness.queue);
    expect(entry.dequeueAudit.attempts).toBe(2);
  });

  it('rolls back every client mutation surface when final WS outbox insertion fails', async () => {
    const harness = await createRollbackHarness();
    const result = await processRollbackMutation(harness);

    expect(result.left).toMatchObject({
      code: 'resource-inbox-invariant-corruption',
      status: 409,
    });
    expect(harness.rollbackAssertions()).toBe(1);
    expect((await harness.queue.getItem(harness.key))?.status).toBe(EntityStatus.FAILED);
    expect(await harness.results.findByKey(harness.key)).toMatchObject({
      status: EntityStatus.FAILED,
    });
  });
});

interface RetryHarnessState {
  readonly phases: string[];
  readonly serviceLocalSleeps: number[];
  writeAttempt: number;
  legacyAttempt: number;
}

function createRetryHarness() {
  const queue = new TestResourceInbox();
  const reader = new InboxQueueReader(queue);
  const results = new TestResourceInboxResults();
  const state: RetryHarnessState = {
    phases: [],
    serviceLocalSleeps: [],
    writeAttempt: 0,
    legacyAttempt: 0,
  };
  return {
    queue,
    reader,
    state,
    service: new AppClientInboxService(
      {
        inboxQueueReader: reader,
        resourceInboxRepository: queue,
        resourceInboxResultsRepository: results,
        database: createAppInboxTestDatabase(queue, results),
        clientStateService: createRetryClientState(state),
      },
      {
        serviceId: 'server-12345678',
      },
    ),
  };
}

function createRetryClientState(state: RetryHarnessState) {
  return createClientStateServiceStub({
    upsertPrincipal: vi.fn(async () => {
      state.legacyAttempt += 1;
      if (state.legacyAttempt === 1) throw new RuntimeStateWriteConflictError();
      return { status: 'ok', result: { right: { accepted: true } } };
    }),
    read: vi.fn(async () => {
      state.phases.push('read');
      return { lifecycle: state.writeAttempt === 0 ? 'active' : 'disabled' };
    }),
    compute: vi.fn((_command, read) => {
      state.phases.push('compute');
      return {
        outcome: 'write',
        lifecycle: (read as { lifecycle: string }).lifecycle,
        snapshot: { recomputed: true },
        event: null,
      };
    }),
    validate: vi.fn(() => state.phases.push('validate')),
    write: vi.fn(async () => writeRetryResult(state)),
    sleep: vi.fn(async (delayMs: number) => {
      state.serviceLocalSleeps.push(delayMs);
    }),
  } as never);
}

function writeRetryResult(state: RetryHarnessState) {
  state.writeAttempt += 1;
  if (state.writeAttempt === 1) {
    state.phases.push('write-conflict');
    throw new RuntimeStateWriteConflictError();
  }
  state.phases.push('write-accepted');
  return {
    commandId: 'retry-client-alice',
    requestId: 'retry-client-alice',
    commandHash: `sha256:${'a'.repeat(64)}`,
    aggregateRef: { ...SCOPE, principalId: 'alice' },
    outcome: 'no-op' as const,
    attemptCount: 2,
    acceptedStorageRevision: 0,
    stateRevision: 1,
    snapshotVersion: 1,
    presenceVersion: 1,
    eventId: null,
    outboxIds: [],
  };
}
