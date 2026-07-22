import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import type { ClientEvent } from '@shared/api/client-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import {
    EntityStatus,
    type Key,
    type ResourceEntry,
} from '@shared/queuebox/ResourceEntry.ts';
import type {
    PSqlSql,
    PSqlTransactionSql,
} from '@shared-server/postgres/PostgresSqlClient.ts';
import { runInTransaction } from '@shared-server/postgres/run-in-transaction.ts';
import { PSqlClientStateEventRepository } from '@shared-server/postgres/rallar-system/PSqlStateEventRepository.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import {
    AppInboxService,
    AppInboxType,
    type AppInboxMessageContext,
} from '@shared-server/rallar-system/services/AppInboxService.ts';

type RuntimeRow = Readonly<{
    value: string;
    expireAt: Date;
    revision: number;
}>;

type InboxRow = {
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
};

type ResultRow = Readonly<{
    ris_row_id: bigint;
    ris_resource_id: string;
    ris_topic_id: string;
    ris_resource: string;
    ris_type_id: string;
    ris_status: string;
    fk_ext_bank_id: string;
    system_date: string;
    created_by: string;
    created_ts: string;
    expire_ts: string;
}>;

type TransactionState = {
    runtime: Map<string, RuntimeRow>;
    events: Map<string, ClientEvent>;
    inbox: Map<string, InboxRow>;
    results: Map<string, ResultRow>;
};

describe('Postgres transaction write boundary', () => {
    it('binds every write repository to one database transaction', async () => {
        const database = createTransactionalDatabase();

        await runMutation(database);

        expect(database.beginCalls).toBe(1);
        expect(new Set(database.statementTransactions).size).toBe(1);
        expect(database.committed.runtime.get('transaction-test::aggregate-1')?.value)
            .toBe(JSON.stringify({ state: 'accepted' }));
        expect(database.committed.events.has('event-1')).toBe(true);
        expect(database.committed.inbox.has(toKey(outboxEntry.key))).toBe(true);
        expect(database.committed.results.has(toKey(resultEntry.key))).toBe(true);
        expect(database.committed.inbox.get(toKey(incomingEntry.key))?.ri_status)
            .toBe(EntityStatus.COMPLETED);
    });

    it('rolls state and outbox back when completion fails', async () => {
        const database = createTransactionalDatabase({ failCompletion: true });

        await expect(runMutation(database)).rejects.toThrow('completion-failed');

        expect(database.beginCalls).toBe(1);
        expect(database.committed.runtime.get('transaction-test::aggregate-1'))
            .toBeUndefined();
        expect(database.committed.events.get('event-1')).toBeUndefined();
        expect(database.committed.inbox.get(toKey(outboxEntry.key))).toBeUndefined();
        expect(database.committed.results.get(toKey(resultEntry.key))).toBeUndefined();
        expect(database.committed.inbox.get(toKey(incomingEntry.key))?.ri_status)
            .toBe(EntityStatus.RESERVED);
    });

    it('binds AppInbox repositories to the supplied transaction and ignores external factories', async () => {
        const database = createTransactionalDatabase();
        Object.defineProperty(database.sql, 'appInboxTransactionRepositories', {
            value: () => {
                throw new Error('external repository factory must not run');
            },
        });
        const service = new StrictTransactionAppInboxService(
            new InboxQueueReader(new InMemoryQueueBox()),
            new ResourceInboxRepository(database.sql),
            new ResourceInboxResultsRepository(database.sql),
            database.sql,
            'server-1',
        );
        const context: AppInboxMessageContext = {
            enqueue: {
                type: AppInboxType.GROUP_CREATE,
                resourceId: incomingEntry.key.resourceId,
                contextId: incomingEntry.key.contextId,
                data: { requestId: incomingEntry.key.resourceId },
            },
            message: {} as never,
            entry: incomingEntry,
        };

        const result = await service.commit(context, async (transaction) => {
            await new PSqlRuntimeStateRepository(transaction).insertIfAbsent(
                'app-inbox-transaction',
                'aggregate-1',
                JSON.stringify({ state: 'accepted' }),
                NEVER_EXPIRE_AT_TIMESTAMP,
            );
            return { status: 'accepted' };
        });

        expect(result).toEqual({ status: 'accepted' });
        expect(database.beginCalls).toBe(1);
        expect(new Set(database.statementTransactions).size).toBe(1);
        expect(database.committed.inbox.get(toKey(incomingEntry.key))?.ri_status)
            .toBe(EntityStatus.COMPLETED);
    });
});

class StrictTransactionAppInboxService extends AppInboxService {
    async commit<R>(
        context: AppInboxMessageContext,
        write: (transaction: PSqlTransactionSql) => Promise<R>,
    ): Promise<R> {
        return await this.writeMutation(context, write);
    }
}

async function runMutation(database: TransactionalDatabase): Promise<void> {
    await runInTransaction(database.sql, async (transaction) => {
        const runtime = new PSqlRuntimeStateRepository(transaction);
        const events = new PSqlClientStateEventRepository(transaction);
        const inbox = new ResourceInboxRepository(transaction);
        const results = new ResourceInboxResultsRepository(transaction);

        await runtime.insertIfAbsent(
            'transaction-test',
            'aggregate-1',
            JSON.stringify({ state: 'accepted' }),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );
        await events.appendClientEvent(clientEvent);
        await inbox.writeIfAbsentOrMatch(outboxEntry);
        await results.replace(resultEntry);
        const finished = await inbox.finishReserved(
            incomingEntry.key,
            1,
            EntityStatus.COMPLETED,
            new Date('2026-01-01T00:01:00.000Z'),
        );
        if (!finished) throw new Error('reservation-lost');
    });
}

type TransactionalDatabase = ReturnType<typeof createTransactionalDatabase>;

function createTransactionalDatabase(
    options: Readonly<{ failCompletion?: boolean }> = {},
) {
    let committed = createState();
    committed.inbox.set(toKey(incomingEntry.key), toInboxRow(incomingEntry, 1n));
    let beginCalls = 0;
    const statementTransactions: PSqlTransactionSql[] = [];

    const sql = (() => {
        throw new Error('SQL must run inside the transaction');
    }) as unknown as PSqlSql;

    sql.begin = async <T>(
        write: (transaction: PSqlTransactionSql) => Promise<T>,
    ): Promise<T> => {
        beginCalls += 1;
        const pending = cloneState(committed);
        const transaction = createTransactionSql(
            pending,
            statementTransactions,
            options,
        );
        const result = await write(transaction);
        committed = pending;
        return result;
    };

    return {
        sql,
        get beginCalls() {
            return beginCalls;
        },
        get committed() {
            return committed;
        },
        statementTransactions,
    };
}

function createTransactionSql(
    state: TransactionState,
    observed: PSqlTransactionSql[],
    options: Readonly<{ failCompletion?: boolean }>,
): PSqlTransactionSql {
    const transaction = ((
        stringsOrValues: TemplateStringsArray | readonly unknown[],
        ...values: unknown[]
    ): unknown => {
        if (!isTemplateCall(stringsOrValues)) return stringsOrValues;
        observed.push(transaction);
        const query = normalizeQuery(stringsOrValues);

        if (query.includes('insert into runtime_state_store')) {
            const [namespace, key, value, expireAt] = values;
            const storageKey = `${namespace}::${key}`;
            if (state.runtime.has(storageKey)) return [];
            state.runtime.set(storageKey, {
                value: value as string,
                expireAt: expireAt as Date,
                revision: 0,
            });
            return [{ revision: 0 }];
        }

        if (query.includes('insert into client_state_events')) {
            const event = JSON.parse(values[9] as string) as ClientEvent;
            state.events.set(event.eventId, event);
            return [];
        }

        if (query.includes('insert into resource_inbox_results')) {
            const row = toResultRow(values, 1n);
            state.results.set(toResultRowKey(row), row);
            return [{ ...row }];
        }

        if (
            query.includes('insert into resource_inbox') &&
            query.includes('do nothing')
        ) {
            const row = toInboxRowFromValues(values, 2n);
            const key = toInboxRowKey(row);
            if (state.inbox.has(key)) return [];
            state.inbox.set(key, row);
            return [{ ...row }];
        }

        if (
            query.includes('update resource_inbox') &&
            query.includes("ri_status = 'reserved'")
        ) {
            if (options.failCompletion) throw new Error('completion-failed');
            const [status, completedAt, topicId, resourceId, contextId, attempts] =
                values;
            const row = state.inbox.get(`${contextId}::${topicId}::${resourceId}`);
            if (
                !row ||
                row.ri_status !== EntityStatus.RESERVED ||
                row.ri_attempts !== BigInt(attempts as number)
            ) return [];
            row.ri_status = status as string;
            row.end_ts = (completedAt as Date).toISOString();
            row.next_ts = null;
            return [{ ri_row_id: row.ri_row_id }];
        }

        throw new Error(`Unhandled transaction SQL: ${query}`);
    }) as PSqlTransactionSql;

    transaction.begin = async () => {
        throw new Error('nested-transaction');
    };
    return transaction;
}

function createState(): TransactionState {
    return {
        runtime: new Map(),
        events: new Map(),
        inbox: new Map(),
        results: new Map(),
    };
}

function cloneState(state: TransactionState): TransactionState {
    return {
        runtime: new Map(state.runtime),
        events: new Map(state.events),
        inbox: new Map(
            [...state.inbox].map(([key, row]) => [key, { ...row }]),
        ),
        results: new Map(state.results),
    };
}

function toInboxRow(entry: ResourceEntry, rowId: bigint): InboxRow {
    return toInboxRowFromValues([
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
        entry.dequeueAudit.attempts,
    ], rowId);
}

function toInboxRowFromValues(values: readonly unknown[], rowId: bigint): InboxRow {
    return {
        ri_row_id: rowId,
        ri_resource_id: values[0] as string,
        ri_topic_id: values[1] as string,
        ri_resource: values[2] as string,
        ri_type_id: values[3] as string,
        ri_status: values[4] as string,
        fk_ext_bank_id: values[5] as string,
        system_date: values[6] as string,
        created_by: values[7] as string,
        created_ts: values[8] as string,
        expire_ts: values[9] as string,
        start_ts: values[10] as string | null,
        end_ts: values[11] as string | null,
        next_ts: values[12] as string | null,
        ri_attempts: BigInt(values[13] as number),
    };
}

function toResultRow(values: readonly unknown[], rowId: bigint): ResultRow {
    return {
        ris_row_id: rowId,
        ris_resource_id: values[0] as string,
        ris_topic_id: values[1] as string,
        ris_resource: values[2] as string,
        ris_type_id: values[3] as string,
        ris_status: values[4] as string,
        fk_ext_bank_id: values[5] as string,
        system_date: values[6] as string,
        created_by: values[7] as string,
        created_ts: values[8] as string,
        expire_ts: values[9] as string,
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

function isTemplateCall(value: unknown): value is TemplateStringsArray {
    return Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'raw');
}

function createEntry(
    key: Key,
    typeId: string,
    status: EntityStatus,
    attempts = 0,
): ResourceEntry {
    return {
        key,
        resource: JSON.stringify({ key: key.resourceId }),
        typeId,
        status,
        audit: {
            date: Temporal.PlainTime.from('00:00:00'),
            createdBy: 'transaction-test',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T00:00:00'),
            expiryTs: Temporal.Instant.from('2026-01-01T00:05:00Z'),
        },
        dequeueAudit: {
            attempts,
        },
    };
}

const incomingEntry = createEntry(
    { topicId: 'app-command', resourceId: 'command-1', contextId: 'app-1' },
    'APP_INBOX',
    EntityStatus.RESERVED,
    1,
);

const outboxEntry = createEntry(
    { topicId: 'state-changed', resourceId: 'effect-1', contextId: 'app-1' },
    'APP_OUTBOX',
    EntityStatus.NEW,
);

const resultEntry = createEntry(
    incomingEntry.key,
    'APP_INBOX_RESULT',
    EntityStatus.COMPLETED,
);

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
    payload: {},
};
