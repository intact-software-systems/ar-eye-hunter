import type { AdminCountByTypeStatus, AdminOperationsQueuesResponse } from '@shared/api/admin-operations-types.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import type { AdminOperationReadRequest } from '../admin-operation-request.ts';
import { createAdminOperationBaseResponse } from '../admin-operation-response.ts';

import { decodePSqlAdminCount, type PSqlAdminCountRow } from './decode-p-sql-admin-count.ts';

interface QueueTypeStatusRow {
    readonly type_id: string;
    readonly status: string;
    readonly count: number | string | bigint;
}

export namespace PSqlAdminQueueReader {
    export interface Options {
        readonly nowEpochMs: () => number;
        readonly serverId?: string;
    }
}

export class PSqlAdminQueueReader {
    private readonly sql: PSqlSql;
    private readonly options: PSqlAdminQueueReader.Options;

    constructor(sql: PSqlSql, options: PSqlAdminQueueReader.Options) {
        this.sql = sql;
        this.options = options;
    }

    async execute(_input: AdminOperationReadRequest): Promise<AdminOperationsQueuesResponse> {
        const [queueTotal, queueExpired, queueGroups, resultTotal, resultExpired, resultGroups] = await Promise.all([
            this.countQueueRows(),
            this.countExpiredQueueRows(),
            this.readQueueGroups(),
            this.countResultRows(),
            this.countExpiredResultRows(),
            this.readResultGroups()
        ]);

        return {
            ...createAdminOperationBaseResponse(this.options),
            queueRows: {
                total: queueTotal,
                expired: queueExpired,
                byTypeStatus: queueGroups,
                topPressure: toTopPressure(queueGroups)
            },
            resultRows: {
                total: resultTotal,
                expired: resultExpired,
                byTypeStatus: resultGroups,
                topPressure: toTopPressure(resultGroups)
            }
        };
    }

    private async countQueueRows(): Promise<number> {
        const row = (await this.sql<PSqlAdminCountRow[]>`
            select count(*) as count from resource_inbox
        `)[0];
        return decodePSqlAdminCount(row?.count);
    }

    private async countExpiredQueueRows(): Promise<number> {
        const row = (await this.sql<PSqlAdminCountRow[]>`
            select count(*) as count from resource_inbox where expire_ts <= now()
        `)[0];
        return decodePSqlAdminCount(row?.count);
    }

    private async countResultRows(): Promise<number> {
        const row = (await this.sql<PSqlAdminCountRow[]>`
            select count(*) as count from resource_inbox_results
        `)[0];
        return decodePSqlAdminCount(row?.count);
    }

    private async countExpiredResultRows(): Promise<number> {
        const row = (await this.sql<PSqlAdminCountRow[]>`
            select count(*) as count from resource_inbox_results where expire_ts <= now()
        `)[0];
        return decodePSqlAdminCount(row?.count);
    }

    private async readQueueGroups(): Promise<readonly AdminCountByTypeStatus[]> {
        const rows = await this.sql<QueueTypeStatusRow[]>`
            select ri_type_id as type_id, ri_status as status, count(*) as count
            from resource_inbox
            group by ri_type_id, ri_status
            order by ri_type_id, ri_status
        `;
        return rows.map(toTypeStatusCount);
    }

    private async readResultGroups(): Promise<readonly AdminCountByTypeStatus[]> {
        const rows = await this.sql<QueueTypeStatusRow[]>`
            select ris_type_id as type_id, ris_status as status, count(*) as count
            from resource_inbox_results
            group by ris_type_id, ris_status
            order by ris_type_id, ris_status
        `;
        return rows.map(toTypeStatusCount);
    }
}

function toTypeStatusCount(row: QueueTypeStatusRow): AdminCountByTypeStatus {
    return {
        typeId: row.type_id,
        status: row.status,
        count: decodePSqlAdminCount(row.count)
    };
}

function toTopPressure(
    rows: readonly AdminCountByTypeStatus[]
): readonly AdminCountByTypeStatus[] {
    return [...rows]
        .sort((left, right) =>
            right.count - left.count ||
            left.typeId.localeCompare(right.typeId) ||
            left.status.localeCompare(right.status)
        )
        .slice(0, 10);
}
