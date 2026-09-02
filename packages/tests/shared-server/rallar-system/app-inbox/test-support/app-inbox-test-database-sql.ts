import { Temporal } from '@js-temporal/polyfill';

// dprint-ignore
import type {
    PSqlParameter,
    PSqlRows,
    PSqlSql
} from '@shared-server/postgres/p-sql-sql.ts';
import { ResourceInboxInvariantCorruptionError } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
// dprint-ignore
import {
    decodeJsonWireValue,
    type JsonWireObject,
    type JsonWireValue
} from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { RuntimeStateReadBatchSelector } from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import { validateRuntimeStateReadBatchSelectors } from '@shared-server/runtime-state/read-batch/validate-runtime-state-read-batch-selectors.ts';
import { validateAuthoritativeClientEvent, validateAuthoritativeGroupEvent } from '@shared/api/authoritative-state-validation.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { tryExecuteRuntimeStateConditionalMutation, tryExecuteRuntimeStateGuardedBatch } from './app-inbox-runtime-state-mutation.ts';
import type {
    AppInboxTestDatabaseOptions,
    AppInboxTestDatabaseState,
    AppInboxTestPendingWrites,
    AppInboxTestResourceRepositories,
    AppInboxTestSqlExecution
} from './app-inbox-test-database-contracts.ts';

interface CreateAppInboxTestTransactionSqlInput {
    readonly repositories: AppInboxTestResourceRepositories;
    readonly options: AppInboxTestDatabaseOptions;
    readonly state: AppInboxTestDatabaseState;
    readonly pending: AppInboxTestPendingWrites;
    readonly runtime: AppInboxTestSqlExecution['runtime'];
}

interface ResourceInboxResultDatabaseRow {
    readonly ris_row_id: bigint;
    readonly ris_resource_id: string;
    readonly ris_topic_id: string;
    readonly ris_resource: string;
    readonly ris_type_id: string;
    readonly ris_status: EntityStatus;
    readonly fk_ext_bank_id: string;
    readonly system_date: string;
    readonly created_by: string;
    readonly created_ts: string;
    readonly expire_ts: string;
}

interface ResourceInboxDatabaseRow {
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

export function createAppInboxTestDatabaseSql(
    input: CreateAppInboxTestTransactionSqlInput
): PSqlSql {
    function transactionSql(values: readonly PSqlParameter[]): object;
    function transactionSql<Result>(
        strings: TemplateStringsArray,
        ...values: readonly PSqlParameter[]
    ): Promise<Result>;
    function transactionSql<Result>(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): object | Promise<Result> {
        if (!('raw' in stringsOrValues)) {
            return { values: stringsOrValues };
        }
        const strings = stringsOrValues;
        const query = strings.join('?').replace(/\s+/gu, ' ').trim().toLowerCase();
        return executeAppInboxTestSql({ ...input, query, values })
            .then((rows) => rows as Result);
    }

    return Object.assign(transactionSql, {
        begin: async <T>(_write: (sql: PSqlSql) => Promise<T>): Promise<T> => {
            throw new Error('Nested app inbox transaction');
        }
    });
}

async function executeAppInboxTestSql(
    input: AppInboxTestSqlExecution
): Promise<PSqlRows> {
    const runtimeStateResult = await executeRuntimeStateSql(input);
    if (runtimeStateResult) {
        return runtimeStateResult;
    }
    const eventResult = await executeStateEventSql(input);
    if (eventResult) {
        return eventResult;
    }
    const resultAndReservation = await executeResultAndReservationSql(input);
    if (resultAndReservation) {
        return resultAndReservation;
    }
    const outboxResult = executeOutboxSql(input);
    if (outboxResult) {
        return outboxResult;
    }
    throw new Error(`Unexpected app inbox transaction SQL: ${input.query}`);
}

async function executeRuntimeStateSql(
    input: AppInboxTestSqlExecution
): Promise<PSqlRows | undefined> {
    const guardedBatch = await tryExecuteRuntimeStateGuardedBatch(input);
    if (guardedBatch) {
        return guardedBatch;
    }
    const writeResult = await executeRuntimeStateWriteSql(input);
    if (writeResult) {
        return writeResult;
    }
    const conditionalMutation = await tryExecuteRuntimeStateConditionalMutation(input);
    if (conditionalMutation) {
        return conditionalMutation;
    }
    return await executeRuntimeStateSelectionSql(input);
}

async function executeRuntimeStateWriteSql({
    query,
    runtime,
    values
}: AppInboxTestSqlExecution): Promise<PSqlRows | undefined> {
    const insertsAbsentEntry = query.includes('insert into runtime_state_store') &&
        query.includes('do nothing') &&
        query.includes('returning revision');
    if (insertsAbsentEntry) {
        const repository = requireTransactionRuntime(runtime);
        const namespace = decodeStringParameter(values[0], 'Runtime-state namespace');
        const key = decodeStringParameter(values[1], 'Runtime-state key');
        const value = decodeStringParameter(values[2], 'Runtime-state value');
        const expireAtIsoTimestamp = decodeStringParameter(values[3], 'Runtime-state expiry');
        const result = await repository.insertIfAbsent(
            namespace,
            key,
            value,
            expireAtIsoTimestamp
        );
        return result.status === 'applied' ? [{ revision: result.revision }] : [];
    }
    if (query.includes('insert into runtime_state_store') && query.includes('do update set')) {
        const repository = requireTransactionRuntime(runtime);
        const namespace = decodeStringParameter(values[0], 'Runtime-state namespace');
        const key = decodeStringParameter(values[1], 'Runtime-state key');
        const value = decodeStringParameter(values[2], 'Runtime-state value');
        const expireAtEpochMs = toInstant(values[3]).epochMilliseconds;
        await repository.upsert(namespace, key, value, expireAtEpochMs);
        return [];
    }
    return undefined;
}

async function executeRuntimeStateSelectionSql({
    query,
    runtime,
    values
}: AppInboxTestSqlExecution): Promise<PSqlRows | undefined> {
    if (!query.includes('jsonb_array_elements') || !query.includes('as selections')) {
        return undefined;
    }
    const repository = requireTransactionRuntime(runtime);
    const selectors = decodeRuntimeStateSqlSelectors(values[0]);
    const selections = [];
    for (const selector of selectors) {
        const entries = selector.kind === 'key'
            ? await repository.findEntriesByKeys(
                selector.namespace,
                selector.key === null ? [] : [selector.key]
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
    input: AppInboxTestSqlExecution
): Promise<PSqlRows | undefined> {
    if (input.query.includes('insert into client_state_events')) {
        const event = decodeClientStateEvent(input.values);
        input.pending.clientEvents.push(event);
        return [{ event_id: event.eventId }];
    }
    if (input.query.includes('insert into group_state_events')) {
        const event = decodeGroupStateEvent(input.values);
        input.pending.groupEvents.push(event);
        return [{ event_id: event.eventId }];
    }
    if (!input.query.includes('from group_state_events')) {
        return undefined;
    }
    const applicationId = decodeStringParameter(input.values[0], 'Group event application ID');
    const workspaceKey = decodeStringParameter(input.values[1], 'Group event workspace key');
    const groupId = decodeStringParameter(input.values[2], 'Group event group ID');
    const workspaceId = workspaceKey === '_' ? undefined : workspaceKey;
    return [...input.state.groupEventStore.events, ...input.pending.groupEvents]
        .filter(
            (event) =>
                event.applicationId === applicationId &&
                event.workspaceId === workspaceId &&
                event.groupId === groupId
        )
        .map((event) => ({
            event_id: event.eventId,
            event_type: event.eventType,
            snapshot_version: event.snapshotVersion,
            occurred_at_epoch_ms: event.occurredAtEpochMs,
            event_json: JSON.stringify(event)
        }));
}

function decodeClientStateEvent(values: readonly PSqlParameter[]): ClientEvent {
    const event = decodeStateEventValue(values, 'Client');
    validateAuthoritativeClientEvent(event);
    return event;
}

function decodeGroupStateEvent(values: readonly PSqlParameter[]): GroupEvent {
    const event = decodeStateEventValue(values, 'Group');
    validateAuthoritativeGroupEvent(event);
    return event;
}

function decodeStateEventValue(
    values: readonly PSqlParameter[],
    family: 'Client' | 'Group'
): JsonWireValue {
    const eventJson = values.at(-1);
    if (typeof eventJson !== 'string') {
        throw new Error(`${family} state event JSON is required`);
    }
    return decodeJsonWireValue(JSON.parse(eventJson), `${family} state event`);
}

async function executeResultAndReservationSql(
    input: AppInboxTestSqlExecution
): Promise<PSqlRows | undefined> {
    if (input.query.includes('insert into resource_inbox_results')) {
        await input.options.onStage?.('resource-result-replace');
        const entry = toResultEntry(input.values);
        input.pending.results.push(entry);
        return [toResultRow(entry)];
    }
    if (
        !input.query.includes('update resource_inbox') ||
        !input.query.includes('ri_status = \'reserved\'')
    ) {
        return undefined;
    }
    await input.options.onStage?.('reservation-finish');
    const status = decodeEntityStatus(input.values[0], 'Reservation status');
    const completedAt = decodeDateParameter(input.values[1], 'Reservation completion');
    const topicId = decodeStringParameter(input.values[2], 'Reservation topic ID');
    const resourceId = decodeStringParameter(input.values[3], 'Reservation resource ID');
    const contextId = decodeStringParameter(input.values[4], 'Reservation context ID');
    const attempts = decodeNonNegativeIntegerParameter(input.values[5], 'Reservation attempts');
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
            nextTs: undefined
        }
    };
    input.pending.inbox.push(entry);
    return [toInboxRow(entry)];
}

function executeOutboxSql(input: AppInboxTestSqlExecution): PSqlRows | undefined {
    const insertsOutbox = input.query.includes('insert into resource_inbox');
    if (insertsOutbox) {
        const entry = toInboxEntry(input.values);
        if (input.options.shouldFailOutboxWrite?.()) {
            throw new ResourceInboxInvariantCorruptionError(
                entry.key,
                'Injected AppInbox outbox collision'
            );
        }
        const key = toResourceKey(entry);
        if (input.pending.outbox.has(key)) {
            if (input.query.includes('on conflict') && input.query.includes('do nothing')) {
                return [];
            }
            throw new ResourceInboxInvariantCorruptionError(
                entry.key,
                'AppInbox outbox identity already exists'
            );
        }
        input.pending.outbox.set(key, entry);
        return [toInboxRow(entry)];
    }
    if (input.query.includes('from resource_inbox') && input.query.includes('where ri_topic_id')) {
        const matchQuery = input.query.includes('immutable_matches');
        const keyOffset = matchQuery ? 5 : 0;
        const topicId = decodeStringParameter(input.values[keyOffset], 'Outbox topic ID');
        const resourceId = decodeStringParameter(input.values[keyOffset + 1], 'Outbox resource ID');
        const contextId = decodeStringParameter(input.values[keyOffset + 2], 'Outbox context ID');
        const entry = input.pending.outbox.get(`${contextId}:${topicId}:${resourceId}`);
        if (!entry) {
            return [];
        }
        if (!matchQuery) {
            return [toInboxRow(entry)];
        }
        const immutableMatches = entry.typeId === decodeStringParameter(input.values[0], 'Outbox type ID') &&
            entry.resource === decodeStringParameter(input.values[1], 'Outbox resource') &&
            entry.audit.createdBy === decodeStringParameter(input.values[2], 'Outbox creator') &&
            entry.audit.createdTs.round({ smallestUnit: 'microsecond', roundingMode: 'halfEven' }).equals(
                toPlainDateTime(input.values[3])
            ) &&
            entry.audit.expiryTs.toZonedDateTimeISO('UTC').toPlainDateTime()
                .round({ smallestUnit: 'microsecond', roundingMode: 'halfEven' })
                .equals(toPlainDateTime(input.values[4]));
        return [{ ...toInboxRow(entry), immutable_matches: immutableMatches }];
    }
    return undefined;
}

function toInboxEntry(values: readonly PSqlParameter[]): ResourceEntry {
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
        key: {
            resourceId: decodeStringParameter(resourceId, 'Outbox resource ID'),
            topicId: decodeStringParameter(topicId, 'Outbox topic ID'),
            contextId: decodeStringParameter(contextId, 'Outbox context ID')
        },
        resource: decodeStringParameter(resource, 'Outbox resource'),
        typeId: decodeStringParameter(typeId, 'Outbox type ID'),
        status: decodeEntityStatus(status, 'Outbox status'),
        audit: {
            date: Temporal.PlainDate.from(decodeStringParameter(systemDate, 'Outbox system date'))
                .toPlainDateTime()
                .toPlainTime(),
            createdBy: decodeStringParameter(createdBy, 'Outbox creator'),
            createdTs: toPlainDateTime(createdTs),
            expiryTs: toInstant(expiryTs)
        },
        dequeueAudit: {
            startTs: startTs === null ? undefined : toInstant(startTs),
            endTs: endTs === null ? undefined : toInstant(endTs),
            nextTs: nextTs === null ? undefined : toInstant(nextTs),
            attempts: decodeNonNegativeIntegerParameter(attempts, 'Outbox attempts')
        }
    };
}

function toResultEntry(values: readonly PSqlParameter[]): ResourceEntry {
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
        expiryTs
    ] = values;
    return {
        key: {
            resourceId: decodeStringParameter(resourceId, 'Result resource ID'),
            topicId: decodeStringParameter(topicId, 'Result topic ID'),
            contextId: decodeStringParameter(contextId, 'Result context ID')
        },
        resource: decodeStringParameter(resource, 'Result resource'),
        typeId: decodeStringParameter(typeId, 'Result type ID'),
        status: decodeEntityStatus(status, 'Result status'),
        audit: {
            date: Temporal.PlainDate.from(decodeStringParameter(systemDate, 'Result system date'))
                .toPlainDateTime()
                .toPlainTime(),
            createdBy: decodeStringParameter(createdBy, 'Result creator'),
            createdTs: toPlainDateTime(createdTs),
            expiryTs: toInstant(expiryTs)
        },
        dequeueAudit: { attempts: 0 }
    };
}

function toResultRow(entry: ResourceEntry): ResourceInboxResultDatabaseRow {
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
        expire_ts: entry.audit.expiryTs.toZonedDateTimeISO('UTC').toPlainDateTime().toString()
    };
}

function toInboxRow(entry: ResourceEntry): ResourceInboxDatabaseRow {
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

function toPlainDateTime(value: PSqlParameter): Temporal.PlainDateTime {
    if (value instanceof Date && Number.isFinite(value.getTime())) {
        return Temporal.Instant.fromEpochMilliseconds(value.getTime())
            .toZonedDateTimeISO('UTC')
            .toPlainDateTime();
    }
    if (typeof value !== 'string') {
        throw new TypeError('AppInbox timestamp must be a string or Date');
    }
    return Temporal.PlainDateTime.from(value.replace(/Z$/u, ''));
}

function toInstant(value: PSqlParameter): Temporal.Instant {
    if (value instanceof Date && Number.isFinite(value.getTime())) {
        return Temporal.Instant.fromEpochMilliseconds(value.getTime());
    }
    if (typeof value !== 'string') {
        throw new TypeError('AppInbox instant must be a string or Date');
    }
    const text = value;
    return Temporal.Instant.from(text.endsWith('Z') ? text : `${text}Z`);
}

function decodeRuntimeStateSqlSelectors(
    value: PSqlParameter
): readonly RuntimeStateReadBatchSelector[] {
    const decoded = decodeJsonWireValue(
        typeof value === 'string' ? JSON.parse(value) : value,
        'Runtime-state SQL selectors'
    );
    if (!Array.isArray(decoded)) {
        throw new TypeError('Runtime-state SQL selectors must be an array');
    }
    const selectors = decoded.map((selector, index): RuntimeStateReadBatchSelector => {
        const record = decodeJsonWireObject(selector, `Runtime-state SQL selector ${index}`);
        const selectorId = decodeJsonWireString(record.selectorId, 'Runtime-state selector ID');
        const namespace = decodeJsonWireString(record.namespace, 'Runtime-state selector namespace');
        if (record.kind === 'key') {
            return {
                selectorId,
                kind: record.kind,
                namespace,
                key: decodeJsonWireString(record.key, 'Runtime-state selector key')
            };
        }
        if (record.kind === 'prefix') {
            return {
                selectorId,
                kind: record.kind,
                namespace,
                keyPrefix: decodeJsonWireString(
                    record.keyPrefix,
                    'Runtime-state selector key prefix'
                )
            };
        }
        throw new TypeError('Runtime-state SQL selector kind is invalid');
    });
    return validateRuntimeStateReadBatchSelectors(selectors);
}

function decodeJsonWireObject(value: JsonWireValue, label: string): JsonWireObject {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value as JsonWireObject;
}

function decodeJsonWireString(value: JsonWireValue | undefined, label: string): string {
    if (typeof value !== 'string') {
        throw new TypeError(`${label} must be a string`);
    }
    return value;
}

function decodeStringParameter(value: PSqlParameter, label: string): string {
    if (typeof value !== 'string') {
        throw new TypeError(`${label} must be a string`);
    }
    return value;
}

function decodeDateParameter(value: PSqlParameter, label: string): Date {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw new TypeError(`${label} must be a valid Date`);
    }
    return value;
}

function decodeEntityStatus(value: PSqlParameter, label: string): EntityStatus {
    if (
        typeof value !== 'string' ||
        !Object.values(EntityStatus).some((status) => status === value)
    ) {
        throw new TypeError(`${label} is invalid`);
    }
    return value as EntityStatus;
}

function decodeNonNegativeIntegerParameter(value: PSqlParameter, label: string): number {
    if (typeof value !== 'number' && typeof value !== 'bigint') {
        throw new TypeError(`${label} must be a non-negative safe integer`);
    }
    const numberValue = typeof value === 'bigint' ? Number(value) : value;
    if (!Number.isSafeInteger(numberValue) || numberValue < 0) {
        throw new TypeError(`${label} must be a non-negative safe integer`);
    }
    return numberValue;
}

function toResourceKey(entry: ResourceEntry): string {
    return `${entry.key.contextId}:${entry.key.topicId}:${entry.key.resourceId}`;
}
