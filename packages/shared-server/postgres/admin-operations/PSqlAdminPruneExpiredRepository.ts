import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { PSqlSql, PSqlTransactionSql } from '../PostgresSqlClient.ts';
import { ResourceInboxRepository } from '../resource-inbox/ResourceInboxRepository.ts';
import { ResourceInboxResultsRepository } from '../resource-inbox/ResourceInboxResultsRepository.ts';
import type {
    AdminPruneExpiredRepository,
    AdminPrunePageComputed,
    AdminPrunePageRead,
    AdminPrunePageWork,
} from '../../rallar-system/admin-operations/AdminPruneExpiredWork.ts';
import {
    advanceAdminPruneAggregate,
    decodeAdminPruneAggregate,
    toAdminPruneAggregateEntry,
    toAdminPruneAggregateKey,
} from '../../rallar-system/admin-operations/admin-prune-progress.ts';

type RuntimeRow = Readonly<{ store_namespace: string; store_key: string }>;
type ResourceRow = Readonly<{ ri_row_id: number | string }>;
type ResultsRow = Readonly<{ ris_row_id: number | string }>;
type AppDataRow = Readonly<{ store_name: string; data_key: string }>;

export class PSqlAdminPruneExpiredRepository implements AdminPruneExpiredRepository {
    constructor(
        private readonly sql: PSqlSql,
        _serviceId: string,
    ) {}

    async readPage(input: Parameters<AdminPruneExpiredRepository['readPage']>[0]): Promise<AdminPrunePageRead> {
        switch (input.category) {
            case 'runtime-state': return await readRuntimePage(this.sql, input);
            case 'resource-inbox': return await readResourcePage(this.sql, input);
            case 'resource-inbox-results': return await readResultsPage(this.sql, input);
            case 'app-data': return await readAppDataPage(this.sql, input);
        }
    }

    async deletePage(
        transaction: PSqlTransactionSql,
        command: AdminPrunePageWork,
        rowIds: readonly string[],
    ): Promise<number> {
        let deleted = 0;
        for (const rowId of rowIds) {
            deleted += await deleteRow(transaction, command, rowId);
        }
        return deleted;
    }

    async writeOutbox(transaction: PSqlTransactionSql, entry: ResourceEntry): Promise<void> {
        await new ResourceInboxRepository(transaction).writeIfAbsentOrMatch(entry);
    }

    async writeProgress(
        transaction: PSqlTransactionSql,
        computed: AdminPrunePageComputed,
    ): Promise<void> {
        const key = toAdminPruneAggregateKey(computed.jobId);
        const current = await new ResourceInboxResultsRepository(transaction).findAnyByKey(key);
        if (!current) throw new Error('Admin prune aggregate was not found');
        const aggregate = decodeAdminPruneAggregate(JSON.parse(current.resource));
        const next = toAdminPruneAggregateEntry(advanceAdminPruneAggregate(aggregate, computed));
        const rows = await transaction<{ ris_row_id: number | string }[]>`
            update resource_inbox_results
            set ris_resource = ${next.resource}, ris_status = ${next.status}
            where ris_topic_id = ${key.topicId}
              and ris_resource_id = ${key.resourceId}
              and fk_ext_bank_id = ${key.contextId}
              and ris_resource = ${current.resource}
            returning ris_row_id
        `;
        if (rows.length !== 1) {
            throw Object.assign(new Error('Admin prune aggregate changed before commit'), {
                code: 'admin-prune-progress-conflict',
            });
        }
    }

    async finishReserved(
        transaction: PSqlTransactionSql,
        entry: ResourceEntry,
    ): Promise<boolean> {
        return await new ResourceInboxRepository(transaction).finishReserved(
            entry.key,
            entry.dequeueAudit.attempts,
            EntityStatus.COMPLETED,
            new Date(),
        );
    }
}

async function readRuntimePage(
    sql: PSqlSql,
    input: Parameters<AdminPruneExpiredRepository['readPage']>[0],
): Promise<AdminPrunePageRead> {
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
    input: Parameters<AdminPruneExpiredRepository['readPage']>[0],
): Promise<AdminPrunePageRead> {
    const after = input.afterCursor === null ? 0 : requireInteger(input.afterCursor);
    const rows = await sql<ResourceRow[]>`
        select ri_row_id
        from resource_inbox
        where expire_ts <= ${new Date(input.expireAtEpochMs)}
          and ri_row_id > ${after}
          and (${input.excludedResourceId === null} or ri_resource_id <> ${input.excludedResourceId})
        order by ri_row_id
        limit ${input.pageSize + 1}
    `;
    return page(rows.map((row) => String(row.ri_row_id)), input.pageSize);
}

async function readResultsPage(
    sql: PSqlSql,
    input: Parameters<AdminPruneExpiredRepository['readPage']>[0],
): Promise<AdminPrunePageRead> {
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
    input: Parameters<AdminPruneExpiredRepository['readPage']>[0],
): Promise<AdminPrunePageRead> {
    if (!input.appData) throw new TypeError('App-data prune requires namespace');
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

async function deleteRow(
    sql: PSqlSql,
    command: AdminPrunePageWork,
    rowId: string,
): Promise<number> {
    switch (command.category) {
        case 'runtime-state': {
            const [namespace, key] = decodeTuple(rowId, 2);
            return (await sql<RuntimeRow[]>`
                delete from runtime_state_store
                where store_namespace = ${namespace} and store_key = ${key}
                  and expire_at_ts <= ${new Date(command.capturedAtEpochMs)}
                returning store_namespace, store_key
            `).length;
        }
        case 'resource-inbox':
            return (await sql<ResourceRow[]>`
                delete from resource_inbox
                where ri_row_id = ${requireInteger(rowId)}
                  and expire_ts <= ${new Date(command.capturedAtEpochMs)}
                returning ri_row_id
            `).length;
        case 'resource-inbox-results':
            return (await sql<ResultsRow[]>`
                delete from resource_inbox_results
                where ris_row_id = ${requireInteger(rowId)}
                  and expire_ts <= ${new Date(command.capturedAtEpochMs)}
                returning ris_row_id
            `).length;
        case 'app-data': {
            if (!command.appData) throw new TypeError('App-data prune requires namespace');
            const [storeName, dataKey] = decodeTuple(rowId, 2);
            return (await sql<AppDataRow[]>`
                delete from app_data_store
                where app_namespace = ${command.appData.namespace}
                  and store_name = ${storeName} and data_key = ${dataKey}
                  and expire_at_ts <= ${new Date(command.capturedAtEpochMs)}
                returning store_name, data_key
            `).length;
        }
    }
}

function page(rowIds: readonly string[], size: number): AdminPrunePageRead {
    return { rowIds: rowIds.slice(0, size), hasMore: rowIds.length > size };
}

function decodeTuple(value: string | null, length: number): readonly string[] {
    if (value === null) return Array.from({ length }, () => '');
    const decoded: unknown = JSON.parse(value);
    if (!Array.isArray(decoded) || decoded.length !== length || decoded.some((part) => typeof part !== 'string')) {
        throw new TypeError('Admin prune cursor is invalid');
    }
    return decoded;
}

function requireInteger(value: string): number {
    const integer = Number(value);
    if (!Number.isSafeInteger(integer) || integer < 0) throw new TypeError('Admin prune row id is invalid');
    return integer;
}
