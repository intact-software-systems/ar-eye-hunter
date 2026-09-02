import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import {
    writeResourceInboxReservationFinish,
    type ResourceInboxReservationFinish
} from '../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import { ResourceInboxResultsRepository } from '../../../queuebox/postgres/resource-inbox-results-repository.ts';
import {
    writeAppOutboxInsert,
    type AppOutboxInsert
} from '../../app-outbox/app-outbox-insert.ts';
import type { AdminPruneAggregateWrite } from '../inbox/compute-admin-prune-mutation.ts';
import type {
    AdminPruneCandidatePage,
    AdminPrunePageComputed,
    AdminPrunePageDelete,
    AdminPrunePageRepository,
    AdminPruneProgressWrite
} from '../prune/admin-prune-page-worker.ts';
import { decodeAdminPruneAggregate, toAdminPruneAggregateKey } from '../prune/admin-prune-progress.ts';

type RuntimeRow = Readonly<{ store_namespace: string; store_key: string; }>;
type ResourceRow = Readonly<{ ri_row_id: number | string; }>;
type ResultsRow = Readonly<{ ris_row_id: number | string; }>;
type AppDataRow = Readonly<{ store_name: string; data_key: string; }>;

export class PSqlAdminPruneRepository implements AdminPrunePageRepository {
    private readonly sql: PSqlSql;

    constructor(sql: PSqlSql) {
        this.sql = sql;
    }

    async readPage(input: Parameters<AdminPrunePageRepository['readPage']>[0]): Promise<AdminPruneCandidatePage> {
        switch (input.category) {
            case 'runtime-state':
                return await readRuntimePage(this.sql, input);
            case 'resource-inbox':
                return await readResourcePage(this.sql, input);
            case 'resource-inbox-results':
                return await readResultsPage(this.sql, input);
            case 'app-data':
                return await readAppDataPage(this.sql, input);
        }
    }

    async deletePage(
        transaction: PSqlSql,
        deletion: AdminPrunePageDelete
    ): Promise<number> {
        return await deleteAdminPrunePage(transaction, deletion);
    }

    async readAggregate(jobId: string) {
        const key = toAdminPruneAggregateKey(jobId);
        const current = await new ResourceInboxResultsRepository(this.sql).findAnyByKey(key);
        if (!current) {
            throw new Error('Admin prune aggregate was not found');
        }
        const storedAggregate = JSON.parse(current.resource);
        const aggregate = decodeAdminPruneAggregate(storedAggregate);
        if (aggregate.jobId !== jobId) {
            throw new TypeError('Admin prune aggregate identity is corrupt');
        }
        return { aggregate, resource: current.resource };
    }

    async writeOutbox(transaction: PSqlSql, computed: AppOutboxInsert): Promise<void> {
        await writeAppOutboxInsert(transaction, computed);
    }

    async writeProgress(
        transaction: PSqlSql,
        computed: AdminPruneProgressWrite
    ): Promise<void> {
        await writeAdminPruneProgress(transaction, computed);
    }

    async finishReserved(
        transaction: PSqlSql,
        completion: ResourceInboxReservationFinish
    ): Promise<boolean> {
        return await writeResourceInboxReservationFinish(transaction, completion);
    }
}

export async function writeAdminPrunePage(
    transaction: PSqlSql,
    computed: AdminPrunePageComputed
): Promise<void> {
    await writeAdminPruneProgress(transaction, computed);
    const deleted = await deleteAdminPrunePage(transaction, computed.deletion);
    if (deleted !== computed.deletedRows) {
        throw computed.pageChangedError;
    }
    if (computed.successorOutboxWrite) {
        await writeAppOutboxInsert(transaction, computed.successorOutboxWrite);
    }
    if (!await writeResourceInboxReservationFinish(transaction, computed.reservationFinish)) {
        throw computed.reservationChangedError;
    }
}

export async function writeAdminPruneProgress(
    transaction: PSqlSql,
    computed: AdminPruneProgressWrite
): Promise<void> {
    const next = computed.aggregateSuccessor;
    const key = next.key;
    const rows = await transaction<{ ris_row_id: number | string; }[]>`
        update resource_inbox_results
        set ris_resource = ${next.resource}, ris_status = ${next.status},
            expire_ts = ${computed.aggregateSuccessorExpiryAtIsoTimestamp}
        where ris_topic_id = ${key.topicId}
          and ris_resource_id = ${key.resourceId}
          and fk_ext_bank_id = ${key.contextId}
          and ris_resource = ${computed.expectedAggregate}
        returning ris_row_id
    `;
    if (rows.length !== 1) {
        throw computed.progressConflictError;
    }
}

export async function deleteAdminPrunePage(
    transaction: PSqlSql,
    deletion: AdminPrunePageDelete
): Promise<number> {
    if (deletion.rowIds.length === 0) {
        return 0;
    }
    return await deletePageRows(transaction, deletion);
}

export async function writeAdminPruneAggregate(
    transaction: PSqlSql,
    computed: AdminPruneAggregateWrite
): Promise<void> {
    const rows = await transaction<readonly { ris_resource: string; }[]>`
        insert into resource_inbox_results (ris_resource_id,
                                            ris_topic_id,
                                            ris_resource,
                                            ris_type_id,
                                            ris_status,
                                            fk_ext_bank_id,
                                            system_date,
                                            created_by,
                                            created_ts,
                                            expire_ts)
        values (${computed.resourceId},
                ${computed.topicId},
                ${computed.resource},
                ${computed.typeId},
                ${computed.status},
                ${computed.contextId},
                ${computed.systemDate},
                ${computed.createdBy},
                ${computed.createdAt},
                ${computed.expiresAt})
        on conflict (fk_ext_bank_id, ris_resource_id, ris_topic_id)
            do update set ris_resource = excluded.ris_resource,
                          ris_type_id  = excluded.ris_type_id,
                          ris_status   = excluded.ris_status,
                          system_date  = excluded.system_date,
                          created_by   = excluded.created_by,
                          created_ts   = excluded.created_ts,
                          expire_ts    = excluded.expire_ts
        where resource_inbox_results.expire_ts <= (now() at time zone 'UTC')
        returning ris_resource
    `;
    if (rows.length > 1) {
        throw new Error('Admin prune aggregate write returned multiple rows');
    }
    const stored = rows[0] ?? (await transaction<readonly { ris_resource: string; }[]>`
        select ris_resource
        from resource_inbox_results
        where ris_topic_id = ${computed.topicId}
          and ris_resource_id = ${computed.resourceId}
          and fk_ext_bank_id = ${computed.contextId}
        limit 1
    `)[0];
    if (!stored) {
        throw new Error('Admin prune aggregate conflict row was not found');
    }
    if (stored.ris_resource !== computed.resource) {
        throw new Error('Admin prune aggregate collides with an active job');
    }
}

async function readRuntimePage(
    sql: PSqlSql,
    input: Parameters<AdminPrunePageRepository['readPage']>[0]
): Promise<AdminPruneCandidatePage> {
    const [namespace, key] = decodeTuple(input.afterCursor, 2);
    const rows = await sql<RuntimeRow[]>`
        select store_namespace, store_key
        from runtime_state_store
        where expire_at_ts <= ${new Date(input.expireAtEpochMs)}
          and (${input.afterCursor === null} or (store_namespace, store_key) > (${namespace}, ${key}))
        order by store_namespace, store_key
        limit ${input.pageSize + 1}
    `;
    return page(rows.map((row) => JSON.stringify([row.store_namespace, row.store_key])), input.pageSize);
}

async function readResourcePage(
    sql: PSqlSql,
    input: Parameters<AdminPrunePageRepository['readPage']>[0]
): Promise<AdminPruneCandidatePage> {
    const after = input.afterCursor === null ? 0 : requireInteger(input.afterCursor);
    const excluded = input.excludedResourceKey;
    const rows = await sql<ResourceRow[]>`
        select ri_row_id
        from resource_inbox
        where expire_ts <= ${new Date(input.expireAtEpochMs)}
          and ri_row_id > ${after}
          and (${excluded === null} or not (
            ri_resource_id = ${excluded?.resourceId ?? ''}
            and ri_topic_id = ${excluded?.topicId ?? ''}
            and fk_ext_bank_id = ${excluded?.contextId ?? ''}
          ))
        order by ri_row_id
        limit ${input.pageSize + 1}
    `;
    return page(rows.map((row) => String(row.ri_row_id)), input.pageSize);
}

async function readResultsPage(
    sql: PSqlSql,
    input: Parameters<AdminPrunePageRepository['readPage']>[0]
): Promise<AdminPruneCandidatePage> {
    const after = input.afterCursor === null ? 0 : requireInteger(input.afterCursor);
    const rows = await sql<ResultsRow[]>`
        select ris_row_id
        from resource_inbox_results
        where expire_ts <= ${new Date(input.expireAtEpochMs)} and ris_row_id > ${after}
        order by ris_row_id
        limit ${input.pageSize + 1}
    `;
    return page(rows.map((row) => String(row.ris_row_id)), input.pageSize);
}

async function readAppDataPage(
    sql: PSqlSql,
    input: Parameters<AdminPrunePageRepository['readPage']>[0]
): Promise<AdminPruneCandidatePage> {
    if (!input.appData) {
        throw new TypeError('App-data prune requires namespace');
    }
    const [storeName, dataKey] = decodeTuple(input.afterCursor, 2);
    const rows = input.appData.storeName === null
        ? await sql<AppDataRow[]>`
            select store_name, data_key from app_data_store
            where app_namespace = ${input.appData.namespace}
              and expire_at_ts <= ${new Date(input.expireAtEpochMs)}
              and (${input.afterCursor === null} or (store_name, data_key) > (${storeName}, ${dataKey}))
            order by store_name, data_key limit ${input.pageSize + 1}
        `
        : await sql<AppDataRow[]>`
            select store_name, data_key from app_data_store
            where app_namespace = ${input.appData.namespace}
              and store_name = ${input.appData.storeName}
              and expire_at_ts <= ${new Date(input.expireAtEpochMs)}
              and (${input.afterCursor === null} or data_key > ${dataKey})
            order by data_key limit ${input.pageSize + 1}
        `;
    return page(rows.map((row) => JSON.stringify([row.store_name, row.data_key])), input.pageSize);
}

async function deletePageRows(
    sql: PSqlSql,
    deletion: AdminPrunePageDelete
): Promise<number> {
    switch (deletion.category) {
        case 'runtime-state': {
            return (await sql<RuntimeRow[]>`
                with expired as (
                    select value::jsonb ->> 0 as store_namespace,
                           value::jsonb ->> 1 as store_key
                    from jsonb_array_elements_text(${deletion.rowIds}::jsonb)
                )
                delete from runtime_state_store target using expired
                where target.store_namespace = expired.store_namespace
                  and target.store_key = expired.store_key
                  and expire_at_ts <= ${deletion.capturedAt}
                returning target.store_namespace, target.store_key
            `).length;
        }
        case 'resource-inbox':
            return (await sql<ResourceRow[]>`
                with expired as (
                    select value::bigint as ri_row_id
                    from jsonb_array_elements_text(${deletion.rowIds}::jsonb)
                )
                delete from resource_inbox target using expired
                where target.ri_row_id = expired.ri_row_id
                  and expire_ts <= ${deletion.capturedAt}
                returning target.ri_row_id
            `).length;
        case 'resource-inbox-results':
            return (await sql<ResultsRow[]>`
                with expired as (
                    select value::bigint as ris_row_id
                    from jsonb_array_elements_text(${deletion.rowIds}::jsonb)
                )
                delete from resource_inbox_results target using expired
                where target.ris_row_id = expired.ris_row_id
                  and expire_ts <= ${deletion.capturedAt}
                returning target.ris_row_id
            `).length;
        case 'app-data': {
            return (await sql<AppDataRow[]>`
                with expired as (
                    select value::jsonb ->> 0 as store_name,
                           value::jsonb ->> 1 as data_key
                    from jsonb_array_elements_text(${deletion.rowIds}::jsonb)
                )
                delete from app_data_store target using expired
                where target.app_namespace = ${deletion.appData.namespace}
                  and target.store_name = expired.store_name
                  and target.data_key = expired.data_key
                  and expire_at_ts <= ${deletion.capturedAt}
                returning target.store_name, target.data_key
            `).length;
        }
    }
}

function page(rowIds: readonly string[], size: number): AdminPruneCandidatePage {
    return { rowIds: rowIds.slice(0, size), hasMore: rowIds.length > size };
}

function decodeTuple(value: string | null, length: number): readonly string[] {
    if (value === null) {
        return Array.from({ length }, () => '');
    }
    const decoded = JSON.parse(value);
    if (!Array.isArray(decoded) || decoded.length !== length || decoded.some((part) => typeof part !== 'string')) {
        throw new TypeError('Admin prune cursor is invalid');
    }
    return decoded;
}

function requireInteger(value: string): number {
    const integer = Number(value);
    if (!Number.isSafeInteger(integer) || integer < 0) {
        throw new TypeError('Admin prune row id is invalid');
    }
    return integer;
}
