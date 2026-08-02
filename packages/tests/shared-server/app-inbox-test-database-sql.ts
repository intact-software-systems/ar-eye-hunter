import { Temporal } from '@js-temporal/polyfill';

import type { EntityStatus, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { ResourceInboxInvariantCorruptionError } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';

import type {
  AppInboxTestDatabaseOptions,
  AppInboxTestDatabaseState,
  AppInboxTestPendingWrites,
  AppInboxTestResourceRepositories,
  AppInboxTestSqlExecution,
} from './app-inbox-test-database-contracts.ts';
import { tryExecuteRuntimeStateConditionalMutation } from './app-inbox-runtime-state-mutation.ts';

interface CreateAppInboxTestTransactionSqlInput {
  readonly repositories: AppInboxTestResourceRepositories;
  readonly options: AppInboxTestDatabaseOptions;
  readonly state: AppInboxTestDatabaseState;
  readonly pending: AppInboxTestPendingWrites;
  readonly runtime: AppInboxTestSqlExecution['runtime'];
}

export function createAppInboxTestTransactionSql(
  input: CreateAppInboxTestTransactionSqlInput,
): PSqlTransactionSql {
  const transaction = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?').replace(/\s+/gu, ' ').trim().toLowerCase();
    return await executeAppInboxTestSql({ ...input, query, values });
  }) as unknown as PSqlTransactionSql;
  transaction.begin = async () => {
    throw new Error('Nested app inbox transaction');
  };
  return transaction;
}

async function executeAppInboxTestSql(input: AppInboxTestSqlExecution): Promise<unknown[]> {
  const runtimeStateResult = await executeRuntimeStateSql(input);
  if (runtimeStateResult) return runtimeStateResult;
  const eventResult = await executeStateEventSql(input);
  if (eventResult) return eventResult;
  const resultAndReservation = await executeResultAndReservationSql(input);
  if (resultAndReservation) return resultAndReservation;
  const outboxResult = executeOutboxSql(input);
  if (outboxResult) return outboxResult;
  throw new Error(`Unexpected app inbox transaction SQL: ${input.query}`);
}

async function executeRuntimeStateSql(
  input: AppInboxTestSqlExecution,
): Promise<unknown[] | undefined> {
  const writeResult = await executeRuntimeStateWriteSql(input);
  if (writeResult) return writeResult;
  const conditionalMutation = await tryExecuteRuntimeStateConditionalMutation(
    input.query,
    input.runtime,
    input.values,
  );
  if (conditionalMutation) return conditionalMutation;
  return await executeRuntimeStateSelectionSql(input);
}

async function executeRuntimeStateWriteSql({
  query,
  runtime,
  values,
}: AppInboxTestSqlExecution): Promise<unknown[] | undefined> {
  const insertsAbsentEntry =
    query.includes('insert into runtime_state_store') &&
    query.includes('do nothing') &&
    query.includes('returning revision');
  if (insertsAbsentEntry) {
    const repository = requireTransactionRuntime(runtime);
    const [namespace, key, value, expireAt] = values as [string, string, string, Date];
    const result = await repository.insertIfAbsent(namespace, key, value, expireAt.getTime());
    return result.status === 'applied' ? [{ revision: result.revision }] : [];
  }
  if (query.includes('insert into runtime_state_store') && query.includes('do update set')) {
    const repository = requireTransactionRuntime(runtime);
    const [namespace, key, value, expireAt] = values as [string, string, string, Date];
    await repository.upsert(namespace, key, value, expireAt.getTime());
    return [];
  }
  return undefined;
}

async function executeRuntimeStateSelectionSql({
  query,
  runtime,
  values,
}: AppInboxTestSqlExecution): Promise<unknown[] | undefined> {
  if (!query.includes('jsonb_array_elements') || !query.includes('as selections')) {
    return undefined;
  }
  const repository = requireTransactionRuntime(runtime);
  const rawSelectors = typeof values[0] === 'string' ? JSON.parse(values[0]) : values[0];
  if (!Array.isArray(rawSelectors)) {
    throw new Error('Runtime-state batch selectors are required');
  }
  const selections = [];
  for (const rawSelector of rawSelectors) {
    const selector = rawSelector as Readonly<{
      selectorId: string;
      kind: 'key' | 'prefix';
      namespace: string;
      key: string | null;
      keyPrefix: string | null;
    }>;
    const entries =
      selector.kind === 'key'
        ? await repository.findEntriesByKeys(
            selector.namespace,
            selector.key === null ? [] : [selector.key],
          )
        : await repository.findEntriesByPrefix(selector.namespace, selector.keyPrefix ?? '');
    selections.push({ selectorId: selector.selectorId, entries });
  }
  return [{ selections }];
}

function requireTransactionRuntime(runtime: AppInboxTestSqlExecution['runtime']) {
  if (!runtime) {
    throw new Error('Runtime-state SQL requires a transaction runtime');
  }
  return runtime;
}

async function executeStateEventSql(
  input: AppInboxTestSqlExecution,
): Promise<unknown[] | undefined> {
  if (input.query.includes('insert into client_state_events')) {
    const event = readStateEvent<ClientEvent>(input.values, 'Client');
    input.pending.clientEvents.push(event);
    return [{ event_id: event.eventId }];
  }
  if (input.query.includes('insert into group_state_events')) {
    const event = readStateEvent<GroupEvent>(input.values, 'Group');
    input.pending.groupEvents.push(event);
    return [{ event_id: event.eventId }];
  }
  if (!input.query.includes('from group_state_events')) return undefined;
  const [applicationId, workspaceKey, groupId] = input.values as string[];
  const workspaceId = workspaceKey === '_' ? undefined : workspaceKey;
  return [...input.state.groupEventStore.events, ...input.pending.groupEvents]
    .filter(
      (event) =>
        event.applicationId === applicationId &&
        event.workspaceId === workspaceId &&
        event.groupId === groupId,
    )
    .map((event) => ({
      event_id: event.eventId,
      event_type: event.eventType,
      snapshot_version: event.snapshotVersion,
      occurred_at_epoch_ms: event.occurredAtEpochMs,
      event_json: JSON.stringify(event),
    }));
}

function readStateEvent<T>(values: readonly unknown[], family: 'Client' | 'Group'): T {
  const eventJson = values.at(-1);
  if (typeof eventJson !== 'string') {
    throw new Error(`${family} state event JSON is required`);
  }
  return JSON.parse(eventJson) as T;
}

async function executeResultAndReservationSql(
  input: AppInboxTestSqlExecution,
): Promise<unknown[] | undefined> {
  if (input.query.includes('insert into resource_inbox_results')) {
    await input.options.onStage?.('resource-result-replace');
    const entry = toResultEntry(input.values);
    input.pending.results.push(entry);
    return [toResultRow(entry)];
  }
  if (
    !input.query.includes('update resource_inbox') ||
    !input.query.includes("ri_status = 'reserved'")
  ) {
    return undefined;
  }
  await input.options.onStage?.('reservation-finish');
  const [status, completedAt, topicId, resourceId, contextId, attempts] = input.values as [
    EntityStatus,
    Date,
    string,
    string,
    string,
    number,
  ];
  const current = await input.repositories.inbox.getItem({ topicId, resourceId, contextId });
  if (
    !current ||
    current.status !== 'RESERVED' ||
    current.dequeueAudit.attempts !== attempts ||
    Number(current.audit.expiryTs.epochMilliseconds) <= completedAt.getTime()
  ) {
    return [];
  }
  const entry: ResourceEntry = {
    ...current,
    status,
    dequeueAudit: {
      ...current.dequeueAudit,
      endTs: Temporal.Instant.fromEpochMilliseconds(completedAt.getTime()),
      nextTs: undefined,
    },
  };
  input.pending.inbox.push(entry);
  return [toInboxRow(entry)];
}

function executeOutboxSql(input: AppInboxTestSqlExecution): unknown[] | undefined {
  const insertsOutbox =
    input.query.includes('insert into resource_inbox') &&
    input.query.includes('on conflict') &&
    input.query.includes('do nothing');
  if (insertsOutbox) {
    const entry = toInboxEntry(input.values);
    if (input.options.shouldFailOutboxWrite?.()) {
      throw new ResourceInboxInvariantCorruptionError(
        entry.key,
        'Injected AppInbox outbox collision',
      );
    }
    const key = toResourceKey(entry);
    if (input.pending.outbox.has(key)) return [];
    input.pending.outbox.set(key, entry);
    return [toInboxRow(entry)];
  }
  if (input.query.includes('from resource_inbox') && input.query.includes('where ri_topic_id')) {
    const [topicId, resourceId, contextId] = input.values as string[];
    const entry = input.pending.outbox.get(`${contextId}:${topicId}:${resourceId}`);
    return entry ? [toInboxRow(entry)] : [];
  }
  return undefined;
}

function toInboxEntry(values: readonly unknown[]): ResourceEntry {
  const [
    resourceId,
    topicId,
    resource,
    typeId,
    status,
    contextId,
    systemDate,
    createdBy,
    createdTs,
    expiryTs,
    startTs,
    endTs,
    nextTs,
    attempts,
  ] = values;
  return {
    key: {
      resourceId: resourceId as string,
      topicId: topicId as string,
      contextId: contextId as string,
    },
    resource: resource as string,
    typeId: typeId as string,
    status: status as EntityStatus,
    audit: {
      date: Temporal.PlainDate.from(systemDate as string)
        .toPlainDateTime()
        .toPlainTime(),
      createdBy: createdBy as string,
      createdTs: toPlainDateTime(createdTs),
      expiryTs: toInstant(expiryTs),
    },
    dequeueAudit: {
      startTs: startTs === null ? undefined : toInstant(startTs),
      endTs: endTs === null ? undefined : toInstant(endTs),
      nextTs: nextTs === null ? undefined : toInstant(nextTs),
      attempts: Number(attempts),
    },
  };
}

function toResultEntry(values: readonly unknown[]): ResourceEntry {
  const [
    resourceId,
    topicId,
    resource,
    typeId,
    status,
    contextId,
    systemDate,
    createdBy,
    createdTs,
    expiryTs,
  ] = values;
  return {
    key: {
      resourceId: resourceId as string,
      topicId: topicId as string,
      contextId: contextId as string,
    },
    resource: resource as string,
    typeId: typeId as string,
    status: status as EntityStatus,
    audit: {
      date: Temporal.PlainDate.from(systemDate as string)
        .toPlainDateTime()
        .toPlainTime(),
      createdBy: createdBy as string,
      createdTs: toPlainDateTime(createdTs),
      expiryTs: String(expiryTs).endsWith('Z')
        ? Temporal.Instant.from(expiryTs as string)
        : Temporal.PlainDateTime.from(expiryTs as string)
            .toZonedDateTime('UTC')
            .toInstant(),
    },
    dequeueAudit: { attempts: 0 },
  };
}

function toResultRow(entry: ResourceEntry) {
  return {
    ris_row_id: 1n,
    ris_resource_id: entry.key.resourceId,
    ris_topic_id: entry.key.topicId,
    ris_resource: entry.resource,
    ris_type_id: entry.typeId,
    ris_status: entry.status,
    fk_ext_bank_id: entry.key.contextId,
    system_date: entry.audit.createdTs.toPlainDate().toString(),
    created_by: entry.audit.createdBy,
    created_ts: entry.audit.createdTs.toString(),
    expire_ts: entry.audit.expiryTs.toZonedDateTimeISO('UTC').toPlainDateTime().toString(),
  };
}

function toInboxRow(entry: ResourceEntry) {
  return {
    ri_row_id: 1n,
    ri_resource_id: entry.key.resourceId,
    ri_topic_id: entry.key.topicId,
    ri_resource: entry.resource,
    ri_type_id: entry.typeId,
    ri_status: entry.status,
    fk_ext_bank_id: entry.key.contextId,
    system_date: entry.audit.createdTs.toPlainDate().toString(),
    created_by: entry.audit.createdBy,
    created_ts: entry.audit.createdTs.toString(),
    expire_ts: entry.audit.expiryTs.toZonedDateTimeISO('UTC').toPlainDateTime().toString(),
    start_ts: entry.dequeueAudit.startTs?.toString() ?? null,
    end_ts: entry.dequeueAudit.endTs?.toString() ?? null,
    next_ts: entry.dequeueAudit.nextTs?.toString() ?? null,
    ri_attempts: BigInt(entry.dequeueAudit.attempts),
  };
}

function toPlainDateTime(value: unknown): Temporal.PlainDateTime {
  return Temporal.PlainDateTime.from(String(value).replace(/Z$/u, ''));
}

function toInstant(value: unknown): Temporal.Instant {
  const text = String(value);
  return Temporal.Instant.from(text.endsWith('Z') ? text : `${text}Z`);
}

function toResourceKey(entry: ResourceEntry): string {
  return `${entry.key.contextId}:${entry.key.topicId}:${entry.key.resourceId}`;
}
