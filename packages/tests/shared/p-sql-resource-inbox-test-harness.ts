import { Temporal } from '@js-temporal/polyfill';
import type { PSqlParameter, PSqlRows, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';

export interface ResourceInboxRow {
    ri_row_id: bigint;
    ri_resource_id: string;
    ri_topic_id: string;
    ri_resource: string;
    ri_type_id: string;
    ri_status: string;
    fk_ext_bank_id: string;
    system_date: string;
    created_by: string;
    created_ts: string;
    expire_ts: string;
    start_ts: string | null;
    end_ts: string | null;
    next_ts: string | null;
    ri_attempts: bigint | null;
}

export interface ResourceInboxQuery {
    readonly query: string;
    readonly values: readonly PSqlParameter[];
}

export interface ResourceInboxQueryCapture {
    readonly queries: ResourceInboxQuery[];
    readonly sql: PSqlSql;
}

export interface ResourceInboxSqlHarness {
    readonly rows: Map<string, ResourceInboxRow>;
    readonly sqlCalls: string[];
    readonly sql: PSqlSql;
}

interface ResourceInboxSqlState {
    readonly rows: Map<string, ResourceInboxRow>;
    nextRowId: bigint;
}

interface ResourceInboxQueryExecution {
    readonly query: string;
    readonly values: readonly PSqlParameter[];
    readonly state: ResourceInboxSqlState;
}

export function createResourceInboxQueryCapture(): ResourceInboxQueryCapture {
    const queries: ResourceInboxQuery[] = [];

    function sql<Result>(
        strings: TemplateStringsArray,
        ...values: readonly PSqlParameter[]
    ): Promise<Result>;
    function sql(values: readonly PSqlParameter[]): object;
    function sql<Result>(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): Promise<Result> | object {
        if (!isTemplateCall(stringsOrValues)) {
            return stringsOrValues;
        }
        queries.push({
            query: normalizeQuery(stringsOrValues),
            values
        });
        return Promise.resolve([] as Result);
    }
    sql.begin = async <Result>(work: (transaction: PSqlSql) => Promise<Result>): Promise<Result> => await work(sql);

    return { queries, sql };
}

export function createResourceInboxSqlHarness(): ResourceInboxSqlHarness {
    const state: ResourceInboxSqlState = {
        rows: new Map(),
        nextRowId: 1n
    };
    const sqlCalls: string[] = [];

    function sql<Result>(
        strings: TemplateStringsArray,
        ...values: readonly PSqlParameter[]
    ): Promise<Result>;
    function sql(values: readonly PSqlParameter[]): object;
    function sql<Result>(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): Promise<Result> | object {
        if (!isTemplateCall(stringsOrValues)) {
            return stringsOrValues;
        }
        const query = normalizeQuery(stringsOrValues);
        sqlCalls.push(query);
        const rows = executeResourceInboxQuery({ query, values, state });
        return Promise.resolve(rows as Result);
    }
    sql.begin = async <Result>(work: (transaction: PSqlSql) => Promise<Result>): Promise<Result> => await work(sql);

    return { rows: state.rows, sqlCalls, sql };
}

export function findStoredResourceInboxRow(
    rows: ReadonlyMap<string, ResourceInboxRow>,
    key: Key
): ResourceInboxRow | undefined {
    return rows.get(`${key.contextId}::${key.topicId}::${key.resourceId}`);
}

function executeResourceInboxQuery(input: ResourceInboxQueryExecution): PSqlRows {
    if (input.query.includes('insert into resource_inbox')) {
        return executeResourceInboxInsert(input);
    }
    if (input.query.includes('delete from resource_inbox')) {
        return executeResourceInboxDelete(input);
    }
    if (input.query.includes('from resource_inbox')) {
        return executeResourceInboxRead(input);
    }
    if (input.query.includes('update resource_inbox')) {
        return executeResourceInboxUpdate(input);
    }
    throw new Error(`Unhandled SQL in test harness: ${input.query}`);
}

function executeResourceInboxInsert(input: ResourceInboxQueryExecution): PSqlRows {
    const incoming = toRowFromInsert(input.values, input.state.nextRowId);
    const key = toCompositeKey(incoming);
    const existing = input.state.rows.get(key);

    if (!input.query.includes('on conflict')) {
        if (existing) {
            throw duplicateKeyError(key);
        }
        insertNewRow(input.state, key, incoming);
        return [cloneRow(incoming)];
    }

    if (input.query.includes('do nothing')) {
        if (existing) {
            return [];
        }
        insertNewRow(input.state, key, incoming);
        return [cloneRow(incoming)];
    }

    if (input.query.includes('where resource_inbox.expire_ts <= (now() at time zone \'utc\')')) {
        if (!existing) {
            insertNewRow(input.state, key, incoming);
            return [cloneRow(incoming)];
        }
        if (!isExpired(existing.expire_ts)) {
            return [];
        }
        const replacement = { ...incoming, ri_row_id: existing.ri_row_id };
        input.state.rows.set(key, replacement);
        return [cloneRow(replacement)];
    }

    if (input.query.includes('created_by = excluded.created_by')) {
        if (!existing) {
            insertNewRow(input.state, key, incoming);
            return [cloneRow(incoming)];
        }
        const replacement: ResourceInboxRow = {
            ...incoming,
            ri_row_id: existing.ri_row_id
        };
        input.state.rows.set(key, replacement);
        return [cloneRow(replacement)];
    }

    if (!existing) {
        insertNewRow(input.state, key, incoming);
        return [cloneRow(incoming)];
    }
    const updated: ResourceInboxRow = {
        ...existing,
        ri_resource: incoming.ri_resource,
        ri_type_id: incoming.ri_type_id,
        ri_status: incoming.ri_status,
        start_ts: incoming.start_ts,
        end_ts: incoming.end_ts,
        next_ts: incoming.next_ts,
        ri_attempts: incoming.ri_attempts
    };
    input.state.rows.set(key, updated);
    return [cloneRow(updated)];
}

function executeResourceInboxRead(input: ResourceInboxQueryExecution): PSqlRows {
    if (
        !input.query.includes('where ri_topic_id =') ||
        !input.query.includes('ri_resource_id =') ||
        !input.query.includes('fk_ext_bank_id =')
    ) {
        throw new Error(`Unhandled resource inbox read in test harness: ${input.query}`);
    }
    const topicId = requireStringParameter(input.values[0], 'resource inbox topic id');
    const resourceId = requireStringParameter(input.values[1], 'resource inbox resource id');
    const contextId = requireStringParameter(input.values[2], 'resource inbox context id');
    const expireAfter = input.values[3];
    const row = input.state.rows.get(`${contextId}::${topicId}::${resourceId}`);
    if (!row) {
        return [];
    }
    if (
        expireAfter instanceof Date &&
        toStoredTimestampEpochMs(row.expire_ts) <= expireAfter.getTime()
    ) {
        return [];
    }
    return [cloneRow(row)];
}

function executeResourceInboxUpdate(input: ResourceInboxQueryExecution): PSqlRows {
    if (
        input.query.includes('set ri_resource =') &&
        input.query.includes('where ri_row_id =') &&
        input.query.includes('returning *')
    ) {
        return executeObservedReplacement(input);
    }
    if (
        input.query.includes('set ri_status = , end_ts') &&
        input.query.includes('returning *')
    ) {
        return executeRetryUpdate(input);
    }
    if (
        input.query.includes('ri_status = \'reserved\'') &&
        input.query.includes('returning ri_row_id')
    ) {
        return executeCompletionUpdate(input);
    }
    if (
        input.query.includes('set ri_status =') &&
        input.query.includes('expire_ts > (now() at time zone \'utc\')')
    ) {
        return executeReservationUpdate(input);
    }
    throw new Error(`Unhandled resource inbox update in test harness: ${input.query}`);
}

function executeObservedReplacement(input: ResourceInboxQueryExecution): PSqlRows {
    const replacement = {
        resource: requireStringParameter(input.values[0], 'replacement resource'),
        typeId: requireStringParameter(input.values[1], 'replacement type id'),
        status: requireStringParameter(input.values[2], 'replacement status'),
        systemDate: requireStringParameter(input.values[3], 'replacement system date'),
        createdBy: requireStringParameter(input.values[4], 'replacement creator'),
        createdTs: toStoredResourceInboxTimestamp(input.values[5]),
        expiryTs: toStoredResourceInboxTimestamp(input.values[6]),
        startTs: toOptionalString(input.values[7]),
        endTs: toOptionalString(input.values[8]),
        nextTs: toOptionalString(input.values[9]),
        attempts: BigInt(requireIntegerParameter(input.values[10], 'replacement attempts'))
    };
    const expectedRowId = requireBigIntParameter(input.values[11], 'observed row id');
    const topicId = requireStringParameter(input.values[12], 'observed topic id');
    const resourceId = requireStringParameter(input.values[13], 'observed resource id');
    const contextId = requireStringParameter(input.values[14], 'observed context id');
    const row = input.state.rows.get(`${contextId}::${topicId}::${resourceId}`);
    if (
        !row ||
        isExpired(row.expire_ts) ||
        row.ri_row_id !== expectedRowId ||
        row.ri_type_id !== input.values[15] ||
        row.ri_resource !== input.values[16] ||
        row.ri_status !== input.values[17] ||
        row.system_date !== input.values[18] ||
        row.created_by !== input.values[19] ||
        row.created_ts !== toStoredResourceInboxTimestamp(input.values[20]) ||
        row.expire_ts !== toStoredResourceInboxTimestamp(input.values[21]) ||
        row.start_ts !== toOptionalString(input.values[22]) ||
        row.end_ts !== toOptionalString(input.values[23]) ||
        row.next_ts !== toOptionalString(input.values[24]) ||
        row.ri_attempts !== BigInt(requireIntegerParameter(input.values[25], 'observed attempts'))
    ) {
        return [];
    }

    const updated: ResourceInboxRow = {
        ...row,
        ri_resource: replacement.resource,
        ri_type_id: replacement.typeId,
        ri_status: replacement.status,
        system_date: replacement.systemDate,
        created_by: replacement.createdBy,
        created_ts: replacement.createdTs,
        expire_ts: replacement.expiryTs,
        start_ts: replacement.startTs,
        end_ts: replacement.endTs,
        next_ts: replacement.nextTs,
        ri_attempts: replacement.attempts
    };
    input.state.rows.set(toCompositeKey(updated), updated);
    return [cloneRow(updated)];
}

function executeRetryUpdate(input: ResourceInboxQueryExecution): PSqlRows {
    const status = requireStringParameter(input.values[0], 'resource inbox retry status');
    const endTs = input.values[1];
    const nextTs = input.values[2];
    const topicId = requireStringParameter(input.values[3], 'resource inbox topic id');
    const resourceId = requireStringParameter(input.values[4], 'resource inbox resource id');
    const contextId = requireStringParameter(input.values[5], 'resource inbox context id');
    const reserved = requireStringParameter(input.values[6], 'resource inbox reserved status');
    const expectedAttempts = requireIntegerParameter(input.values[7], 'resource inbox attempts');
    const row = input.state.rows.get(`${contextId}::${topicId}::${resourceId}`);
    if (
        !row ||
        row.ri_status !== reserved ||
        row.ri_attempts !== BigInt(expectedAttempts) ||
        isExpired(row.expire_ts)
    ) {
        return [];
    }
    row.ri_status = status;
    row.end_ts = toOptionalString(endTs);
    row.next_ts = toOptionalString(nextTs);
    return [cloneRow(row)];
}

function executeCompletionUpdate(input: ResourceInboxQueryExecution): PSqlRows {
    const status = requireStringParameter(input.values[0], 'resource inbox completion status');
    const completedAt = input.values[1];
    const topicId = requireStringParameter(input.values[2], 'resource inbox topic id');
    const resourceId = requireStringParameter(input.values[3], 'resource inbox resource id');
    const contextId = requireStringParameter(input.values[4], 'resource inbox context id');
    const expectedAttempts = requireIntegerParameter(input.values[5], 'resource inbox attempts');
    const row = input.state.rows.get(`${contextId}::${topicId}::${resourceId}`);
    if (
        !row ||
        row.ri_status !== 'RESERVED' ||
        row.ri_attempts !== BigInt(expectedAttempts) ||
        isExpired(row.expire_ts)
    ) {
        return [];
    }
    row.ri_status = status;
    row.end_ts = toOptionalString(completedAt);
    row.next_ts = null;
    return [{ ri_row_id: row.ri_row_id }];
}

function executeReservationUpdate(input: ResourceInboxQueryExecution): PSqlRows {
    const usesDatabaseStart = input.query.includes('start_ts = now()');
    const status = requireStringParameter(input.values[0], 'resource inbox reservation status');
    const attempts = requireIntegerParameter(input.values[1], 'resource inbox attempts');
    const remaining = input.values.slice(2);
    const [startTs, endTs, nextTs, topicValue, resourceValue, contextValue] = usesDatabaseStart
        ? [new Date(), ...remaining]
        : remaining;
    const topicId = requireStringParameter(topicValue, 'resource inbox topic id');
    const resourceId = requireStringParameter(resourceValue, 'resource inbox resource id');
    const contextId = requireStringParameter(contextValue, 'resource inbox context id');
    const key = `${contextId}::${topicId}::${resourceId}`;
    const row = input.state.rows.get(key);
    if (!row || isExpired(row.expire_ts)) {
        return [];
    }
    const updated: ResourceInboxRow = {
        ...row,
        ri_status: status,
        ri_attempts: BigInt(attempts),
        start_ts: toOptionalString(startTs),
        end_ts: toOptionalString(endTs),
        next_ts: toOptionalString(nextTs)
    };
    input.state.rows.set(key, updated);
    return [cloneRow(updated)];
}

function executeResourceInboxDelete(input: ResourceInboxQueryExecution): PSqlRows {
    if (!input.query.includes('where expire_ts <= (now() at time zone \'utc\')')) {
        throw new Error(`Unhandled resource inbox delete in test harness: ${input.query}`);
    }
    const deleted: Array<{ ri_row_id: bigint; }> = [];
    for (const [key, row] of input.state.rows.entries()) {
        if (!isExpired(row.expire_ts)) {
            continue;
        }
        input.state.rows.delete(key);
        deleted.push({ ri_row_id: row.ri_row_id });
    }
    return deleted;
}

function insertNewRow(
    state: ResourceInboxSqlState,
    key: string,
    row: ResourceInboxRow
): void {
    state.rows.set(key, row);
    state.nextRowId += 1n;
}

function isTemplateCall(
    value: TemplateStringsArray | readonly PSqlParameter[]
): value is TemplateStringsArray {
    return 'raw' in value;
}

function normalizeQuery(strings: TemplateStringsArray): string {
    return strings.join(' ').replace(/\s+/gu, ' ').trim().toLowerCase();
}

function toRowFromInsert(
    values: readonly PSqlParameter[],
    rowId: bigint
): ResourceInboxRow {
    return {
        ri_row_id: rowId,
        ri_resource_id: requireStringParameter(values[0], 'resource inbox resource id'),
        ri_topic_id: requireStringParameter(values[1], 'resource inbox topic id'),
        ri_resource: requireStringParameter(values[2], 'resource inbox resource'),
        ri_type_id: requireStringParameter(values[3], 'resource inbox type id'),
        ri_status: requireStringParameter(values[4], 'resource inbox status'),
        fk_ext_bank_id: requireStringParameter(values[5], 'resource inbox context id'),
        system_date: requireStringParameter(values[6], 'resource inbox system date'),
        created_by: requireStringParameter(values[7], 'resource inbox creator'),
        created_ts: toStoredResourceInboxTimestamp(values[8]),
        expire_ts: toStoredResourceInboxTimestamp(values[9]),
        start_ts: toOptionalString(values[10]),
        end_ts: toOptionalString(values[11]),
        next_ts: toOptionalString(values[12]),
        ri_attempts: BigInt(requireOptionalIntegerParameter(values[13], 'resource inbox attempts'))
    };
}

function toCompositeKey(
    row: Pick<ResourceInboxRow, 'fk_ext_bank_id' | 'ri_topic_id' | 'ri_resource_id'>
): string {
    return `${row.fk_ext_bank_id}::${row.ri_topic_id}::${row.ri_resource_id}`;
}

function cloneRow(row: ResourceInboxRow): ResourceInboxRow {
    return { ...row };
}

function duplicateKeyError(key: string): Error & { code: string; } {
    const error = new Error(
        `duplicate key value violates unique constraint resource_inbox_unique_k: ${key}`
    ) as Error & { code: string; };
    error.code = '23505';
    return error;
}

function isExpired(expireTs: string): boolean {
    return toStoredTimestampEpochMs(expireTs) <= Date.now();
}

function toOptionalString(value: PSqlParameter): string | null {
    if (value === null || value === undefined) {
        return null;
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    return requireStringParameter(value, 'resource inbox timestamp');
}

export function toStoredResourceInboxTimestamp(value: PSqlParameter): string {
    const text = value instanceof Date
        ? value.toISOString()
        : value instanceof Temporal.Instant || value instanceof Temporal.PlainDateTime
        ? value.toString()
        : requireStringParameter(value, 'resource inbox timestamp');
    const withoutZone = text.replace('T', ' ').replace(/[zZ]$/u, '');
    const [whole, fraction = ''] = withoutZone.split('.');
    return `${whole}.${fraction.padEnd(6, '0').slice(0, 6)}`;
}

function toStoredTimestampEpochMs(value: string): number {
    return Date.parse(`${value.replace(' ', 'T')}Z`);
}

function requireStringParameter(value: PSqlParameter, label: string): string {
    if (typeof value !== 'string') {
        throw new TypeError(`${label} must be a string`);
    }
    return value;
}

function requireIntegerParameter(value: PSqlParameter, label: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${label} must be a non-negative safe integer`);
    }
    return value;
}

function requireBigIntParameter(value: PSqlParameter, label: string): bigint {
    if (typeof value !== 'bigint' || value < 1n) {
        throw new TypeError(`${label} must be a positive bigint`);
    }
    return value;
}

function requireOptionalIntegerParameter(value: PSqlParameter, label: string): number {
    return value === undefined ? 0 : requireIntegerParameter(value, label);
}
