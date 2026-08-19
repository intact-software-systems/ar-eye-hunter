import { Temporal } from '@js-temporal/polyfill';
import {
  ClientStateEventCollisionError,
  GroupStateEventCollisionError,
} from '@shared-server/postgres/rallar-system/PSqlStateEventRepository.ts';
import { toResultsDomain } from '@shared-server/postgres/resource-inbox/repository-utils.ts';
import {
  type AppInboxEnqueueInput,
  AppInboxService,
  AppInboxType,
  type GroupMemberUpsertAppInboxPayload,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import {
  SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
  SIMPLER_GROUP_STATE_APP_INBOX_TOPIC,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import { ClientMutationIdempotencyConflictError } from '@shared-server/rallar-system/services/client-state-service.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/services/mutation-command-identity.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';
import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import {
  EntityStatus,
  isExpiredResourceEntry,
  type Key,
  type ResourceEntry,
  toKeyAsString,
} from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { OnMessageCallback } from '@shared/services/InboxOutboxContracts.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import { describe, expect, it, vi } from 'vitest';
import { createAppInboxTestDatabase } from './app-inbox-test-database.ts';

const SCOPE: StateScope = {
  applicationId: 'ar-eye-hunter',
  workspaceId: 'default',
};

describe('AppInboxType', () => {
  it('does not expose server-produced RTC topology work', () => {
    expect(AppInboxType).not.toHaveProperty('RTC_TOPOLOGY_RECOMPUTE');
  });
});

describe('AppInboxService', () => {
  it('decodes a completed persisted result exactly once at the AppInbox boundary', async () => {
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new TestResourceInboxResults();
    const service = new AppInboxService(
      {
        inboxQueueReader: reader,
        resourceInboxRepository: queue as never,
        resourceInboxResultsRepository: results as never,
        database: createAppInboxTestDatabase(queue, results),
      },
      {
        serviceId: 'server-12345678',
        defaultTopicId: SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
        options: {
          waitMaxElapsedMsecs: 5_000,
          waitRetryIntervalMsecs: 1,
          waitMaxRetryIntervalMsecs: 1,
          waitJitterRatio: 0,
        },
      },
    );
    service.onStateMessage(AppInboxType.CLIENT_PRINCIPAL_UPSERT, async () => ({
      status: 'stored',
    }));
    const decodeResult = vi.fn((value: JsonWireValue) => {
      if (
        typeof value !== 'object' ||
        value === null ||
        !('status' in value) ||
        value.status !== 'stored'
      ) {
        throw new TypeError('Unexpected stored result');
      }
      return { accepted: true } as const;
    });
    const pending = service.processEntryUntilCompletionResult(
      {
        type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
        topicId: SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
        resourceId: 'decoded-result',
        contextId: 'client-1',
        data: { requestId: 'decoded-result' },
      },
      decodeResult,
    );

    await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

    await expect(pending).resolves.toEqual(Either.ofRight({ accepted: true }));
    expect(decodeResult).toHaveBeenCalledOnce();
  });

  it('uses one dedicated telemetry-clock sample for retry fallback ages', async () => {
    const queue = new TestResourceInbox();
    const reader = new CapturingInboxQueueReader(queue);
    const results = new TestResourceInboxResults();
    const businessNowEpochMs = vi.fn(() => 9_000);
    const timingNowEpochMs = vi.fn(() => 2_000);
    const timing: RallarTimingEvent[] = [];
    const service = new AppInboxService(
      {
        inboxQueueReader: reader,
        resourceInboxRepository: queue as never,
        resourceInboxResultsRepository: results as never,
        database: createAppInboxTestDatabase(queue, results),
      },
      {
        serviceId: 'server-12345678',
        defaultTopicId: SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
        timing: (event) => timing.push(event),
        options: { nowEpochMs: businessNowEpochMs, timingNowEpochMs },
      },
    );
    service.onStateMessage(
      AppInboxType.CLIENT_PRINCIPAL_UPSERT,
      async () => await Promise.reject(new Error('retryable test failure')),
    );
    const enqueue = {
      type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
      topicId: SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
      resourceId: 'retry-telemetry-clock',
      contextId: 'client-1',
      data: { requestId: 'retry-telemetry-clock' },
    } as const;
    const message = newALUntargetedMessage(
      'server-12345678',
      newALRoute(enqueue.topicId, enqueue.contextId, enqueue.resourceId),
      enqueue.type,
      enqueue,
    );
    const queued = QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.APP_INBOX);
    const entry = {
      ...queued,
      audit: {
        ...queued.audit,
        createdTs: Temporal.Instant.fromEpochMilliseconds(1_000)
          .toZonedDateTimeISO('UTC')
          .toPlainDateTime(),
      },
      dequeueAudit: {
        attempts: 1,
        startTs: Temporal.Instant.fromEpochMilliseconds(1_500),
      },
    };

    await expect(reader.invoke(message, entry)).rejects.toThrow('retryable test failure');

    expect(businessNowEpochMs).not.toHaveBeenCalled();
    expect(timingNowEpochMs).toHaveBeenCalledOnce();
    expect(timing).toContainEqual(
      expect.objectContaining({
        operation: 'queue-retry',
        details: expect.objectContaining({ queueAgeMs: 1_000, dueAgeMs: 500 }),
      }),
    );
  });

  it('uses stored JSON wire identity for sparse upserts and rejects unsafe accessors', async () => {
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new TestResourceInboxResults();
    const handler = vi.fn((data: GroupMemberUpsertAppInboxPayload) =>
      Promise.resolve({ accepted: data }),
    );
    const service = new AppInboxService(
      {
        inboxQueueReader: reader,
        resourceInboxRepository: queue as never,
        resourceInboxResultsRepository: results as never,
        database: createAppInboxTestDatabase(queue, results),
      },
      {
        serviceId: 'server-12345678',
        defaultTopicId: SIMPLER_GROUP_STATE_APP_INBOX_TOPIC,
        options: {
          waitMaxElapsedMsecs: 5_000,
          waitRetryIntervalMsecs: 1,
          waitMaxRetryIntervalMsecs: 1,
          waitJitterRatio: 0,
        },
      },
    );
    service.onStateMessage(AppInboxType.GROUP_MEMBER_UPSERT, handler);
    const sparse = {
      type: AppInboxType.GROUP_MEMBER_UPSERT,
      resourceId: 'sparse-member-upsert',
      contextId: 'ar-eye-hunter:default:group-1',
      senderId: 'alice',
      data: {
        scope: SCOPE,
        groupId: 'group-1',
        principalId: 'alice',
        request: {
          status: 'active' as const,
          role: undefined,
          actorPrincipalId: 'alice',
          requestId: 'sparse-member-upsert',
        },
      },
    } satisfies AppInboxEnqueueInput<GroupMemberUpsertAppInboxPayload>;

    const pending = service.processEntryUntilCompletion(sparse);
    await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
    const first = await pending;

    await expect(
      service.processEntryUntilCompletion({
        ...sparse,
        data: {
          principalId: 'alice',
          request: {
            requestId: 'sparse-member-upsert',
            actorPrincipalId: 'alice',
            status: 'active',
          },
          groupId: 'group-1',
          scope: { workspaceId: 'default', applicationId: 'ar-eye-hunter' },
        },
      }),
    ).resolves.toEqual(first);
    await expect(
      service.processEntryUntilCompletion({
        ...sparse,
        data: {
          ...sparse.data,
          request: { ...sparse.data.request, status: 'left' },
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(Object.hasOwn(sparse.data.request, 'role')).toBe(true);
    expect(sparse.data.request.role).toBeUndefined();

    let getterCalls = 0;
    const unsafe = {
      ...sparse,
      resourceId: 'unsafe-member-upsert',
      data: {
        ...sparse.data,
        request: { ...sparse.data.request },
      },
    };
    Object.defineProperty(unsafe.data.request, 'role', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'member';
      },
    });
    await expect(service.processEntryUntilCompletion(unsafe)).rejects.toThrow(
      /JSON wire|accessor/u,
    );
    expect(getterCalls).toBe(0);
    await expect(
      service.processEntryUntilCompletion({
        ...sparse,
        resourceId: 'unsafe-array',
        data: { ...sparse.data, unsafe: [undefined] },
      } as never),
    ).rejects.toThrow(/JSON wire|array/u);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const [resourceId, value] of [
      ['unsafe-function', () => undefined],
      ['unsafe-bigint', 1n],
      ['unsafe-cycle', cycle],
      ['unsafe-nonfinite', Number.POSITIVE_INFINITY],
    ] as const) {
      await expect(
        service.processEntryUntilCompletion({
          ...sparse,
          resourceId,
          data: { ...sparse.data, unsafe: value },
        } as never),
      ).rejects.toThrow(/JSON wire/u);
    }
    expect(handler).toHaveBeenCalledOnce();
  });

  it('preserves an own __proto__ key through write, replay, and conflict', async () => {
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new TestResourceInboxResults();
    const handler = vi.fn((data: Readonly<Record<string, unknown>>) =>
      Promise.resolve({ accepted: data }),
    );
    const service = new AppInboxService(
      {
        inboxQueueReader: reader,
        resourceInboxRepository: queue as never,
        resourceInboxResultsRepository: results as never,
        database: createAppInboxTestDatabase(queue, results),
      },
      {
        serviceId: 'server-12345678',
        defaultTopicId: SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
        options: {
          waitMaxElapsedMsecs: 5_000,
          waitRetryIntervalMsecs: 1,
          waitMaxRetryIntervalMsecs: 1,
          waitJitterRatio: 0,
        },
      },
    );
    service.onStateMessage(AppInboxType.CLIENT_PRINCIPAL_UPSERT, handler);
    const firstData = JSON.parse(
      '{"principalId":"alice","request":{"requestId":"proto-command",' +
        '"metadata":{"alpha":1,"__proto__":{"flag":"first"}}}}',
    ) as Readonly<Record<string, unknown>>;
    const input = {
      type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
      resourceId: 'proto-command',
      contextId: 'app:workspace:alice',
      senderId: 'alice',
      data: firstData,
    } as const;

    const pending = service.processEntryUntilCompletion(input);
    await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
    const first = await pending;
    const reorderedData = JSON.parse(
      '{"request":{"metadata":{"__proto__":{"flag":"first"},"alpha":1},' +
        '"requestId":"proto-command"},"principalId":"alice"}',
    ) as Readonly<Record<string, unknown>>;

    await expect(
      service.processEntryUntilCompletion({
        ...input,
        data: reorderedData,
      }),
    ).resolves.toEqual(first);
    const changedData = JSON.parse(
      '{"principalId":"alice","request":{"requestId":"proto-command",' +
        '"metadata":{"alpha":1,"__proto__":{"flag":"changed"}}}}',
    ) as Readonly<Record<string, unknown>>;
    await expect(
      service.processEntryUntilCompletion({
        ...input,
        data: changedData,
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(handler).toHaveBeenCalledOnce();
    const handled = handler.mock.calls[0]?.[0] as {
      request: { metadata: Record<string, unknown> };
    };
    const metadata = handled.request.metadata;
    expect(Object.hasOwn(metadata, '__proto__')).toBe(true);
    expect(metadata.__proto__).toEqual({ flag: 'first' });
    expect([Object.prototype, null]).toContain(Object.getPrototypeOf(metadata));
    expect(({} as Record<string, unknown>).flag).toBeUndefined();
    const stored = readEnqueuedData<{
      request: { metadata: Record<string, unknown> };
    }>(readOnlyEntry(queue)!);
    expect(Object.hasOwn(stored.request.metadata, '__proto__')).toBe(true);
    expect(stored.request.metadata.__proto__).toEqual({ flag: 'first' });
  });

  it('rejects unsafe first-request JSON wire values before leaving any queue row', async () => {
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new TestResourceInboxResults();
    const handler = vi.fn(() => Promise.resolve({ accepted: true }));
    const service = new AppInboxService(
      {
        inboxQueueReader: reader,
        resourceInboxRepository: queue as never,
        resourceInboxResultsRepository: results as never,
        database: createAppInboxTestDatabase(queue, results),
      },
      {
        serviceId: 'server-12345678',
        defaultTopicId: SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
      },
    );
    service.onStateMessage(AppInboxType.CLIENT_PRINCIPAL_UPSERT, handler);
    let getterCalls = 0;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'unsafe';
      },
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const unsafeValues = [accessor, cycle, 1n, () => undefined, Number.NaN, [undefined]] as const;

    for (const [index, unsafe] of unsafeValues.entries()) {
      await expect(
        service.processEntryUntilCompletion({
          type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
          resourceId: `unsafe-first-${index}`,
          contextId: 'app:workspace:alice',
          senderId: 'alice',
          data: { unsafe },
        } as never),
      ).rejects.toThrow(/JSON wire/u);
      expect(await readEntries(queue)).toHaveLength(0);
    }
    expect(getterCalls).toBe(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects changed semantics while replaying reordered equal content', async () => {
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new TestResourceInboxResults();
    const handler = vi.fn((data: Readonly<Record<string, unknown>>) =>
      Promise.resolve({ accepted: data }),
    );
    const service = new AppInboxService(
      {
        inboxQueueReader: reader,
        resourceInboxRepository: queue as never,
        resourceInboxResultsRepository: results as never,
        database: createAppInboxTestDatabase(queue, results),
      },
      {
        serviceId: 'server-12345678',
        defaultTopicId: SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
        options: {
          waitMaxElapsedMsecs: 5_000,
          waitRetryIntervalMsecs: 1,
          waitMaxRetryIntervalMsecs: 1,
          waitJitterRatio: 0,
        },
      },
    );
    service.onStateMessage(AppInboxType.CLIENT_PRINCIPAL_UPSERT, handler);
    const firstInput = {
      type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
      resourceId: 'same-public-request',
      contextId: 'app:workspace:alice',
      senderId: 'alice',
      data: {
        principalId: 'alice',
        request: {
          requestId: 'same-public-request',
          metadata: { alpha: 1, beta: 2 },
        },
      },
    } as const;
    const firstPromise = service.processEntryUntilCompletion(firstInput);
    await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

    const first = await firstPromise;
    const reordered = await service.processEntryUntilCompletion({
      senderId: 'alice',
      contextId: 'app:workspace:alice',
      resourceId: 'same-public-request',
      type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
      data: {
        request: {
          metadata: { beta: 2, alpha: 1 },
          requestId: 'same-public-request',
        },
        principalId: 'alice',
      },
    });

    expect(reordered).toEqual(first);
    await expect(
      service.processEntryUntilCompletion({
        ...firstInput,
        data: {
          ...firstInput.data,
          request: {
            ...firstInput.data.request,
            metadata: { alpha: 1, beta: 3 },
          },
        },
      }),
    ).rejects.toMatchObject({
      name: 'AppInboxIdempotencyConflictError',
      code: 'app-inbox-idempotency-conflict',
      status: 409,
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('stores client idempotency conflict as terminal without queue retry', async () => {
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new TestResourceInboxResults();
    const service = new AppInboxService(
      {
        inboxQueueReader: reader,
        resourceInboxRepository: queue as never,
        resourceInboxResultsRepository: results as never,
        database: createAppInboxTestDatabase(queue, results),
      },
      {
        serviceId: 'server-12345678',
        defaultTopicId: SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
        options: {
          waitMaxElapsedMsecs: 5_000,
          waitRetryIntervalMsecs: 1,
          waitMaxRetryIntervalMsecs: 1,
          waitJitterRatio: 0,
        },
      },
    );
    const handler = vi.fn(() =>
      Promise.reject(
        new ClientMutationIdempotencyConflictError(
          'same-request',
          `sha256:${'a'.repeat(64)}`,
          `sha256:${'b'.repeat(64)}`,
        ),
      ),
    );
    service.onStateMessage(AppInboxType.CLIENT_PRINCIPAL_UPSERT, handler);
    const pending = service.processEntryUntilCompletion({
      type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
      resourceId: 'same-request',
      contextId: 'app:workspace:alice',
      data: { requestId: 'same-request', username: 'alice' },
    });

    await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
    const result = await pending;

    expect(JSON.parse(result.left ?? '{}')).toMatchObject({
      code: 'client-mutation-idempotency-conflict',
      status: 409,
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(readOnlyEntry(queue)?.status).toBe(EntityStatus.FAILED);
    expect(readOnlyEntry(queue)?.dequeueAudit.attempts).toBe(1);
  });

  it.each([
    [
      'client event',
      new ClientStateEventCollisionError({
        applicationId: SCOPE.applicationId,
        workspaceId: SCOPE.workspaceId,
        principalId: 'alice',
        eventId: 'collision-event',
      }),
      'client-state-event-collision',
    ],
    [
      'group event',
      new GroupStateEventCollisionError({
        applicationId: SCOPE.applicationId,
        workspaceId: SCOPE.workspaceId,
        groupId: 'collision-room',
        eventId: 'collision-event',
      }),
      'group-state-event-collision',
    ],
  ])('stores %s collision as terminal without queue retry', async (_label, error, code) => {
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new TestResourceInboxResults();
    const service = new AppInboxService(
      {
        inboxQueueReader: reader,
        resourceInboxRepository: queue as never,
        resourceInboxResultsRepository: results as never,
        database: createAppInboxTestDatabase(queue, results),
      },
      {
        serviceId: 'server-12345678',
        defaultTopicId: SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
        options: {
          waitMaxElapsedMsecs: 5_000,
          waitRetryIntervalMsecs: 1,
          waitMaxRetryIntervalMsecs: 1,
          waitJitterRatio: 0,
        },
      },
    );
    const handler = vi.fn(() => Promise.reject(error));
    service.onStateMessage(AppInboxType.CLIENT_PRINCIPAL_UPSERT, handler);
    const pending = service.processEntryUntilCompletion({
      type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
      resourceId: `terminal-${code}`,
      contextId: 'app:workspace:alice',
      data: { requestId: `terminal-${code}`, username: 'alice' },
    });

    await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
    const result = await pending;

    expect(JSON.parse(result.left ?? '{}')).toMatchObject({ code, status: 409 });
    expect(handler).toHaveBeenCalledOnce();
    expect(readOnlyEntry(queue)?.status).toBe(EntityStatus.FAILED);
    expect(readOnlyEntry(queue)?.dequeueAudit.attempts).toBe(1);
  });

  it('maps resource_inbox_results rows from ris columns into queue entries', () => {
    const entry = toResultsDomain({
      ris_row_id: 123n,
      ris_resource_id: 'request-1',
      ris_topic_id: 'app-inbox.group-state',
      ris_resource: JSON.stringify({ ok: true }),
      ris_type_id: 'APP_INBOX',
      ris_status: EntityStatus.COMPLETED,
      fk_ext_bank_id: 'group-create',
      system_date: '2026-05-20',
      created_by: 'server-1',
      created_ts: '2026-05-20T10:00:00.000',
      expire_ts: '2026-05-20T10:05:00.000',
    });

    expect(entry.key).toEqual({
      topicId: 'app-inbox.group-state',
      resourceId: 'request-1',
      contextId: 'group-create',
    });
    expect(entry.resource).toBe(JSON.stringify({ ok: true }));
    expect(entry.status).toBe(EntityStatus.COMPLETED);
    expect(entry.dequeueAudit.attempts).toBe(0);
    expect(entry.db?.id).toBe('123');
  });
});

class TestResourceInbox extends InMemoryQueueBox {
  async isEntryWithStatus(key: Key, statuses: EntityStatus[]): Promise<boolean> {
    const entry = await this.getItem(key);
    return entry !== undefined && statuses.includes(entry.status);
  }
}

class CapturingInboxQueueReader extends InboxQueueReader {
  private callback: OnMessageCallback | undefined;

  override onInboxMessageDo(_type: string, callback: OnMessageCallback): this {
    this.callback = callback;
    return this;
  }

  async invoke(
    message: Parameters<OnMessageCallback['onMessage']>[0],
    entry: ResourceEntry,
  ): Promise<void> {
    if (this.callback === undefined) {
      throw new Error('Expected AppInbox handler registration');
    }
    await this.callback.onMessage(message, entry);
  }
}

class TestResourceInboxResults {
  private readonly data = new Map<string, ResourceEntry>();

  async replace(entry: ResourceEntry): Promise<ResourceEntry> {
    this.data.set(toKeyAsString(entry.key), entry);
    return entry;
  }

  async writeIfAbsentOrReplaceExpired(entry: ResourceEntry): Promise<ResourceEntry> {
    const key = toKeyAsString(entry.key);
    const existing = this.data.get(key);
    if (existing !== undefined && !isExpiredResourceEntry(existing)) {
      return existing;
    }

    this.data.set(key, entry);
    return entry;
  }

  async findByKey(key: Key): Promise<ResourceEntry | undefined> {
    const entry = this.data.get(toKeyAsString(key));
    return entry === undefined || isExpiredResourceEntry(entry) ? undefined : entry;
  }
}

async function readEntries(queue: InMemoryQueueBox): Promise<ResourceEntry[]> {
  const entries = await Promise.all((await queue.getAllKeys()).map((key) => queue.getItem(key)));

  return entries.filter((entry): entry is ResourceEntry => entry !== undefined);
}

function readEnqueuedData<V>(entry: ResourceEntry): V {
  const message = JSON.parse(entry.resource) as {
    payload: {
      resource: string;
    };
  };
  const enqueue = JSON.parse(message.payload.resource) as {
    data: V;
  };

  return enqueue.data;
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

function readOnlyEntry(queue: InMemoryQueueBox): ResourceEntry | undefined {
  const data = (
    queue as unknown as {
      data: Map<string, ResourceEntry>;
    }
  ).data;

  return data.values().next().value;
}
