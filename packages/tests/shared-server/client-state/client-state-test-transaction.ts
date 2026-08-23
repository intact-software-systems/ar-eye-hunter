import { Temporal } from '@js-temporal/polyfill';
import type { PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { ResourceInboxInvariantCorruptionError } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import type { ClientStateEventStore } from '@shared-server/rallar-system/state-events/state-event-store.ts';
import type { RuntimeStateOptimisticTransactionalRepositoryLike } from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

const OUTBOX_BY_RUNTIME = new WeakMap<object, Map<string, ResourceEntry>>();
const OUTBOX_FAILURES_BY_RUNTIME = new WeakMap<object, number>();

interface CreateClientStateTestTransactionInput {
    readonly runtime: RuntimeStateOptimisticTransactionalRepositoryLike;
    readonly runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike;
    readonly eventStore: ClientStateEventStore;
}

interface ClientStateTestSqlInput extends CreateClientStateTestTransactionInput {
    readonly query: string;
    readonly values: readonly unknown[];
}

export function createClientStateTestTransaction(
    input: CreateClientStateTestTransactionInput
): PSqlTransactionSql {
    const transaction = (async (strings: TemplateStringsArray, ...values: unknown[]) =>
        await executeClientStateTestSql({
            ...input,
            query: strings.join('?').replace(/\s+/gu, ' ').trim().toLowerCase(),
            values
        })) as unknown as PSqlTransactionSql;
    transaction.begin = async () => {
        throw new Error('Nested client test transaction');
    };
    return transaction;
}

export function getClientStateTestOutbox(
    runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike
): readonly ResourceEntry[] {
    return [...outboxFor(runtimeRepository).values()];
}

export function failNextClientStateTestOutboxWrite(
    runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike
): void {
    const identity = runtimeRepository as object;
    OUTBOX_FAILURES_BY_RUNTIME.set(identity, (OUTBOX_FAILURES_BY_RUNTIME.get(identity) ?? 0) + 1);
}

export function captureClientStateTestOutbox(
    runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike
): Map<string, ResourceEntry> {
    return new Map(outboxFor(runtimeRepository));
}

export function restoreClientStateTestOutbox(
    runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike,
    entries: ReadonlyMap<string, ResourceEntry>
): void {
    const outbox = outboxFor(runtimeRepository);
    outbox.clear();
    for (const [key, entry] of entries) {
        outbox.set(key, entry);
    }
}

async function executeClientStateTestSql(input: ClientStateTestSqlInput): Promise<unknown[]> {
    if (
        input.query.includes('insert into runtime_state_store') &&
        input.query.includes('do nothing') &&
        input.query.includes('returning revision')
    ) {
        return await insertRuntimeState(input);
    }
    if (
        input.query.includes('update runtime_state_store') &&
        input.query.includes('returning revision')
    ) {
        return await updateRuntimeState(input);
    }
    if (input.query.includes('insert into client_state_events')) {
        return await appendClientStateEvent(input);
    }
    if (input.query.includes('insert into resource_inbox')) {
        return insertClientStateTestOutbox(input);
    }
    if (input.query.includes('from resource_inbox')) {
        return readClientStateTestOutbox(input);
    }
    throw new Error(`Unexpected client test transaction SQL: ${input.query}`);
}

async function insertRuntimeState(input: ClientStateTestSqlInput): Promise<unknown[]> {
    const [namespace, key, value, expireAt] = input.values as [string, string, string, Date];
    const result = await input.runtime.insertIfAbsent(namespace, key, value, expireAt.getTime());
    return result.status === 'applied' ? [{ revision: result.revision }] : [];
}

async function updateRuntimeState(input: ClientStateTestSqlInput): Promise<unknown[]> {
    const [value, expireAt, namespace, key, expectedRevision] = input.values as [
        string,
        Date,
        string,
        string,
        number
    ];
    const result = await input.runtime.upsertIfRevision(
        namespace,
        key,
        value,
        expireAt.getTime(),
        expectedRevision
    );
    return result.status === 'applied' ? [{ revision: result.revision }] : [];
}

async function appendClientStateEvent(input: ClientStateTestSqlInput): Promise<unknown[]> {
    const eventJson = input.values.at(-1);
    if (typeof eventJson !== 'string') {
        throw new Error('Client state event JSON is required');
    }
    const event = JSON.parse(eventJson) as ClientEvent;
    await input.eventStore.appendClientEvent(event);
    return [{ event_id: event.eventId }];
}

function insertClientStateTestOutbox(input: ClientStateTestSqlInput): unknown[] {
    const entry = toEntry(input.values);
    const identity = input.runtimeRepository as object;
    const failures = OUTBOX_FAILURES_BY_RUNTIME.get(identity) ?? 0;
    if (failures > 0) {
        OUTBOX_FAILURES_BY_RUNTIME.set(identity, failures - 1);
        throw new ResourceInboxInvariantCorruptionError(
            entry.key,
            'Injected client test outbox collision'
        );
    }
    const outbox = outboxFor(input.runtimeRepository);
    const key = toKey(entry);
    if (outbox.has(key)) {
        return [];
    }
    outbox.set(key, entry);
    return [toRow(entry)];
}

function readClientStateTestOutbox(input: ClientStateTestSqlInput): unknown[] {
    const [topicId, resourceId, contextId] = input.values as string[];
    const entry = outboxFor(input.runtimeRepository).get(`${contextId}:${topicId}:${resourceId}`);
    return entry ? [toRow(entry)] : [];
}

function outboxFor(
    runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike
): Map<string, ResourceEntry> {
    const identity = runtimeRepository as object;
    let entries = OUTBOX_BY_RUNTIME.get(identity);
    if (!entries) {
        entries = new Map();
        OUTBOX_BY_RUNTIME.set(identity, entries);
    }
    return entries;
}

function toEntry(values: readonly unknown[]): ResourceEntry {
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
        attempts
    ] = values;
    return {
        key: { resourceId, topicId, contextId } as ResourceEntry['key'],
        resource: resource as string,
        typeId: typeId as string,
        status: status as ResourceEntry['status'],
        audit: {
            date: Temporal.PlainDate.from(systemDate as string)
                .toPlainDateTime()
                .toPlainTime(),
            createdBy: createdBy as string,
            createdTs: Temporal.PlainDateTime.from(String(createdTs).replace(/Z$/u, '')),
            expiryTs: toInstant(expiryTs)
        },
        dequeueAudit: {
            startTs: startTs === null ? undefined : toInstant(startTs),
            endTs: endTs === null ? undefined : toInstant(endTs),
            nextTs: nextTs === null ? undefined : toInstant(nextTs),
            attempts: Number(attempts)
        }
    };
}

function toInstant(value: unknown): Temporal.Instant {
    const text = String(value);
    return Temporal.Instant.from(text.endsWith('Z') ? text : `${text}Z`);
}

function toKey(entry: ResourceEntry): string {
    return `${entry.key.contextId}:${entry.key.topicId}:${entry.key.resourceId}`;
}

function toRow(entry: ResourceEntry) {
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
        ri_attempts: BigInt(entry.dequeueAudit.attempts)
    };
}
