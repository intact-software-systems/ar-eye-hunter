import { describe, expect, it, vi } from 'vitest';

import type { AuthSession } from '@shared/api/api-config.ts';
import {
  ADMIN_PRUNE_EXPIRED_CATEGORIES,
  type AdminPruneExpiredCategory,
} from '@shared/api/admin-operations-types.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import {
  decodeAdminPruneCommand,
  type AdminPruneCommand,
} from '@shared-server/rallar-system/admin-operations/admin-prune-work-codec.ts';
import { AppInboxIdempotencyConflictError } from '@shared-server/rallar-system/services/AppInboxService.ts';
// The canonical production owner is intentionally absent until Task 3.
import { AppAdminInboxService } from '@shared-server/rallar-system/admin-operations/inbox/app-admin-inbox-service.ts';
import { createAppInboxTestDatabase } from '../../app-inbox-test-database.ts';
import {
  createResilience,
  TestResourceInbox,
  TestResourceInboxResults,
  waitForQueueEntry,
} from '../../group-state/inbox/group-state-inbox-test-runtime.ts';

const INITIAL_TIME_EPOCH_MS = 1_800_000_000_000;
const RETRY_EXPIRY_OFFSET_MS = 900_000;

describe('AppAdminInboxService initial prune command', () => {
  it('normalizes defaults and captures volatile command facts once before enqueue', async () => {
    const harness = createAdminInboxHarness();
    const pending = harness.service.pruneExpired({
      adminSession: createAdminSession('admin', 'admin-session'),
      request: {},
    });

    await waitForQueueEntry(harness.queue);
    const command = await readOnlyCommand(harness.queue);

    expect(command).toMatchObject({
      jobId: expect.any(String),
      requestedBy: 'admin',
      requestedSessionId: 'admin-session',
      capturedAtEpochMs: INITIAL_TIME_EPOCH_MS,
      expireAtEpochMs: INITIAL_TIME_EPOCH_MS + RETRY_EXPIRY_OFFSET_MS,
      dryRun: true,
      categories: ADMIN_PRUNE_EXPIRED_CATEGORIES.filter((category) => category !== 'app-data'),
      appData: null,
      pageSize: 25,
    });
    expect(command.jobId.length).toBeGreaterThan(0);
    expect(harness.nowEpochMs).toHaveBeenCalledOnce();
    expect(harness.computeRetryExpiryAtEpochMs).toHaveBeenCalledExactlyOnceWith(
      INITIAL_TIME_EPOCH_MS,
    );
    expect(harness.readAuthority).not.toHaveBeenCalled();
    expect(harness.pruner.countExpired).not.toHaveBeenCalled();
    expect(harness.wakeQueueEngine).toHaveBeenCalledOnce();

    await dequeueInitialCommand(harness);
    await expect(pending).resolves.toMatchObject({ right: { status: 'dry-run' } });
  });

  it('rejects app-data pruning without a namespace before any volatile or mutation work', async () => {
    const harness = createAdminInboxHarness();

    await expect(
      harness.service.pruneExpired({
        adminSession: createAdminSession('admin', 'admin-session'),
        request: { categories: ['app-data'] },
      }),
    ).rejects.toThrow('appData.namespace is required');

    expect(harness.nowEpochMs).not.toHaveBeenCalled();
    expect(harness.computeRetryExpiryAtEpochMs).not.toHaveBeenCalled();
    expect(harness.readAuthority).not.toHaveBeenCalled();
    expect(harness.pruner.countExpired).not.toHaveBeenCalled();
    expect(harness.transactionCount()).toBe(0);
    expect(harness.wakeQueueEngine).not.toHaveBeenCalled();
  });

  it('reuses a matching same-client same-session request without recapturing volatile facts', async () => {
    const harness = createAdminInboxHarness();
    const request = {
      requestId: 'matching-replay',
      categories: ['runtime-state'] as const,
      dryRun: true,
    };

    const first = await completePrune(
      harness,
      createAdminSession('admin', 'admin-session'),
      request,
    );
    const firstCommand = await readOnlyCommand(harness.queue, 'matching-replay', 'admin');
    harness.advanceTime(60_000);
    const beforeReplay = harness.readWorkCounts();

    await expect(
      harness.service.pruneExpired({
        adminSession: createAdminSession('admin', 'admin-session'),
        request,
      }),
    ).resolves.toEqual(first);

    expect(await readOnlyCommand(harness.queue, 'matching-replay', 'admin')).toEqual(firstCommand);
    expect(harness.readWorkCounts()).toEqual(beforeReplay);
  });

  it.each([
    {
      name: 'authenticated session',
      session: createAdminSession('admin', 'other-session'),
      request: { requestId: 'same-client-conflict', categories: ['runtime-state'], dryRun: true },
    },
    {
      name: 'categories',
      session: createAdminSession('admin', 'admin-session'),
      request: { requestId: 'same-client-conflict', categories: ['resource-inbox'], dryRun: true },
    },
    {
      name: 'app-data scope',
      session: createAdminSession('admin', 'admin-session'),
      request: {
        requestId: 'same-client-conflict',
        categories: ['app-data'],
        appData: { namespace: 'other-namespace' },
        dryRun: true,
      },
    },
    {
      name: 'dry-run semantics',
      session: createAdminSession('admin', 'admin-session'),
      request: { requestId: 'same-client-conflict', categories: ['runtime-state'], dryRun: false },
    },
  ])(
    'rejects changed $name under an existing same-client request ID without new work',
    async ({ session, request }) => {
      const harness = createAdminInboxHarness();
      await completePrune(harness, createAdminSession('admin', 'admin-session'), {
        requestId: 'same-client-conflict',
        categories: ['runtime-state'],
        dryRun: true,
      });
      const beforeConflict = harness.readWorkCounts();

      await expect(
        harness.service.pruneExpired({ adminSession: session, request }),
      ).rejects.toBeInstanceOf(AppInboxIdempotencyConflictError);

      expect(harness.readWorkCounts()).toEqual(beforeConflict);
    },
  );

  it('uses a distinct AppInbox key for another authenticated client with the same request ID', async () => {
    const harness = createAdminInboxHarness();
    const request = {
      requestId: 'client-scoped-request-id',
      categories: ['runtime-state'] as const,
      dryRun: true,
    };

    await completePrune(harness, createAdminSession('admin-a', 'admin-a-session'), request);
    await completePrune(harness, createAdminSession('admin-b', 'admin-b-session'), request);

    expect(await listCommands(harness.queue, 'client-scoped-request-id')).toMatchObject([
      { requestedBy: 'admin-a', requestedSessionId: 'admin-a-session' },
      { requestedBy: 'admin-b', requestedSessionId: 'admin-b-session' },
    ]);
    expect(harness.pruner.countExpired).toHaveBeenCalledTimes(2);
  });

  it('runs a dry-run through current reads, one transaction, result commit, and no post-commit wake', async () => {
    const harness = createAdminInboxHarness();

    await completePrune(harness, createAdminSession('admin', 'admin-session'), {
      requestId: 'dry-run-phase-order',
      categories: ['runtime-state'],
      dryRun: true,
    });

    expect(harness.events).toEqual([
      'queue-wake',
      'count:runtime-state',
      'current-authority',
      'transaction',
      'result-write',
      'commit-return',
    ]);
    expect(harness.database.outboxEntries.size).toBe(0);
  });

  it('commits initial aggregate and page work before waking the queue for a durable prune', async () => {
    const harness = createAdminInboxHarness();

    await completePrune(harness, createAdminSession('admin', 'admin-session'), {
      requestId: 'durable-phase-order',
      categories: ['runtime-state', 'resource-inbox-results'],
      dryRun: false,
    });

    expect(harness.events).toEqual([
      'queue-wake',
      'count:runtime-state',
      'count:resource-inbox-results',
      'current-authority',
      'transaction',
      'result-write',
      'commit-return',
      'queue-wake',
    ]);
    expect(harness.database.outboxEntries.size).toBe(2);
  });

  it('rolls back initial durable work on an outbox collision without loading a winner or waking', async () => {
    const harness = createAdminInboxHarness({ failOutboxWrite: true });

    const result = await completePrune(harness, createAdminSession('admin', 'admin-session'), {
      requestId: 'initial-outbox-collision',
      categories: ['runtime-state'],
      dryRun: false,
    });

    expect(result.left).toMatchObject({ code: 'resource-inbox-invariant-corruption' });
    expect(harness.database.outboxEntries.size).toBe(0);
    expect(harness.wakeQueueEngine).toHaveBeenCalledOnce();
  });

  it('restarts the complete read and write sequence after an optimistic transaction conflict', async () => {
    const harness = createAdminInboxHarness({ conflictFirstTransaction: true });

    await completePrune(
      harness,
      createAdminSession('admin', 'admin-session'),
      {
        requestId: 'retry-full-phase-sequence',
        categories: ['runtime-state'],
        dryRun: true,
      },
      2,
    );

    expect(harness.readAuthority).toHaveBeenCalledTimes(2);
    expect(harness.pruner.countExpired).toHaveBeenCalledTimes(2);
    expect(harness.transactionCount()).toBe(2);
    expect(harness.events).toEqual([
      'queue-wake',
      'count:runtime-state',
      'current-authority',
      'transaction',
      'count:runtime-state',
      'current-authority',
      'transaction',
      'result-write',
      'commit-return',
    ]);
  });

  it.each([
    {
      name: 'current authority denial',
      options: { allowCurrentAuthority: false },
      request: { requestId: 'denied-prune', categories: ['runtime-state'], dryRun: true },
      expectedCode: 'admin-prune-authority-denied',
    },
    {
      name: 'expired command',
      options: { retryExpiryOffsetMs: 1 },
      request: { requestId: 'expired-prune', categories: ['runtime-state'], dryRun: true },
      expectedCode: 'admin-prune-authority-denied',
    },
  ])(
    'classifies $name without durable mutation work',
    async ({ options, request, expectedCode }) => {
      const harness = createAdminInboxHarness(options);

      const pending = harness.service.pruneExpired({
        adminSession: createAdminSession('admin', 'admin-session'),
        request,
      });
      await waitForQueueEntry(harness.queue);
      if (options.retryExpiryOffsetMs !== undefined) harness.advanceTime(2);
      await dequeueInitialCommand(harness);
      const result = await pending;

      expect(result.left).toMatchObject({ code: expectedCode });
      expect(harness.database.outboxEntries.size).toBe(0);
      expect(harness.wakeQueueEngine).toHaveBeenCalledOnce();
    },
  );

  it('returns the existing unavailable failure when the initial result wait exhausts', async () => {
    const harness = createAdminInboxHarness({ waitForResult: false });

    await expect(
      harness.service.pruneExpired({
        adminSession: createAdminSession('admin', 'admin-session'),
        request: { requestId: 'wait-exhaustion', categories: ['runtime-state'], dryRun: true },
      }),
    ).resolves.toMatchObject({ left: { code: 'app-inbox-unavailable' } });

    expect(harness.readAuthority).not.toHaveBeenCalled();
    expect(harness.pruner.countExpired).not.toHaveBeenCalled();
    expect(harness.transactionCount()).toBe(0);
  });
});

interface CreateAdminInboxHarnessOptions {
  readonly allowCurrentAuthority?: boolean;
  readonly conflictFirstTransaction?: boolean;
  readonly failOutboxWrite?: boolean;
  readonly retryExpiryOffsetMs?: number;
  readonly waitForResult?: boolean;
}

interface AdminInboxHarness {
  readonly service: AppAdminInboxService;
  readonly queue: TestResourceInbox;
  readonly reader: InboxQueueReader;
  readonly database: ReturnType<typeof createAppInboxTestDatabase>;
  readonly events: string[];
  readonly nowEpochMs: ReturnType<typeof vi.fn>;
  readonly computeRetryExpiryAtEpochMs: ReturnType<typeof vi.fn>;
  readonly readAuthority: ReturnType<typeof vi.fn>;
  readonly pruner: Readonly<{ countExpired: ReturnType<typeof vi.fn> }>;
  readonly wakeQueueEngine: ReturnType<typeof vi.fn>;
  advanceTime(milliseconds: number): void;
  readWorkCounts(): Readonly<{
    now: number;
    expiry: number;
    authority: number;
    count: number;
    transaction: number;
    wake: number;
  }>;
  transactionCount(): number;
}

function createAdminInboxHarness(options: CreateAdminInboxHarnessOptions = {}): AdminInboxHarness {
  const events: string[] = [];
  const queue = new TestResourceInbox();
  const reader = new InboxQueueReader(queue);
  const results = new TestResourceInboxResults();
  let currentTimeEpochMs = INITIAL_TIME_EPOCH_MS;
  let transactions = 0;
  const nowEpochMs = vi.fn(() => currentTimeEpochMs);
  const computeRetryExpiryAtEpochMs = vi.fn(
    (capturedAtEpochMs: number) =>
      capturedAtEpochMs + (options.retryExpiryOffsetMs ?? RETRY_EXPIRY_OFFSET_MS),
  );
  const readAuthority = vi.fn(async () => {
    events.push('current-authority');
    return {
      allowed: options.allowCurrentAuthority ?? true,
      code: options.allowCurrentAuthority === false ? 'admin-prune-authority-denied' : 'allowed',
    };
  });
  const pruner = {
    countExpired: vi.fn(async (category: AdminPruneExpiredCategory) => {
      events.push(`count:${category}`);
      return category.length;
    }),
  };
  const wakeQueueEngine = vi.fn(() => events.push('queue-wake'));
  const resultRepository = {
    replace: async (entry: ResourceEntry) => {
      events.push('result-write');
      return await results.replace(entry);
    },
    findByKey: async (...arguments_: Parameters<TestResourceInboxResults['findByKey']>) =>
      await results.findByKey(...arguments_),
  };
  const database = createAppInboxTestDatabase(queue, resultRepository, {
    shouldFailOutboxWrite: options.failOutboxWrite ? () => true : undefined,
    withTransaction: async (write) => {
      transactions += 1;
      events.push('transaction');
      if (options.conflictFirstTransaction && transactions === 1) {
        throw Object.assign(new Error('optimistic write conflict'), {
          code: 'runtime-state-write-conflict',
          status: 503,
        });
      }
      return await write();
    },
    onStage: (stage) => {
      if (stage === 'transaction-commit-return') events.push('commit-return');
    },
  });
  const service = new AppAdminInboxService(
    {
      inboxQueueReader: reader,
      resourceInboxRepository: queue as never,
      resourceInboxResultsRepository: resultRepository as never,
      database,
      pruner,
      readAuthority,
      wakeQueueEngine,
      computeRetryExpiryAtEpochMs,
    },
    {
      serviceId: 'admin-inbox-test-server',
      pageSize: 25,
      timing: undefined,
      appInbox: {
        nowEpochMs,
        waitMaxElapsedMsecs: options.waitForResult === false ? 0 : 1_000,
        waitRetryIntervalMsecs: 0,
        waitMaxRetryIntervalMsecs: 0,
        waitJitterRatio: 0,
      },
    },
  );
  return {
    service,
    queue,
    reader,
    database,
    events,
    nowEpochMs,
    computeRetryExpiryAtEpochMs,
    readAuthority,
    pruner,
    wakeQueueEngine,
    advanceTime: (milliseconds) => {
      currentTimeEpochMs += milliseconds;
    },
    readWorkCounts: () => ({
      now: nowEpochMs.mock.calls.length,
      expiry: computeRetryExpiryAtEpochMs.mock.calls.length,
      authority: readAuthority.mock.calls.length,
      count: pruner.countExpired.mock.calls.length,
      transaction: transactions,
      wake: wakeQueueEngine.mock.calls.length,
    }),
    transactionCount: () => transactions,
  };
}

function createAdminSession(clientId: string, sessionId: string): AuthSession {
  return {
    clientId,
    username: clientId,
    sessionId,
    accessToken: 'test-only-token',
    expiresAtEpochMs: INITIAL_TIME_EPOCH_MS + 3_600_000,
  };
}

async function completePrune(
  harness: AdminInboxHarness,
  adminSession: AuthSession,
  request: unknown,
  dequeueAttempts = 1,
) {
  const pending = harness.service.pruneExpired({ adminSession, request });
  for (let attempt = 0; attempt < dequeueAttempts; attempt += 1) {
    await waitForQueueEntry(harness.queue);
    await dequeueInitialCommand(harness);
  }
  return await pending;
}

async function dequeueInitialCommand(harness: AdminInboxHarness): Promise<void> {
  await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
}

async function readOnlyCommand(
  queue: TestResourceInbox,
  requestId?: string,
  clientId?: string,
): Promise<AdminPruneCommand> {
  const commands = await listCommands(queue, requestId, clientId);
  const command = commands[0];
  if (!command) throw new Error('Expected one admin prune command');
  return command;
}

async function listCommands(
  queue: TestResourceInbox,
  requestId?: string,
  clientId?: string,
): Promise<readonly AdminPruneCommand[]> {
  const entries = await Promise.all((await queue.getAllKeys()).map((key) => queue.getItem(key)));
  return entries
    .filter((entry): entry is ResourceEntry => entry !== undefined)
    .filter((entry) => requestId === undefined || entry.key.resourceId === requestId)
    .filter((entry) => clientId === undefined || entry.key.contextId === clientId)
    .map((entry) => {
      const message = JSON.parse(entry.resource) as { payload: { resource: string } };
      const enqueue = JSON.parse(message.payload.resource) as { data: unknown };
      return decodeAdminPruneCommand(enqueue.data);
    });
}
