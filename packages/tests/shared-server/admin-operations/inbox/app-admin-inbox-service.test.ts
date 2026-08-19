import { describe, expect, it, vi } from 'vitest';

import type { AuthSession } from '@shared/api/api-config.ts';
import {
  ADMIN_PRUNE_EXPIRED_CATEGORIES,
  type AdminPruneExpiredCategory,
} from '@shared/api/admin-operations-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { PSqlSql, PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import {
  type AdminPruneCommand,
  createAdminPruneCommand,
  decodeAdminPruneCommand,
} from '@shared-server/rallar-system/admin-operations/admin-prune-work-codec.ts';
// prettier-ignore
import {
  ADMIN_PRUNE_AGGREGATE_TOPIC,
} from '@shared-server/rallar-system/admin-operations/admin-prune-progress.ts';
import {
  AppInboxIdempotencyConflictError,
  AppInboxType,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
// prettier-ignore
import {
  hashCanonicalCommand,
} from '@shared-server/rallar-system/services/canonical-command-hash.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';
import {
  ADMIN_APP_INBOX_TOPIC,
  AppAdminInboxService,
} from '@shared-server/rallar-system/admin-operations/inbox/app-admin-inbox-service.ts';
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
    expect(harness.events.slice(0, 5)).toEqual([
      'semantic-identity-completed',
      'phase:semantic-identity',
      'phase:durable-command-read',
      'now-callback',
      'retry-expiry-callback',
    ]);
    expect(harness.events.indexOf('semantic-identity-completed')).toBeLessThan(
      harness.events.indexOf('now-callback'),
    );
    expect(harness.events.indexOf('semantic-identity-completed')).toBeLessThan(
      harness.events.indexOf('retry-expiry-callback'),
    );
    expect(harness.createAdminPruneIdempotencyIdentity).toHaveBeenCalledExactlyOnceWith({
      requestId: command.jobId,
      requestedBy: 'admin',
      requestedSessionId: 'admin-session',
      categories: ADMIN_PRUNE_EXPIRED_CATEGORIES.filter((category) => category !== 'app-data'),
      appData: null,
      dryRun: true,
    });
    expect(harness.timingEvents).toContainEqual(
      expect.objectContaining({
        component: 'admin-prune-inbox',
        operation: 'semantic-identity',
        principalId: 'admin',
        sessionId: 'admin-session',
        details: expect.objectContaining({ semanticHash: expect.stringMatching(/^sha256:/u) }),
      }),
    );
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

  it('rejects app-data without a namespace before volatile or mutation work', async () => {
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

  it('reuses a same-client same-session request without recapturing facts', async () => {
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

  it('preserves first-occurrence category order for fresh command and result facts', async () => {
    const harness = createAdminInboxHarness();
    const result = await completePrune(harness, createAdminSession('admin', 'admin-session'), {
      requestId: 'first-occurrence-order',
      categories: ['resource-inbox-results', 'runtime-state', 'resource-inbox-results'],
      dryRun: true,
    });

    const command = await readOnlyCommand(harness.queue, 'first-occurrence-order', 'admin');
    expect(command.categories).toEqual(['resource-inbox-results', 'runtime-state']);
    expect(result.right?.results.map(({ category }) => category)).toEqual([
      'resource-inbox-results',
      'runtime-state',
    ]);
  });

  it('replays predecessor category order for the same reordered set', async () => {
    const harness = createAdminInboxHarness();
    const predecessorCommand = await createAdminPruneCommand({
      jobId: 'predecessor-order-replay',
      requestedBy: 'admin',
      requestedSessionId: 'admin-session',
      capturedAtEpochMs: INITIAL_TIME_EPOCH_MS,
      expireAtEpochMs: INITIAL_TIME_EPOCH_MS + RETRY_EXPIRY_OFFSET_MS,
      dryRun: true,
      categories: ['resource-inbox-results', 'runtime-state'],
      appData: null,
      pageSize: 25,
    });
    await harness.service.enqueue({
      type: AppInboxType.ADMIN_PRUNE_EXPIRED,
      topicId: ADMIN_APP_INBOX_TOPIC,
      resourceId: predecessorCommand.jobId,
      contextId: predecessorCommand.requestedBy,
      senderId: predecessorCommand.requestedSessionId,
      data: predecessorCommand,
    });
    await dequeueInitialCommand(harness);
    const beforeReplay = harness.readWorkCounts();

    const replay = await harness.service.pruneExpired({
      adminSession: createAdminSession('admin', 'admin-session'),
      request: {
        requestId: predecessorCommand.jobId,
        categories: ['runtime-state', 'resource-inbox-results'],
        dryRun: true,
      },
    });

    expect(replay.right?.results.map(({ category }) => category)).toEqual([
      'resource-inbox-results',
      'runtime-state',
    ]);
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
      const conflict = harness.service.pruneExpired({ adminSession: session, request });
      await expect(conflict).rejects.toBeInstanceOf(AppInboxIdempotencyConflictError);
      await expect(conflict).rejects.toMatchObject({
        code: 'app-inbox-idempotency-conflict',
        status: 409,
      });

      expect(harness.readWorkCounts()).toEqual(beforeConflict);
      expect(harness.createAdminPruneIdempotencyIdentity).toHaveBeenCalledTimes(2);
      const identities = await Promise.all(
        harness.createAdminPruneIdempotencyIdentity.mock.results.map(({ value }) => value),
      );
      expect(identities[0]?.semanticHash).not.toBe(identities[1]?.semanticHash);
      const semanticHashes = readSemanticHashes(harness.timingEvents);
      expect(semanticHashes).toHaveLength(2);
      expect(semanticHashes[0]).toMatch(/^sha256:/u);
      expect(semanticHashes[1]).not.toBe(semanticHashes[0]);
    },
  );

  it('uses a distinct key for another client with the same request ID', async () => {
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

  it('runs dry-run reads and one commit without post-commit wake', async () => {
    const harness = createAdminInboxHarness();

    await completePrune(harness, createAdminSession('admin', 'admin-session'), {
      requestId: 'dry-run-phase-order',
      categories: ['runtime-state'],
      dryRun: true,
    });

    expect(harness.events).toEqual([
      'semantic-identity-completed',
      'phase:semantic-identity',
      'phase:durable-command-read',
      'now-callback',
      'retry-expiry-callback',
      'queue-wake',
      'now-callback',
      'count:runtime-state',
      'current-authority',
      'phase:read',
      'phase:compute',
      'phase:validate',
      'transaction',
      'result-write',
      'now-callback',
      'commit-return',
    ]);
    expect(harness.database.outboxEntries.size).toBe(0);
  });

  it('commits aggregate and page work before waking the queue', async () => {
    const harness = createAdminInboxHarness();

    await completePrune(harness, createAdminSession('admin', 'admin-session'), {
      requestId: 'durable-phase-order',
      categories: ['runtime-state', 'resource-inbox-results'],
      dryRun: false,
    });

    expect(harness.events).toEqual([
      'semantic-identity-completed',
      'phase:semantic-identity',
      'phase:durable-command-read',
      'now-callback',
      'retry-expiry-callback',
      'queue-wake',
      'now-callback',
      'count:runtime-state',
      'count:resource-inbox-results',
      'current-authority',
      'phase:read',
      'phase:compute',
      'phase:validate',
      'transaction',
      'page-write',
      'page-write',
      'aggregate-write',
      'result-write',
      'now-callback',
      'commit-return',
      'queue-wake',
    ]);
    expect(harness.database.outboxEntries.size).toBe(2);
  });

  it('rolls back an outbox collision without loading a winner or waking', async () => {
    const harness = createAdminInboxHarness({ failOutboxWrite: true, waitForResult: false });

    await expect(
      harness.service.pruneExpired({
        adminSession: createAdminSession('admin', 'admin-session'),
        request: {
          requestId: 'initial-outbox-collision',
          categories: ['runtime-state'],
          dryRun: false,
        },
      }),
    ).resolves.toMatchObject({ left: { code: 'app-inbox-unavailable' } });
    await waitForQueueEntry(harness.queue);
    await dequeueInitialCommand(harness);

    expect(harness.database.outboxEntries.size).toBe(0);
    expect(harness.outboxWinnerLookups()).toBe(0);
    expect(harness.durableResultQueryLookups()).toBe(0);
    expect(harness.durableResultPortLookups()).toBe(0);
    expect(harness.wakeQueueEngine).toHaveBeenCalledOnce();
  });

  it('restarts read and write after an optimistic transaction conflict', async () => {
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
      'semantic-identity-completed',
      'phase:semantic-identity',
      'phase:durable-command-read',
      'now-callback',
      'retry-expiry-callback',
      'queue-wake',
      'now-callback',
      'count:runtime-state',
      'current-authority',
      'phase:read',
      'phase:compute',
      'phase:validate',
      'transaction',
      'now-callback',
      'count:runtime-state',
      'current-authority',
      'phase:read',
      'phase:compute',
      'phase:validate',
      'transaction',
      'result-write',
      'now-callback',
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
  readonly timingEvents: RallarTimingEvent[];
  readonly nowEpochMs: ReturnType<typeof vi.fn>;
  readonly computeRetryExpiryAtEpochMs: ReturnType<typeof vi.fn>;
  readonly createAdminPruneIdempotencyIdentity: ReturnType<typeof vi.fn>;
  readonly readAuthority: ReturnType<typeof vi.fn>;
  readonly pruner: Readonly<{ countExpired: ReturnType<typeof vi.fn> }>;
  readonly wakeQueueEngine: ReturnType<typeof vi.fn>;
  advanceTime(milliseconds: number): void;
  durableResultPortLookups(): number;
  durableResultQueryLookups(): number;
  outboxWinnerLookups(): number;
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
  const timingEvents: RallarTimingEvent[] = [];
  const queue = new TestResourceInbox();
  const reader = new InboxQueueReader(queue);
  const results = new TestResourceInboxResults();
  let currentTimeEpochMs = INITIAL_TIME_EPOCH_MS;
  let transactions = 0;
  let collisionWinnerLookups = 0;
  let resultPortLookups = 0;
  let resultQueryLookups = 0;
  const nowEpochMs = vi.fn(() => {
    events.push('now-callback');
    return currentTimeEpochMs;
  });
  const computeRetryExpiryAtEpochMs = vi.fn((capturedAtEpochMs: number) => {
    events.push('retry-expiry-callback');
    return capturedAtEpochMs + (options.retryExpiryOffsetMs ?? RETRY_EXPIRY_OFFSET_MS);
  });
  const createAdminPruneIdempotencyIdentity = vi.fn(
    async (input: AdminPruneIdempotencyIdentityInput): Promise<AdminPruneIdempotencyIdentity> => {
      const semanticHash = await hashCanonicalCommand(input);
      events.push('semantic-identity-completed');
      return {
        version: 1,
        ...input,
        semanticHash,
      };
    },
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
      return await results.replace(entry);
    },
    findByKey: async (...arguments_: Parameters<TestResourceInboxResults['findByKey']>) => {
      resultPortLookups += 1;
      return await results.findByKey(...arguments_);
    },
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
  const observedDatabase = createObservedDatabase(database, events, {
    recordOutboxWinnerLookup: () => {
      collisionWinnerLookups += 1;
    },
    recordDurableResultLookup: () => {
      resultQueryLookups += 1;
    },
  });
  const service = new AppAdminInboxService(
    {
      inboxQueueReader: reader,
      resourceInboxRepository: queue as never,
      resourceInboxResultsRepository: resultRepository as never,
      database: observedDatabase,
      pruner,
      readAuthority,
      wakeQueueEngine,
      computeRetryExpiryAtEpochMs,
      createAdminPruneIdempotencyIdentity,
    },
    {
      serviceId: 'admin-inbox-test-server',
      pageSize: 25,
      timing: (event) => recordAdminPrunePhase(events, timingEvents, event),
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
    timingEvents,
    nowEpochMs,
    computeRetryExpiryAtEpochMs,
    createAdminPruneIdempotencyIdentity,
    readAuthority,
    pruner,
    wakeQueueEngine,
    advanceTime: (milliseconds) => {
      currentTimeEpochMs += milliseconds;
    },
    durableResultPortLookups: () => resultPortLookups,
    durableResultQueryLookups: () => resultQueryLookups,
    outboxWinnerLookups: () => collisionWinnerLookups,
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

interface AdminPruneIdempotencyIdentityInput {
  readonly requestId: string;
  readonly requestedBy: string;
  readonly requestedSessionId: string;
  readonly categories: readonly AdminPruneExpiredCategory[];
  readonly appData: Readonly<{ namespace: string; storeName: string | null }> | null;
  readonly dryRun: boolean;
}

interface AdminPruneIdempotencyIdentity extends AdminPruneIdempotencyIdentityInput {
  readonly version: 1;
  readonly semanticHash: string;
}

function createObservedDatabase(
  database: ReturnType<typeof createAppInboxTestDatabase>,
  events: string[],
  lookupRecorder: Readonly<{
    recordOutboxWinnerLookup(): void;
    recordDurableResultLookup(): void;
  }>,
): PSqlSql {
  const observed = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    database(strings, ...values)) as PSqlSql;
  Object.defineProperties(observed, Object.getOwnPropertyDescriptors(database));
  observed.begin = async <T>(write: (transaction: PSqlTransactionSql) => Promise<T>): Promise<T> =>
    await database.begin(
      async (transaction) =>
        await write(createObservedTransaction(transaction, events, lookupRecorder)),
    );
  return observed;
}

function createObservedTransaction(
  transaction: PSqlTransactionSql,
  events: string[],
  lookupRecorder: Readonly<{
    recordOutboxWinnerLookup(): void;
    recordDurableResultLookup(): void;
  }>,
): PSqlTransactionSql {
  const observed = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(' ').replace(/\s+/gu, ' ').trim().toLowerCase();
    if (query.includes('from resource_inbox') && query.includes('limit 1')) {
      lookupRecorder.recordOutboxWinnerLookup();
    }
    if (query.includes('from resource_inbox_results') && query.includes('limit 1')) {
      lookupRecorder.recordDurableResultLookup();
    }
    if (query.includes('insert into resource_inbox_results')) {
      events.push(values[1] === ADMIN_PRUNE_AGGREGATE_TOPIC ? 'aggregate-write' : 'result-write');
    } else if (query.includes('insert into resource_inbox')) {
      events.push('page-write');
    }
    return await transaction(strings, ...values);
  }) as typeof transaction;
  observed.begin = transaction.begin;
  return observed;
}

function recordAdminPrunePhase(
  events: string[],
  timingEvents: RallarTimingEvent[],
  event: RallarTimingEvent,
): void {
  if (event.component !== 'admin-prune-inbox') return;
  timingEvents.push(event);
  events.push(`phase:${event.operation}`);
}

function readSemanticHashes(timingEvents: readonly RallarTimingEvent[]): readonly string[] {
  return timingEvents
    .filter((event) => event.operation === 'semantic-identity')
    .map((event) => event.details?.semanticHash)
    .filter((semanticHash): semanticHash is string => typeof semanticHash === 'string');
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
    if (attempt === 0) {
      await waitForQueueEntry(harness.queue);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
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
