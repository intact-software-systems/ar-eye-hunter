import type { AdminPruneExpiredCategory } from '@shared/api/admin-operations-types.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import type { AdminExpiredDataPruner } from '../admin-expired-data-pruner.ts';
import type { AdminPruneExpiredOptions } from '../admin-prune-options.ts';

import { decodePSqlAdminCount, type PSqlAdminCountRow } from './decode-p-sql-admin-count.ts';

export class PSqlAdminExpiredDataPruner implements AdminExpiredDataPruner {
    private readonly sql: PSqlSql;

    constructor(sql: PSqlSql) {
        this.sql = sql;
    }

    async countExpired(
        category: AdminPruneExpiredCategory,
        options: AdminPruneExpiredOptions
    ): Promise<number> {
        switch (category) {
            case 'runtime-state':
                return await this.readCount(this.sql<PSqlAdminCountRow[]>`
                    select count(*) as count from runtime_state_store
                    where expire_at_ts <= ${new Date(options.cutoffEpochMs)}
                `);
            case 'resource-inbox':
                return await this.readCount(this.sql<PSqlAdminCountRow[]>`
                    select count(*) as count from resource_inbox
                    where expire_ts <= ${new Date(options.cutoffEpochMs)}
                `);
            case 'resource-inbox-results':
                return await this.readCount(this.sql<PSqlAdminCountRow[]>`
                    select count(*) as count from resource_inbox_results
                    where expire_ts <= ${new Date(options.cutoffEpochMs)}
                `);
            case 'app-data':
                return await this.countExpiredAppData(options);
        }
    }

    private async countExpiredAppData(options: AdminPruneExpiredOptions): Promise<number> {
        const namespace = requireAppDataNamespace(options);
        if (options.appData?.storeName) {
            return await this.readCount(this.sql<PSqlAdminCountRow[]>`
                select count(*) as count
                from app_data_store
                where app_namespace = ${namespace}
                  and store_name = ${options.appData.storeName}
                  and expire_at_ts <= ${new Date(options.cutoffEpochMs)}
            `);
        }
        return await this.readCount(this.sql<PSqlAdminCountRow[]>`
            select count(*) as count
            from app_data_store
            where app_namespace = ${namespace}
              and expire_at_ts <= ${new Date(options.cutoffEpochMs)}
        `);
    }

    private async readCount(rowsPromise: Promise<PSqlAdminCountRow[]>): Promise<number> {
        const row = (await rowsPromise)[0];
        return decodePSqlAdminCount(row?.count);
    }
}

function requireAppDataNamespace(options: AdminPruneExpiredOptions): string {
    const namespace = options.appData?.namespace;
    if (!namespace) {
        throw new Error('appData.namespace is required for app-data pruning.');
    }
    return namespace;
}
