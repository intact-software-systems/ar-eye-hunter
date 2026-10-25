import { describe, expect, it } from 'vitest';

import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { PSqlResourceInboxEntryRepository } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { PSqlResourceInboxReservationRepository } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-reservation-repository.ts';
import {
    readResourceInboxWorkPresences,
    type ResourceInboxWorkPresenceRead
} from '@shared-server/queuebox/postgres/read-resource-inbox-work-presences.ts';
import {
    readPSqlClientStateEventPageRows,
    readRecentPSqlClientStateEventRows
} from '@shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-queries.ts';
import {
    readPSqlGroupStateEventPageRows,
    readRecentPSqlGroupStateEventRows
} from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-queries.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import {
    createResourceInboxTestStorage,
    recordResourceInboxStatements,
    seedResourceInboxRow,
    type ResourceInboxTestStorage
} from '../../queuebox/resource-inbox-test-storage.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

const NO_EXCLUDED_CONTEXTS: ReadonlySet<string> = new Set();
const RESERVATION = { maxToReserve: 10, maxAttempts: 5 };

/** Two lanes' probes: the app inbox alone, and the WS outbox with a type that has no rows. */
const WORK_PRESENCE_READS: readonly ResourceInboxWorkPresenceRead[] = [
    {
        typeIds: new Set([EnqueuedType.APP_INBOX]),
        maxAttempts: 5,
        reservationLeaseMs: 300_000,
        finalizationStaleAfterMs: 60_000,
        staleDueThresholdMs: 60_000
    },
    {
        typeIds: new Set([EnqueuedType.WS_OUTBOX, EnqueuedType.RTC_OUTBOX]),
        maxAttempts: 5,
        reservationLeaseMs: 300_000,
        finalizationStaleAfterMs: 60_000,
        staleDueThresholdMs: 60_000
    }
];

describe('Postgres list predicates', () => {
    postgresIt('bind every queuebox type and status list as one array parameter and select the rows an in-list selects', async () => {
        await withStorage(async (storage) => {
            await seedResourceInboxRow(storage.sql, { resourceId: 'new-inbox', status: EntityStatus.NEW });
            await seedResourceInboxRow(storage.sql, { resourceId: 'new-outbox', typeId: EnqueuedType.WS_OUTBOX, status: EntityStatus.NEW });
            await seedResourceInboxRow(storage.sql, { resourceId: 'new-rtc', typeId: EnqueuedType.RTC_INBOX, status: EntityStatus.NEW });
            await seedResourceInboxRow(storage.sql, {
                resourceId: 'retry-overdue',
                status: EntityStatus.RETRY,
                attempts: 1,
                startedAgoSeconds: 140,
                endedAgoSeconds: 130,
                nextInSeconds: -120
            });
            await seedResourceInboxRow(storage.sql, {
                resourceId: 'reserved-lapsed',
                typeId: EnqueuedType.WS_OUTBOX,
                status: EntityStatus.RESERVED,
                attempts: 1,
                startedAgoSeconds: 600
            });
            const rowIds = await readRowIds(storage.sql);
            const helperCalls: (readonly PSqlParameter[])[] = [];
            const sql = toHelperRecordingSql(storage.sql, helperCalls);
            const reservations = new PSqlResourceInboxReservationRepository(sql);
            const entries = new PSqlResourceInboxEntryRepository(sql, () => new Date());
            const queueTypes = new Set([EnqueuedType.APP_INBOX, EnqueuedType.WS_OUTBOX]);
            const lapsed = { typeIds: queueTypes, timeSinceStartMs: 300_000, reservationInput: RESERVATION, excludedContextIds: NO_EXCLUDED_CONTEXTS };

            expect(await readResourceInboxWorkPresences(sql, WORK_PRESENCE_READS)).toEqual([
                { newRow: true, dueRetry: true, overdueRetry: true, timedOutReservation: false, staleExhaustedReservation: false },
                { newRow: true, dueRetry: false, overdueRetry: false, timedOutReservation: true, staleExhaustedReservation: false }
            ]);
            expect(toResourceIds(
                await reservations.findOverdueRetryEntriesSkipLocked(queueTypes, Date.now() - 60_000, {
                    ...RESERVATION,
                    excludedContextIds: NO_EXCLUDED_CONTEXTS
                })
            )).toEqual(['retry-overdue']);
            expect(toResourceIds(await reservations.findTimedOutReservedEntriesSkipLocked(lapsed))).toEqual(['reserved-lapsed']);
            expect(toResourceIds(
                await reservations.findTimedOutReservedEntriesSkipLocked({
                    ...lapsed,
                    observedRowIds: [rowIds.get('reserved-lapsed')!, rowIds.get('new-outbox')!]
                })
            )).toEqual(['reserved-lapsed']);
            expect(await entries.isAnyWithStatuses(new Set([EntityStatus.COMPLETED, EntityStatus.RETRY]))).toBe(true);
            expect(await entries.isAnyWithStatuses(new Set([EntityStatus.COMPLETED, EntityStatus.FAILED]))).toBe(false);
            expect(toResourceIds(
                await reservations.findEntriesSkipLocked({
                    typeIds: queueTypes,
                    statusIds: new Set([EntityStatus.NEW, EntityStatus.RETRY]),
                    reservationInput: RESERVATION,
                    observedRowIds: [...rowIds.values()]
                })
            )).toEqual(['new-inbox', 'new-outbox', 'retry-overdue']);
            expect(toResourceIds(
                await reservations.reserveEntriesSkipLocked({
                    typeIds: queueTypes,
                    statusIds: new Set([EntityStatus.NEW]),
                    reservationInput: RESERVATION,
                    contextClaim: undefined
                })
            )).toEqual(['new-inbox', 'new-outbox']);
            expect(helperCalls).toEqual([]);
        });
    });

    postgresIt('keep the type and status index paths of an in-list for the queuebox reads', async () => {
        await withStorage(async (storage) => {
            await seedBulkResourceInboxRows(storage.sql);
            const rowIds = [...(await readRowIds(storage.sql)).values()].slice(0, 3);
            const plans: string[] = [];
            const sql = toExplainingSql(storage.sql, plans);
            const reservations = new PSqlResourceInboxReservationRepository(sql);
            const queueTypes = new Set([EnqueuedType.APP_INBOX, EnqueuedType.WS_OUTBOX]);
            const lapsed = { typeIds: queueTypes, timeSinceStartMs: 300_000, reservationInput: RESERVATION, excludedContextIds: NO_EXCLUDED_CONTEXTS };

            await expect(readResourceInboxWorkPresences(sql, WORK_PRESENCE_READS)).rejects.toThrow('returned no row');
            await reservations.findOverdueRetryEntriesSkipLocked(queueTypes, Date.now() - 60_000, {
                ...RESERVATION,
                excludedContextIds: NO_EXCLUDED_CONTEXTS
            });
            await reservations.findTimedOutReservedEntriesSkipLocked(lapsed);
            await reservations.findTimedOutReservedEntriesSkipLocked({ ...lapsed, observedRowIds: rowIds });
            await new PSqlResourceInboxEntryRepository(sql, () => new Date()).isAnyWithStatuses(new Set([EntityStatus.FAILED]));
            await reservations.reserveEntriesSkipLocked({
                typeIds: queueTypes,
                statusIds: new Set([EntityStatus.NEW]),
                reservationInput: RESERVATION,
                contextClaim: undefined
            });

            expect(plans.map(toIndexNames)).toEqual([
                ['resource_inbox_ix', 'resource_inbox_reserved_timeout_ix', 'resource_inbox_runnable_ix'],
                ['resource_inbox_runnable_ix'],
                ['resource_inbox_reserved_timeout_ix'],
                ['resource_inbox_reserved_timeout_ix'],
                ['resource_inbox_ix'],
                ['resource_inbox_ix', 'ri_pk']
            ]);
            for (const plan of plans) {
                expect(plan).not.toContain('Seq Scan on resource_inbox');
            }
        });
    });

    postgresIt('compare a one-element type or status set by scalar equality in the claim, overdue-retry and presence reads', async () => {
        await withStorage(async (storage) => {
            await seedResourceInboxRow(storage.sql, {
                resourceId: 'retry-overdue',
                status: EntityStatus.RETRY,
                attempts: 1,
                startedAgoSeconds: 140,
                endedAgoSeconds: 130,
                nextInSeconds: -120
            });
            const recorded: string[] = [];
            const sql = recordResourceInboxStatements(storage.sql, recorded);
            const reservations = new PSqlResourceInboxReservationRepository(sql);
            const inboxOnly = new Set([EnqueuedType.APP_INBOX]);

            await readResourceInboxWorkPresences(sql, WORK_PRESENCE_READS.slice(0, 1));
            const overdue = await reservations.findOverdueRetryEntriesSkipLocked(inboxOnly, Date.now() - 60_000, {
                ...RESERVATION,
                excludedContextIds: NO_EXCLUDED_CONTEXTS
            });
            await reservations.reserveEntriesSkipLocked({
                typeIds: inboxOnly,
                statusIds: new Set([EntityStatus.NEW]),
                reservationInput: RESERVATION,
                contextClaim: undefined
            });

            expect(toResourceIds(overdue)).toEqual(['retry-overdue']);
            expect(recorded).toHaveLength(3);
            for (const statement of recorded) {
                expect(statement).toMatch(/ri_type_id = \?/u);
                expect(statement).not.toMatch(/ri_(?:type_id|status) = any\(/u);
            }
        });
    });

    postgresIt('claim one type and status by an ordered scan of the claim index that stops at the batch', async () => {
        await withStorage(async (storage) => {
            await seedEligibleBacklog(storage.sql);
            const plans: PlanNode[][] = [];
            const reservations = new PSqlResourceInboxReservationRepository(toJsonExplainingSql(storage.sql, plans));

            await reservations.reserveEntriesSkipLocked({
                typeIds: new Set([EnqueuedType.WS_OUTBOX]),
                statusIds: new Set([EntityStatus.NEW]),
                reservationInput: { maxToReserve: 16, maxAttempts: 5 },
                contextClaim: undefined
            });

            const inboxScans = plans.flat().filter((node) => node['Relation Name'] === 'resource_inbox');
            expect(inboxScans).toContainEqual(expect.objectContaining({
                'Node Type': 'Index Scan',
                'Index Name': 'resource_inbox_ix',
                Alias: 'candidate'
            }));
            expect(inboxScans.map((node) => node['Node Type'])).not.toContain('Seq Scan');
            expect(inboxScans.map((node) => node['Node Type'])).not.toContain('Bitmap Heap Scan');
        });
    });

    postgresIt('bind runtime-state key and namespace lists as one array parameter and keep the primary key path', async () => {
        await withStorage(async (storage) => {
            await storage.sql`
                insert into runtime_state_store (store_namespace, store_key, store_value, updated_ts, expire_at_ts, revision)
                select 'list-' || (series % 4), 'key-' || series, '{}', now(),
                    now() + case when series % 2 = 0 then interval '1 day' else interval '-1 day' end, 1
                from generate_series(1, 4000) as series`;
            await storage.sql`analyze runtime_state_store`;
            const helperCalls: (readonly PSqlParameter[])[] = [];
            const repository = new PSqlRuntimeStateRepository(toHelperRecordingSql(storage.sql, helperCalls));
            const plans: string[] = [];

            await new PSqlRuntimeStateRepository(toExplainingSql(storage.sql, plans)).findEntriesByKeys('list-1', ['key-1', 'key-5']);
            const found = await repository.findEntriesByKeys('list-1', ['key-9', 'key-5', 'key-9', 'key-6', 'key-1']);
            const deleted = await repository.deleteAllExpired(['list-1', 'list-3']);

            expect(found.map((entry) => entry.key)).toEqual(['key-1', 'key-5', 'key-9']);
            expect(deleted).toBe(0);
            expect(
                await storage.sql<{ remaining: string; }[]>`
                select count(*)::text as remaining from runtime_state_store where expire_at_ts <= now()`
            ).toEqual([{ remaining: '2000' }]);
            expect(await repository.deleteAllExpired(['list-1'])).toBe(1000);
            expect(plans.map(toIndexNames)).toEqual([['runtime_state_store_pk']]);
            expect(helperCalls).toEqual([]);
        });
    });

    postgresIt('bind event type lists as one array parameter and select the rows an in-list selects', async () => {
        await withStorage(async (storage) => {
            const group = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room' };
            const client = { applicationId: 'app-1', workspaceId: 'workspace-1', principalId: 'alice' };
            await storage.sql`
                insert into group_state_events (application_id, workspace_key, group_id, event_id, event_type,
                    snapshot_version, occurred_at_epoch_ms, event_json)
                select 'app-1', 'workspace-1', 'room', 'event-' || series,
                    (array['joined', 'left', 'renamed'])[1 + series % 3], series, series, '{}'
                from generate_series(1, 9) as series`;
            await storage.sql`
                insert into client_state_events (application_id, workspace_key, principal_id, event_id, event_type,
                    snapshot_version, occurred_at_epoch_ms, event_json)
                select 'app-1', 'workspace-1', 'alice', 'event-' || series,
                    (array['joined', 'left', 'renamed'])[1 + series % 3], series, series, '{}'
                from generate_series(1, 9) as series`;
            const helperCalls: (readonly PSqlParameter[])[] = [];
            const sql = toHelperRecordingSql(storage.sql, helperCalls);
            const types = { eventTypes: ['left', 'renamed'] };
            const after = { ...types, after: { snapshotVersion: 4, occurredAtEpochMs: 4, eventId: 'event-4' } };

            const groupReads = [
                await readRecentPSqlGroupStateEventRows({ sql, ref: group, query: types, limit: 3 }),
                await readPSqlGroupStateEventPageRows({ sql, ref: group, query: types, limit: 3 }),
                await readPSqlGroupStateEventPageRows({ sql, ref: group, query: after, limit: 3 })
            ];
            const clientReads = [
                await readRecentPSqlClientStateEventRows({ sql, ref: client, query: types, limit: 3 }),
                await readPSqlClientStateEventPageRows({ sql, ref: client, query: types, limit: 3 }),
                await readPSqlClientStateEventPageRows({ sql, ref: client, query: after, limit: 3 })
            ];

            const expected = [['event-5', 'event-7', 'event-8'], ['event-1', 'event-2', 'event-4'], ['event-5', 'event-7', 'event-8']];
            expect(groupReads.map((rows) => rows.map((row) => row.event_id))).toEqual(expected);
            expect(clientReads.map((rows) => rows.map((row) => row.event_id))).toEqual(expected);
            expect(helperCalls).toEqual([]);
        });
    });
});

async function withStorage(verify: (storage: ResourceInboxTestStorage) => Promise<void>): Promise<void> {
    const storage = await createResourceInboxTestStorage('list_predicates');
    try {
        await verify(storage);
    }
    finally {
        await storage.close();
    }
}

async function readRowIds(sql: PSqlSql): Promise<ReadonlyMap<string, string>> {
    const rows = await sql<{ ri_resource_id: string; ri_row_id: string; }[]>`
        select ri_resource_id, ri_row_id::text as ri_row_id from resource_inbox order by ri_row_id`;
    return new Map(rows.map((row) => [row.ri_resource_id, row.ri_row_id]));
}

/** Rows of six types, mostly completed as a live queue's are, enough that a sequential scan of the table loses to its indexes. */
async function seedBulkResourceInboxRows(sql: PSqlSql): Promise<void> {
    await sql`
        insert into resource_inbox (ri_resource_id, ri_topic_id, ri_resource, ri_type_id, ri_status,
            fk_ext_bank_id, system_date, created_by, created_ts, expire_ts, ri_attempts, start_ts, next_ts)
        select 'request-' || series, 'app-inbox.test', '{}',
            (array['APP_INBOX', 'WS_OUTBOX', 'RTC_INBOX', 'WS_INBOX', 'APP_OUTBOX', 'RTC_OUTBOX'])[1 + series % 6],
            case (series / 6) % 20 when 0 then 'NEW' when 1 then 'RETRY' when 2 then 'RESERVED' else 'COMPLETED' end,
            'context-' || (series % 50), '2026-10-21', 'server-1', (now() at time zone 'UTC'),
            (now() at time zone 'UTC') + interval '1 day', 1,
            case when (series / 6) % 20 = 2 then (now() at time zone 'UTC') - interval '1 second' end,
            case when (series / 6) % 20 = 1 then (now() at time zone 'UTC') + interval '1 hour' end
        from generate_series(1, 12000) as series`;
    await sql`analyze resource_inbox`;
}

/** A WS outbox backlog of 2,500 new rows among 25,000, most of the table completed. */
async function seedEligibleBacklog(sql: PSqlSql): Promise<void> {
    await sql`
        insert into resource_inbox (ri_resource_id, ri_topic_id, ri_resource, ri_type_id, ri_status,
            fk_ext_bank_id, system_date, created_by, created_ts, expire_ts, ri_attempts, start_ts, end_ts)
        select 'request-' || series, 'app-inbox.test', '{}',
            case when series % 2 = 0 then 'WS_OUTBOX' else 'APP_INBOX' end,
            case when series % 10 = 0 then 'NEW' else 'COMPLETED' end,
            'context-' || (series % 300), '2026-10-22', 'server-1',
            (now() at time zone 'UTC') + series * interval '1 microsecond',
            (now() at time zone 'UTC') + interval '1 day', case when series % 10 = 0 then 0 else 1 end,
            case when series % 10 <> 0 then (now() at time zone 'UTC') end,
            case when series % 10 <> 0 then (now() at time zone 'UTC') end
        from generate_series(1, 25000) as series`;
    await sql`analyze resource_inbox`;
}

/** The indexes a plan reads, by name, each once. */
function toIndexNames(plan: string): readonly string[] {
    return [...new Set([...plan.matchAll(/(?:Index Scan using|Index Scan on|Index Only Scan using) (\w+)/gu)].map((match) => match[1]))].sort();
}

function toResourceIds(entries: ReadonlyMap<string, ResourceEntry>): readonly string[] {
    return [...entries.values()].map((entry) => entry.key.resourceId).sort();
}

/** Forwards every call and records each values call: a list spliced as a driver helper instead of one parameter. */
function toHelperRecordingSql(source: PSqlSql, helperCalls: (readonly PSqlParameter[])[]): PSqlSql {
    function recording<Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<Result>;
    function recording(values: readonly PSqlParameter[]): object;
    function recording<Result>(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): Promise<Result> | object {
        if (!Object.hasOwn(stringsOrValues, 'raw')) {
            helperCalls.push(stringsOrValues as readonly PSqlParameter[]);
            return source(stringsOrValues as readonly PSqlParameter[]);
        }
        return source<Result>(stringsOrValues as TemplateStringsArray, ...values);
    }
    return Object.assign(recording, { begin: source.begin.bind(source) });
}

interface PlanNode {
    readonly 'Node Type': string;
    readonly 'Relation Name'?: string;
    readonly 'Index Name'?: string;
    readonly Alias?: string;
    readonly Plans?: readonly PlanNode[];
}

/** Runs each statement under `explain (format json)` instead, keeps every node of its plan, and answers no rows. */
function toJsonExplainingSql(source: PSqlSql, explained: PlanNode[][]): PSqlSql {
    function explaining<Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<Result>;
    function explaining(values: readonly PSqlParameter[]): object;
    function explaining<Result>(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): Promise<Result> | object {
        if (!Object.hasOwn(stringsOrValues, 'raw')) {
            return source(stringsOrValues as readonly PSqlParameter[]);
        }
        const strings = stringsOrValues as TemplateStringsArray;
        const explainStrings = [`explain (format json) ${strings[0]}`, ...strings.slice(1)];
        const template = Object.assign(explainStrings, { raw: explainStrings });
        return source<{ 'QUERY PLAN': readonly { readonly Plan: PlanNode; }[]; }[]>(template, ...values).then((rows) => {
            explained.push(rows.flatMap((row) => row['QUERY PLAN'].flatMap((plan) => toPlanNodes(plan.Plan))));
            return [] as Result;
        });
    }
    return Object.assign(explaining, { begin: source.begin.bind(source) });
}

function toPlanNodes(node: PlanNode): readonly PlanNode[] {
    return [node, ...(node.Plans ?? []).flatMap(toPlanNodes)];
}

/** Runs each statement under `explain` instead, keeps the plan text, and answers no rows. */
function toExplainingSql(source: PSqlSql, explained: string[]): PSqlSql {
    function explaining<Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<Result>;
    function explaining(values: readonly PSqlParameter[]): object;
    function explaining<Result>(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): Promise<Result> | object {
        if (!Object.hasOwn(stringsOrValues, 'raw')) {
            return source(stringsOrValues as readonly PSqlParameter[]);
        }
        const strings = stringsOrValues as TemplateStringsArray;
        const explainStrings = [`explain ${strings[0]}`, ...strings.slice(1)];
        const template = Object.assign(explainStrings, { raw: explainStrings });
        return source<{ 'QUERY PLAN': string; }[]>(template, ...values).then((plan) => {
            explained.push(plan.map((row) => row['QUERY PLAN']).join('\n'));
            return [] as Result;
        });
    }
    return Object.assign(explaining, { begin: source.begin.bind(source) });
}
