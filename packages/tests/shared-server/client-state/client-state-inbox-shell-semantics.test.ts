import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';

import { EnqueuedType } from '@shared/api/api-config.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { EntityStatus, type ResourceEntry, toKeyAsString } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import type { AppInboxMessageContext } from '@shared-server/rallar-system/services/AppInboxService.ts';
import {
  AppInboxService,
  AppInboxType,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import { AppInboxTransactionWriter } from '@shared-server/rallar-system/services/app-inbox-transaction-writer.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import { ClientStateInboxHandler } from '@shared-server/rallar-system/client-state/inbox/client-state-inbox-handler.ts';
import { createTimedClientStateService } from '@shared-server/rallar-system/client-state/client-state-service-timing.ts';
import { toClientMutationIssuedSessionAuthority } from '@shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts';
import { toUpsertPrincipalCommandInput } from '@shared-server/rallar-system/client-state/mutation/client-mutation-command.ts';

import type {
  ClientMutationComputed,
  ClientMutationCommand,
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts';
import type { ClientStateService } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { createAppInboxTestDatabase } from '../app-inbox-test-database.ts';

const SCOPE = { applicationId: 'ar-eye-hunter', workspaceId: 'default' } as const;
const EXPECTED_DURABLE_JSON =
  '{"status":"ok","result":{"right":{"snapshot":{"snapshotVersion":4,"stateRevision":3},"event":{"eventId":"event-4"}}}}';

describe('client-state AppInbox shell semantics', () => {
  it('registers the established eight client mutation families in order', () => {
    const registration = vi
      .spyOn(AppInboxService.prototype, 'onStateMessage')
      .mockImplementation(() => undefined);
    try {
      createClientInboxServiceForRegistration();

      expect(registration.mock.calls.map(([type]) => type)).toEqual([
        AppInboxType.CLIENT_PRINCIPAL_UPSERT,
        AppInboxType.CLIENT_INSTANCE_UPSERT,
        AppInboxType.CLIENT_SESSION_CONNECT,
        AppInboxType.CLIENT_SESSION_HEARTBEAT,
        AppInboxType.CLIENT_SESSION_DISCONNECT,
        AppInboxType.CLIENT_AUTHORISED_WS_CONNECT,
        AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT,
        AppInboxType.CLIENT_EXPIRED_SESSIONS,
      ]);
    } finally {
      registration.mockRestore();
    }
  });

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

  it('preserves timed phase identities, results, rejections, and argument identities', async () => {
    const calls: string[] = [];
    const events: RallarTimingEvent[] = [];
    const readResult = { read: 'exact-read-result' };
    const computedResult = { computed: 'exact-computed-result' };
    const writeFailure = new Error('write failure must propagate');
    const service = createClientStateServiceStub({
      read: async (command) => {
        calls.push('read');
        expect(command).toBe(TIMED_COMMAND);
        return readResult as never;
      },
      compute: (command, read) => {
        calls.push('compute');
        expect(command).toBe(TIMED_COMMAND);
        expect(read).toBe(readResult);
        return computedResult as never;
      },
      validate: (command, read, computed) => {
        calls.push('validate');
        expect(command).toBe(TIMED_COMMAND);
        expect(read).toBe(readResult);
        expect(computed).toBe(computedResult);
      },
      write: async (transaction, computed) => {
        calls.push('write');
        expect(transaction).toBe(TIMED_TRANSACTION);
        expect(computed).toBe(TIMED_COMPUTED);
        throw writeFailure;
      },
    });
    const timed = createTimedClientStateService({
      service,
      serviceId: 'client-timing-service',
      timing: (event) => {
        events.push(event);
        calls.push(`event:${event.operation}:${event.status}`);
      },
    });

    await expect(timed.read(TIMED_COMMAND)).resolves.toBe(readResult);
    expect(timed.compute(TIMED_COMMAND, readResult as never)).toBe(computedResult);
    expect(() =>
      timed.validate(TIMED_COMMAND, readResult as never, computedResult as never),
    ).not.toThrow();
    await expect(timed.write(TIMED_TRANSACTION, TIMED_COMPUTED)).rejects.toBe(writeFailure);

    expect(calls).toEqual([
      'read',
      'event:mutation.read:ok',
      'compute',
      'event:mutation.compute:ok',
      'validate',
      'event:mutation.validate:ok',
      'write',
      'event:mutation.write:error',
    ]);
    expect(events.map((event) => [event.operation, event.serviceId, event.status])).toEqual([
      ['mutation.read', 'client-timing-service', 'ok'],
      ['mutation.compute', 'client-timing-service', 'ok'],
      ['mutation.validate', 'client-timing-service', 'ok'],
      ['mutation.write', 'client-timing-service', 'error'],
    ]);
    expect(events.at(-1)?.error?.message).toBe(writeFailure.message);
  });
});

const TIMED_COMMAND = {
  operation: 'upsertPrincipal',
  aggregateRef: { ...SCOPE, principalId: 'alice' },
  commandId: 'timed-command',
  requestId: 'timed-request',
  authority: {
    kind: 'issued-session',
    version: 1,
    principalId: 'alice',
    sessionId: 'alice-session',
    sessionIssuedAtEpochMs: 1,
    sessionExpiresAtEpochMs: 2,
    applicationId: SCOPE.applicationId,
    workspaceId: SCOPE.workspaceId,
    operation: 'upsertPrincipal',
  },
  facts: {
    nowEpochMs: 1,
    serviceId: 'client-timing-service',
    eventId: 'event-timed',
    commandHash: `sha256:${'a'.repeat(64)}`,
    attemptCount: 1,
    expireAtEpochMs: 2,
  },
  input: {},
} as never as ClientMutationCommand;
const TIMED_COMPUTED = {
  receipt: {
    aggregateRef: TIMED_COMMAND.aggregateRef,
    requestId: TIMED_COMMAND.requestId,
  },
} as never as Parameters<ClientStateService['write']>[1];
const TIMED_TRANSACTION = {} as PSqlTransactionSql;

interface HandlerHarness {
  readonly actions: string[];
  readonly committedSnapshot: object;
  readonly context: AppInboxMessageContext;
  readonly handler: ClientStateInboxHandler;
  readonly observedSnapshots: object[];
  readonly results: TestResourceInboxResults;
}

async function createHandlerHarness(
  options: Readonly<{ failTransaction?: boolean }> = {},
): Promise<HandlerHarness> {
  const actions: string[] = [];
  const observedSnapshots: object[] = [];
  const committedSnapshot = { snapshotVersion: 4, stateRevision: 3 };
  const queue = new InMemoryQueueBox();
  const results = new TestResourceInboxResults();
  const context = createReservedClientContext();
  await queue.enqueue(context.entry);
  const database = createAppInboxTestDatabase(queue, results, {
    withTransaction: async (write) => {
      if (options.failTransaction) throw new Error('injected transaction failure');
      const result = await write();
      actions.push('commit');
      return result;
    },
  });
  const handler = new ClientStateInboxHandler({
    mutationService: {
      read: async () => ({}) as never,
      compute: () =>
        ({
          outcome: 'write',
          snapshot: committedSnapshot,
          event: { eventId: 'event-4' },
        }) as never as ClientMutationComputed,
      validate: () => undefined,
      write: async () => {
        actions.push('write');
        return {} as never;
      },
    },
    sessionGenerationLifecycle: {} as never,
    expiryCandidates: { listExpiredSessionCandidates: async () => [] },
    snapshotObserver: {
      observeSnapshot: async (snapshot) => {
        actions.push('observe');
        observedSnapshots.push(snapshot);
        return snapshot;
      },
    },
    transactionWriter: new AppInboxTransactionWriter({
      database,
      serviceId: 'client-inbox-service',
      nowEpochMs: () => 1_700_000_000_000,
      toTimingDetails: () => ({}),
    }),
    serviceId: 'client-inbox-service',
  });
  return { actions, committedSnapshot, context, handler, observedSnapshots, results };
}

function createClientInboxServiceForRegistration(): AppClientInboxService {
  return new AppClientInboxService(
    {} as InboxQueueReader,
    {} as never,
    {} as never,
    {} as never,
    createClientStateServiceStub(),
    'client-registration-service',
  );
}

function createClientStateServiceStub(
  overrides: Partial<ClientStateService> = {},
): ClientStateService {
  return {
    sessionGenerationLifecycle: {} as never,
    listSnapshots: async () => [],
    readSnapshot: async () => undefined,
    readPresenceSnapshot: async () => undefined,
    listEvents: async () => [],
    listEventPage: async () => ({ events: [], hasMore: false }),
    read: async () => ({}) as never,
    compute: () => ({}) as never,
    validate: () => undefined,
    write: async () => ({}) as never,
    listExpiredSessionCandidates: async () => [],
    findSessionBySessionId: async () => undefined,
    readIssuedAuthSession: async () => undefined,
    observeSnapshot: async (snapshot) => snapshot,
    ...overrides,
  };
}

function createReservedClientContext(): AppInboxMessageContext {
  const enqueue = {
    type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
    topicId: 'app-inbox.client-state',
    resourceId: 'client-transaction-result',
    contextId: 'ar-eye-hunter/default/alice',
    senderId: 'alice',
    data: {},
    authority: toClientMutationIssuedSessionAuthority(
      {
        clientId: 'alice',
        username: 'alice',
        sessionId: 'alice-session',
        accessTokenDigest: 'sha256:alice-session',
        issuedAtEpochMs: 1_699_999_000_000,
        expiresAtEpochMs: 1_700_001_000_000,
      },
      SCOPE,
      'upsertPrincipal',
    ),
  };
  const entry: ResourceEntry = {
    key: {
      topicId: enqueue.topicId,
      resourceId: enqueue.resourceId,
      contextId: enqueue.contextId,
    },
    resource: JSON.stringify(enqueue),
    typeId: EnqueuedType.APP_INBOX,
    audit: {
      date: Temporal.PlainTime.from('12:00:00'),
      createdBy: 'client-inbox-service',
      createdTs: Temporal.PlainDateTime.from('2026-08-05T12:00:00'),
      expiryTs: Temporal.Instant.from('2026-08-06T00:00:00Z'),
    },
    status: EntityStatus.RESERVED,
    dequeueAudit: { attempts: 1 },
  };
  return { enqueue, message: { id: { ts: 1_700_000_000_000 } } as never, entry };
}

class TestResourceInboxResults {
  private readonly entries = new Map<string, ResourceEntry>();

  async replace(entry: ResourceEntry): Promise<ResourceEntry> {
    this.entries.set(toKeyAsString(entry.key), entry);
    return entry;
  }

  async findByKey(key: ResourceEntry['key']): Promise<ResourceEntry | undefined> {
    return this.entries.get(toKeyAsString(key));
  }
}
