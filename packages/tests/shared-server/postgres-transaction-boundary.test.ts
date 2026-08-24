import { Temporal } from '@js-temporal/polyfill';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { runInPSqlTransaction } from '@shared-server/postgres/run-in-p-sql-transaction.ts';
import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';

import { PSqlClientStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-repository.ts';

import { createPSqlResourceInboxRepository, type PSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';

import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';

import { AppInboxHandlerRegistry } from '@shared-server/rallar-system/app-inbox/app-inbox-handler-registry.ts';
import { AppInboxType, type AppInboxMessageContext } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-client.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';

type SqlValue = Parameters<PSqlSql>[0][number];

interface JsonRecord {
    [key: string]: JsonWireValue;
}

interface RuntimeRow {
    readonly value: string;
    readonly expireAt: Date;
    readonly revision: number;
}

interface InboxRow {
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
    ri_attempts: bigint;
}

interface ResultRow {
    readonly ris_row_id: bigint;
    readonly ris_resource_id: string;
    readonly ris_topic_id: string;
    readonly ris_resource: string;
    readonly ris_type_id: string;
    readonly ris_status: string;
    readonly fk_ext_bank_id: string;
    readonly system_date: string;
    readonly created_by: string;
    readonly created_ts: string;
    readonly expire_ts: string;
}

interface TransactionState {
    readonly runtime: Map<string, RuntimeRow>;
    readonly events: Set<string>;
    readonly inbox: Map<string, InboxRow>;
    readonly results: Map<string, ResultRow>;
}

describe('Postgres transaction write boundary', () => {
    it('binds every write repository to one database transaction', async () => {
        const database = createTransactionalDatabase();

        await runMutation(database);

        expect(database.beginCalls).toBe(1);
        expect(new Set(database.statementTransactions).size).toBe(1);
        expect(database.committed.runtime.get('transaction-test::aggregate-1')?.value).toBe(
            JSON.stringify({ state: 'accepted' })
        );
        expect(database.committed.events.has('event-1')).toBe(true);
        expect(database.committed.inbox.has(toKey(outboxEntry.key))).toBe(true);
        expect(database.committed.results.has(toKey(resultEntry.key))).toBe(true);
        expect(database.committed.inbox.get(toKey(incomingEntry.key))?.ri_status).toBe(
            EntityStatus.COMPLETED
        );
    });

    it('rolls state and outbox back when completion fails', async () => {
        const database = createTransactionalDatabase({ failCompletion: true });

        await expect(runMutation(database)).rejects.toThrow('completion-failed');

        expect(database.beginCalls).toBe(1);
        expect(database.committed.runtime.get('transaction-test::aggregate-1')).toBeUndefined();
        expect(database.committed.events.has('event-1')).toBe(false);
        expect(database.committed.inbox.get(toKey(outboxEntry.key))).toBeUndefined();
        expect(database.committed.results.get(toKey(resultEntry.key))).toBeUndefined();
        expect(database.committed.inbox.get(toKey(incomingEntry.key))?.ri_status).toBe(
            EntityStatus.RESERVED
        );
    });

    it('binds AppInbox repositories to the supplied transaction', async () => {
        const database = createTransactionalDatabase();
        Object.defineProperty(database.sql, 'appInboxTransactionRepositories', {
            value: () => {
                throw new Error('external repository factory must not run');
            }
        });
        const handlerRegistry = new AppInboxHandlerRegistry(
            {
                inboxQueueReader: new InboxQueueReader(new InMemoryQueueBox()),
                resourceInboxResultsRepository: new ResourceInboxResultsRepository(database.sql),
                database: database.sql
            },
            { serviceId: 'server-1' }
        );
        const enqueue = {
            type: AppInboxType.GROUP_CREATE,
            resourceId: incomingEntry.key.resourceId,
            contextId: incomingEntry.key.contextId,
            data: { requestId: incomingEntry.key.resourceId }
        } as const;
        const context: AppInboxMessageContext = {
            enqueue,
            message: newALUntargetedMessage(
                'server-1',
                newALRoute(
                    incomingEntry.key.topicId,
                    incomingEntry.key.contextId,
                    incomingEntry.key.resourceId
                ),
                enqueue.type,
                enqueue
            ),
            entry: incomingEntry
        };

        const result = await handlerRegistry.writeMutation(context, async (transaction) => {
            await new PSqlRuntimeStateRepository(transaction).insertIfAbsent(
                'app-inbox-transaction',
                'aggregate-1',
                JSON.stringify({ state: 'accepted' }),
                NEVER_EXPIRE_AT_TIMESTAMP
            );
            return { status: 'accepted' };
        });

        expect(result).toEqual({ status: 'accepted' });
        expect(database.beginCalls).toBe(1);
        expect(new Set(database.statementTransactions).size).toBe(1);
        expect(database.committed.inbox.get(toKey(incomingEntry.key))?.ri_status).toBe(
            EntityStatus.COMPLETED
        );
    });
});

async function runMutation(database: TransactionalDatabase): Promise<void> {
    await runInPSqlTransaction(database.sql, async (transaction) => {
        const runtime = new PSqlRuntimeStateRepository(transaction);
        const events = new PSqlClientStateEventRepository(transaction);
        const inbox = createPSqlResourceInboxRepository(transaction);
        const results = new ResourceInboxResultsRepository(transaction);

        await runtime.insertIfAbsent(
            'transaction-test',
            'aggregate-1',
            JSON.stringify({ state: 'accepted' }),
            NEVER_EXPIRE_AT_TIMESTAMP
        );
        await events.appendClientEvent(clientEvent);
        await inbox.entries.writeIfAbsentOrMatch(outboxEntry);
        await results.replace(resultEntry);
        const finished = await inbox.finalization.finishReserved(
            incomingEntry.key,
            1,
            EntityStatus.COMPLETED,
            new Date('2026-01-01T00:01:00.000Z')
        );
        if (!finished) {
            throw new Error('reservation-lost');
        }
    });
}

type TransactionalDatabase = ReturnType<typeof createTransactionalDatabase>;

function createTransactionalDatabase(options: Readonly<{ failCompletion?: boolean; }> = {}) {
    let committed = createState();
    committed.inbox.set(toKey(incomingEntry.key), toInboxRow(incomingEntry, 1n));
    let beginCalls = 0;
    const statementTransactions: PSqlSql[] = [];

    function outsideTransactionSql<T>(
        _strings: TemplateStringsArray,
        ..._values: SqlValue[]
    ): Promise<T>;
    function outsideTransactionSql(_values: readonly SqlValue[]): ReturnType<PSqlSql>;
    function outsideTransactionSql(): never {
        throw new Error('SQL must run inside the transaction');
    }

    const sql: PSqlSql = Object.assign(outsideTransactionSql, {
        begin: async <T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T> => {
            beginCalls += 1;
            const pending = cloneState(committed);
            const transaction = createTransactionSql(pending, statementTransactions, options);
            const result = await write(transaction);
            committed = pending;
            return result;
        }
    });

    return {
        sql,
        get beginCalls() {
            return beginCalls;
        },
        get committed() {
            return committed;
        },
        statementTransactions
    };
}

function createTransactionSql(
    state: TransactionState,
    observed: PSqlSql[],
    options: Readonly<{ failCompletion?: boolean; }>
): PSqlSql {
    function executeTransaction<T>(strings: TemplateStringsArray, ...values: SqlValue[]): Promise<T>;
    function executeTransaction(values: readonly SqlValue[]): ReturnType<PSqlSql>;
    function executeTransaction(
        stringsOrValues: TemplateStringsArray | readonly SqlValue[],
        ...values: SqlValue[]
    ): ReturnType<PSqlSql> {
        if (!isTemplateCall(stringsOrValues)) {
            return stringsOrValues;
        }
        observed.push(transaction);
        const query = normalizeQuery(stringsOrValues);

        if (query.includes('insert into runtime_state_store')) {
            const [namespace, key, value, expireAt] = values;
            const storageKey = `${readString(namespace, 'runtime namespace')}::${
                readString(
                    key,
                    'runtime key'
                )
            }`;
            if (state.runtime.has(storageKey)) {
                return [];
            }
            state.runtime.set(storageKey, {
                value: readString(value, 'runtime value'),
                expireAt: readDate(expireAt, 'runtime expiry'),
                revision: 0
            });
            return [{ revision: 0 }];
        }

        if (query.includes('insert into client_state_events')) {
            const eventId = readJsonStringField(values[9], 'eventId');
            state.events.add(eventId);
            return [{ event_id: eventId }];
        }

        if (query.includes('insert into resource_inbox_results')) {
            const row = toResultRow(values, 1n);
            state.results.set(toResultRowKey(row), row);
            return [{ ...row }];
        }

        if (query.includes('insert into resource_inbox') && query.includes('do nothing')) {
            const row = toInboxRowFromValues(values, 2n);
            const key = toInboxRowKey(row);
            if (state.inbox.has(key)) {
                return [];
            }
            state.inbox.set(key, row);
            return [{ ...row }];
        }

        if (query.includes('update resource_inbox') && query.includes('ri_status = \'reserved\'')) {
            if (options.failCompletion) {
                throw new Error('completion-failed');
            }
            const [status, completedAt, topicId, resourceId, contextId, attempts] = values;
            const row = state.inbox.get(
                `${readString(contextId, 'context id')}::${
                    readString(
                        topicId,
                        'topic id'
                    )
                }::${readString(resourceId, 'resource id')}`
            );
            if (
                !row ||
                row.ri_status !== EntityStatus.RESERVED ||
                row.ri_attempts !== BigInt(readNumber(attempts, 'attempt count'))
            ) {
                return [];
            }
            row.ri_status = readString(status, 'completion status');
            row.end_ts = readDate(completedAt, 'completion time').toISOString();
            row.next_ts = null;
            return [{ ri_row_id: row.ri_row_id }];
        }

        throw new Error(`Unhandled transaction SQL: ${query}`);
    }

    const transaction: PSqlSql = Object.assign(executeTransaction, {
        begin: async () => await Promise.reject(new Error('nested-transaction'))
    });
    return transaction;
}

function createState(): TransactionState {
    return {
        runtime: new Map(),
        events: new Set(),
        inbox: new Map(),
        results: new Map()
    };
}

function cloneState(state: TransactionState): TransactionState {
    return {
        runtime: new Map(state.runtime),
        events: new Set(state.events),
        inbox: new Map([...state.inbox].map(([key, row]) => [key, { ...row }])),
        results: new Map(state.results)
    };
}

function toInboxRow(entry: ResourceEntry, rowId: bigint): InboxRow {
    return toInboxRowFromValues(
        [
            entry.key.resourceId,
            entry.key.topicId,
            entry.resource,
            entry.typeId,
            entry.status,
            entry.key.contextId,
            entry.audit.createdTs.toPlainDate().toString(),
            entry.audit.createdBy,
            entry.audit.createdTs.toString(),
            entry.audit.expiryTs.toString(),
            entry.dequeueAudit.startTs?.toString() ?? null,
            entry.dequeueAudit.endTs?.toString() ?? null,
            entry.dequeueAudit.nextTs?.toString() ?? null,
            entry.dequeueAudit.attempts
        ],
        rowId
    );
}

function toInboxRowFromValues(values: readonly SqlValue[], rowId: bigint): InboxRow {
    return {
        ri_row_id: rowId,
        ri_resource_id: readString(values[0], 'inbox resource id'),
        ri_topic_id: readString(values[1], 'inbox topic id'),
        ri_resource: readString(values[2], 'inbox resource'),
        ri_type_id: readString(values[3], 'inbox type id'),
        ri_status: readString(values[4], 'inbox status'),
        fk_ext_bank_id: readString(values[5], 'inbox context id'),
        system_date: readString(values[6], 'inbox system date'),
        created_by: readString(values[7], 'inbox creator'),
        created_ts: readString(values[8], 'inbox created time').replace(/Z$/u, ''),
        expire_ts: readString(values[9], 'inbox expiry time').replace(/Z$/u, ''),
        start_ts: readNullableTimestamp(values[10], 'inbox start time'),
        end_ts: readNullableTimestamp(values[11], 'inbox end time'),
        next_ts: readNullableTimestamp(values[12], 'inbox next time'),
        ri_attempts: BigInt(readNumber(values[13], 'inbox attempts'))
    };
}

function toResultRow(values: readonly SqlValue[], rowId: bigint): ResultRow {
    return {
        ris_row_id: rowId,
        ris_resource_id: readString(values[0], 'result resource id'),
        ris_topic_id: readString(values[1], 'result topic id'),
        ris_resource: readString(values[2], 'result resource'),
        ris_type_id: readString(values[3], 'result type id'),
        ris_status: readString(values[4], 'result status'),
        fk_ext_bank_id: readString(values[5], 'result context id'),
        system_date: readString(values[6], 'result system date'),
        created_by: readString(values[7], 'result creator'),
        created_ts: readString(values[8], 'result created time').replace(/Z$/u, ''),
        expire_ts: readString(values[9], 'result expiry time').replace(/Z$/u, '')
    };
}

function toKey(key: Key): string {
    return `${key.contextId}::${key.topicId}::${key.resourceId}`;
}

function toInboxRowKey(row: InboxRow): string {
    return `${row.fk_ext_bank_id}::${row.ri_topic_id}::${row.ri_resource_id}`;
}

function toResultRowKey(row: ResultRow): string {
    return `${row.fk_ext_bank_id}::${row.ris_topic_id}::${row.ris_resource_id}`;
}

function normalizeQuery(strings: TemplateStringsArray): string {
    return strings.join(' ').replace(/\s+/gu, ' ').trim().toLowerCase();
}

function isTemplateCall(value: SqlValue): value is TemplateStringsArray {
    return Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'raw');
}

function readString(value: SqlValue, label: string): string {
    if (typeof value !== 'string') {
        throw new TypeError(`Expected ${label} to be a string`);
    }
    return value;
}

function readNumber(value: SqlValue, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`Expected ${label} to be a finite number`);
    }
    return value;
}

function readDate(value: SqlValue, label: string): Date {
    if (!(value instanceof Date)) {
        throw new TypeError(`Expected ${label} to be a Date`);
    }
    return value;
}

function readNullableTimestamp(value: SqlValue, label: string): string | null {
    return value === null ? null : readString(value, label).replace(/Z$/u, '');
}

function readJsonStringField(value: SqlValue, field: string): string {
    const source = readString(value, `${field} JSON`);
    const decoded: JsonWireValue = JSON.parse(source);
    if (!isRecord(decoded)) {
        throw new TypeError(`Expected ${field} JSON to be an object`);
    }
    return readString(decoded[field], field);
}

function isRecord(value: JsonWireValue): value is JsonRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createEntry(key: Key, typeId: string, status: EntityStatus, attempts = 0): ResourceEntry {
    return {
        key,
        resource: JSON.stringify({ key: key.resourceId }),
        typeId,
        status,
        audit: {
            date: Temporal.PlainTime.from('00:00:00'),
            createdBy: 'transaction-test',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T00:00:00'),
            expiryTs: Temporal.Instant.from('2026-01-01T00:05:00Z')
        },
        dequeueAudit: {
            attempts
        }
    };
}

const incomingEntry = createEntry(
    { topicId: 'app-command', resourceId: 'command-1', contextId: 'app-1' },
    'APP_INBOX',
    EntityStatus.RESERVED,
    1
);

const outboxEntry = createEntry(
    { topicId: 'state-changed', resourceId: 'effect-1', contextId: 'app-1' },
    'APP_OUTBOX',
    EntityStatus.NEW
);

const resultEntry = createEntry(incomingEntry.key, 'APP_INBOX_RESULT', EntityStatus.COMPLETED);

const clientEvent: ClientEvent = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    principalId: 'alice',
    eventId: 'event-1',
    eventType: 'principal-updated',
    snapshotVersion: 1,
    clientInstanceId: null,
    sessionId: null,
    occurredAtEpochMs: 1,
    actor: { kind: 'service', serviceId: 'transaction-test' },
    reason: null,
    traceId: null,
    requestId: 'command-1',
    payload: {}
};
