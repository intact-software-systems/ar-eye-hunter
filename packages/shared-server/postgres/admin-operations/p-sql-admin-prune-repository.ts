import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { PSqlResourceInboxEntryRepository } from '../../queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { PSqlResourceInboxFinalizationRepository } from '../../queuebox/postgres/p-sql-resource-inbox-finalization-repository.ts';
import { ResourceInboxResultsRepository } from '../../queuebox/postgres/resource-inbox-results-repository.ts';
import type { AdminPrunePageWork } from '../../rallar-system/admin-operations/prune/admin-prune-page-codec.ts';
import type {
    AdminPruneCandidatePage,
    AdminPrunePageComputed,
    AdminPrunePageRepository
} from '../../rallar-system/admin-operations/prune/admin-prune-page-worker.ts';
import {
    decodeAdminPruneAggregate,
    toAdminPruneAggregateKey
} from '../../rallar-system/admin-operations/prune/admin-prune-progress.ts';
import type { PSqlSql } from '../p-sql-sql.ts';

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
        command: AdminPrunePageWork,
        rowIds: readonly string[]
    ): Promise<number> {
        if (rowIds.length === 0) {
            return 0;
        }
        return await deletePageRows(transaction, command, rowIds);
    }

    async readAggregate(jobId: string) {
        const key = toAdminPruneAggregateKey(jobId);
        const current = await new ResourceInboxResultsRepository(this.sql).findAnyByKey(key);
        if (!current) {
            throw new Error('Admin prune aggregate was not found');
        }
        const aggregate = decodeAdminPruneAggregate(JSON.parse(current.resource));
        if (aggregate.jobId !== jobId) {
            throw new TypeError('Admin prune aggregate identity is corrupt');
        }
        return { aggregate, resource: current.resource };
    }

    async writeOutbox(transaction: PSqlSql, entry: ResourceEntry): Promise<void> {
        await new PSqlResourceInboxEntryRepository(transaction).write(entry);
    }

    async writeProgress(
        transaction: PSqlSql,
        computed: AdminPrunePageComputed
    ): Promise<void> {
        const next = computed.aggregateSuccessor;
        const key = next.key;
        const rows = await transaction<{ ris_row_id: number | string; }[]>`
            update resource_inbox_results
            set ris_resource = ${next.resource}, ris_status = ${next.status},
                expire_ts = ${next.audit.expiryTs.toString()}
            where ris_topic_id = ${key.topicId}
              and ris_resource_id = ${key.resourceId}
              and fk_ext_bank_id = ${key.contextId}
              and ris_resource = ${computed.expectedAggregate}
            returning ris_row_id
        `;
        if (rows.length !== 1) {
            throw Object.assign(new Error('Admin prune aggregate changed before commit'), {
                code: 'admin-prune-progress-conflict'
            });
        }
    }

    async finishReserved(
        transaction: PSqlSql,
        entry: ResourceEntry,
        finishedAtEpochMs: number
    ): Promise<boolean> {
        return await new PSqlResourceInboxFinalizationRepository(transaction).finishReserved(
            entry.key,
            entry.dequeueAudit.attempts,
            EntityStatus.COMPLETED,
            new Date(finishedAtEpochMs)
        );
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
    command: AdminPrunePageWork,
    rowIds: readonly string[]
): Promise<number> {
    switch (command.category) {
        case 'runtime-state': {
            return (await sql<RuntimeRow[]>`
                with expired as (
                    select value::jsonb ->> 0 as store_namespace,
                           value::jsonb ->> 1 as store_key
                    from jsonb_array_elements_text(${rowIds}::jsonb)
                )
                delete from runtime_state_store target using expired
                where target.store_namespace = expired.store_namespace
                  and target.store_key = expired.store_key
                  and expire_at_ts <= ${new Date(command.capturedAtEpochMs)}
                returning target.store_namespace, target.store_key
            `).length;
        }
        case 'resource-inbox':
            return (await sql<ResourceRow[]>`
                with expired as (
                    select value::bigint as ri_row_id
                    from jsonb_array_elements_text(${rowIds}::jsonb)
                )
                delete from resource_inbox target using expired
                where target.ri_row_id = expired.ri_row_id
                  and expire_ts <= ${new Date(command.capturedAtEpochMs)}
                returning target.ri_row_id
            `).length;
        case 'resource-inbox-results':
            return (await sql<ResultsRow[]>`
                with expired as (
                    select value::bigint as ris_row_id
                    from jsonb_array_elements_text(${rowIds}::jsonb)
                )
                delete from resource_inbox_results target using expired
                where target.ris_row_id = expired.ris_row_id
                  and expire_ts <= ${new Date(command.capturedAtEpochMs)}
                returning target.ris_row_id
            `).length;
        case 'app-data': {
            if (!command.appData) {
                throw new TypeError('App-data prune requires namespace');
            }
            return (await sql<AppDataRow[]>`
                with expired as (
                    select value::jsonb ->> 0 as store_name,
                           value::jsonb ->> 1 as data_key
                    from jsonb_array_elements_text(${rowIds}::jsonb)
                )
                delete from app_data_store target using expired
                where target.app_namespace = ${command.appData.namespace}
                  and target.store_name = expired.store_name
                  and target.data_key = expired.data_key
                  and expire_at_ts <= ${new Date(command.capturedAtEpochMs)}
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
    const decoded: unknown = JSON.parse(value);
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
