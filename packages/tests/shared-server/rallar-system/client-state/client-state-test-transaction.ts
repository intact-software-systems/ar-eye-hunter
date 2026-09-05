import { Temporal } from '@js-temporal/polyfill';
import type { PSqlParameter, PSqlRows, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { ResourceInboxInvariantCorruptionError } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { validateClientEvent } from '@shared-server/rallar-system/client-state/client-state-contract-validation.ts';
import type { ClientStateEventStore } from '@shared-server/rallar-system/state-events/client-state-event-store.ts';
import type { RuntimeStateOptimisticTransactionalRepositoryLike } from '@shared-server/runtime-state/runtime-state-repository.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

const OUTBOX_BY_RUNTIME = new WeakMap<object, Map<string, ResourceEntry>>();
const OUTBOX_FAILURES_BY_RUNTIME = new WeakMap<object, number>();

interface CreateClientStateTestTransactionInput {
    readonly runtime: RuntimeStateOptimisticTransactionalRepositoryLike;
    readonly runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike;
    readonly eventStore: ClientStateEventStore;
}

interface ClientStateTestSqlInput extends CreateClientStateTestTransactionInput {
    readonly query: string;
    readonly values: readonly PSqlParameter[];
}

interface ClientStateTestOutboxRow {
    readonly ri_row_id: bigint;
    readonly ri_resource_id: string;
    readonly ri_topic_id: string;
    readonly ri_resource: string;
    readonly ri_type_id: string;
    readonly ri_status: EntityStatus;
    readonly fk_ext_bank_id: string;
    readonly system_date: string;
    readonly created_by: string;
    readonly created_ts: string;
    readonly expire_ts: string;
    readonly start_ts: string | null;
    readonly end_ts: string | null;
    readonly next_ts: string | null;
    readonly ri_attempts: bigint;
}

export function createClientStateTestTransaction(
    input: CreateClientStateTestTransactionInput
): PSqlSql {
    function transaction<Result>(
        strings: TemplateStringsArray,
        ...values: readonly PSqlParameter[]
    ): Promise<Result>;
    function transaction(values: readonly PSqlParameter[]): object;
    function transaction<Result>(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): Promise<Result> | object {
        if (!isTemplateStringsArray(stringsOrValues)) {
            return {};
        }
        return executeClientStateTestSql({
            ...input,
            query: stringsOrValues.join('?').replace(/\s+/gu, ' ').trim().toLowerCase(),
            values
        }).then((rows) => rows as Result);
    }
    transaction.begin = async <T>(_work: (sql: PSqlSql) => Promise<T>): Promise<T> => {
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

async function executeClientStateTestSql(input: ClientStateTestSqlInput): Promise<PSqlRows> {
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

async function insertRuntimeState(input: ClientStateTestSqlInput): Promise<PSqlRows> {
    const namespace = requireStringParameter(input.values[0], 'runtime-state namespace');
    const key = requireStringParameter(input.values[1], 'runtime-state key');
    const value = requireStringParameter(input.values[2], 'runtime-state value');
    const expireAt = requireTimestampParameter(input.values[3], 'runtime-state expiry');
    const result = await input.runtime.insertIfAbsent(namespace, key, value, expireAt.getTime());
    return result.status === 'applied' ? [{ revision: result.revision }] : [];
}

async function updateRuntimeState(input: ClientStateTestSqlInput): Promise<PSqlRows> {
    const value = requireStringParameter(input.values[0], 'runtime-state value');
    const expireAt = requireTimestampParameter(input.values[1], 'runtime-state expiry');
    const namespace = requireStringParameter(input.values[2], 'runtime-state namespace');
    const key = requireStringParameter(input.values[3], 'runtime-state key');
    const expectedRevision = requireIntegerParameter(
        input.values[4],
        'runtime-state expected revision'
    );
    const result = await input.runtime.upsertIfRevision(
        namespace,
        key,
        value,
        expireAt.getTime(),
        expectedRevision
    );
    return result.status === 'applied' ? [{ revision: result.revision }] : [];
}

async function appendClientStateEvent(input: ClientStateTestSqlInput): Promise<PSqlRows> {
    const eventJson = input.values.at(-1);
    if (typeof eventJson !== 'string') {
        throw new Error('Client state event JSON is required');
    }
    const event: unknown = JSON.parse(eventJson);
    validateClientEvent(event, 'Client state test transaction event');
    await input.eventStore.appendClientEvent(event);
    return [{ event_id: event.eventId }];
}

function insertClientStateTestOutbox(input: ClientStateTestSqlInput): PSqlRows {
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

function readClientStateTestOutbox(input: ClientStateTestSqlInput): PSqlRows {
    const topicId = requireStringParameter(input.values[0], 'outbox topic id');
    const resourceId = requireStringParameter(input.values[1], 'outbox resource id');
    const contextId = requireStringParameter(input.values[2], 'outbox context id');
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

function toEntry(values: readonly PSqlParameter[]): ResourceEntry {
    const resourceId = requireStringParameter(values[0], 'outbox resource id');
    const topicId = requireStringParameter(values[1], 'outbox topic id');
    const resource = requireStringParameter(values[2], 'outbox resource');
    const typeId = requireStringParameter(values[3], 'outbox type id');
    const status = requireEntityStatus(values[4]);
    const contextId = requireStringParameter(values[5], 'outbox context id');
    const systemDate = requireStringParameter(values[6], 'outbox system date');
    const createdBy = requireStringParameter(values[7], 'outbox creator');
    const createdTs = requireStringParameter(values[8], 'outbox creation timestamp');
    const expiryTs = requireStringParameter(values[9], 'outbox expiry timestamp');
    const startTs = toOptionalInstant(values[10], 'outbox reservation start');
    const endTs = toOptionalInstant(values[11], 'outbox reservation end');
    const nextTs = toOptionalInstant(values[12], 'outbox next-attempt timestamp');
    const attempts = requireIntegerParameter(values[13], 'outbox attempts');
    return {
        key: { resourceId, topicId, contextId },
        resource,
        typeId,
        status,
        audit: {
            date: Temporal.PlainDate.from(systemDate)
                .toPlainDateTime()
                .toPlainTime(),
            createdBy,
            createdTs: Temporal.PlainDateTime.from(createdTs.replace(/Z$/u, '')),
            expiryTs: toInstant(expiryTs)
        },
        dequeueAudit: {
            startTs,
            endTs,
            nextTs,
            attempts
        }
    };
}

function toInstant(value: string): Temporal.Instant {
    return Temporal.Instant.from(value.endsWith('Z') ? value : `${value}Z`);
}

function toKey(entry: ResourceEntry): string {
    return `${entry.key.contextId}:${entry.key.topicId}:${entry.key.resourceId}`;
}

function toRow(entry: ResourceEntry): ClientStateTestOutboxRow {
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

function isTemplateStringsArray(
    value: TemplateStringsArray | readonly PSqlParameter[]
): value is TemplateStringsArray {
    return 'raw' in value;
}

function requireStringParameter(value: PSqlParameter, label: string): string {
    if (typeof value !== 'string') {
        throw new TypeError(`${label} must be a string`);
    }
    return value;
}

function requireTimestampParameter(value: PSqlParameter, label: string): Date {
    const date = value instanceof Date
        ? value
        : typeof value === 'string'
        ? new Date(value)
        : null;
    if (date === null || !Number.isFinite(date.getTime())) {
        throw new TypeError(`${label} must be a valid Date`);
    }
    return date;
}

function requireIntegerParameter(value: PSqlParameter, label: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${label} must be a non-negative safe integer`);
    }
    return value;
}

function requireEntityStatus(value: PSqlParameter): EntityStatus {
    switch (value) {
        case EntityStatus.NEW:
        case EntityStatus.RETRY:
        case EntityStatus.RESERVED:
        case EntityStatus.COMPLETED:
        case EntityStatus.FAILED:
        case EntityStatus.ABORTED:
        case EntityStatus.NON_RETRYABLE:
        case EntityStatus.PARTITIONED:
        case EntityStatus.MERGED:
            return value;
        default:
            throw new TypeError('outbox status is invalid');
    }
}

function toOptionalInstant(value: PSqlParameter, label: string): Temporal.Instant | undefined {
    return value === null ? undefined : toInstant(requireStringParameter(value, label));
}
