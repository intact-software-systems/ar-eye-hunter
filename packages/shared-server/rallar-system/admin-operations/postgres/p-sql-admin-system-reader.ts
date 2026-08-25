import type {
    AdminCountByStatus,
    AdminCountByTypeStatus,
    AdminOperationsSystemResponse
} from '@shared/api/admin-operations-types.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import type { AdminOperationReadRequest } from '../admin-operation-request.ts';
import { createAdminOperationBaseResponse } from '../admin-operation-response.ts';

import { decodePSqlAdminCount, type PSqlAdminCountRow } from './decode-p-sql-admin-count.ts';

interface StatusCountRow {
    readonly status: string;
    readonly count: number | string | bigint;
}

interface NamespaceStoreCountRow {
    readonly namespace: string;
    readonly store: string;
    readonly count: number | string | bigint;
}

export namespace PSqlAdminSystemReader {
    export interface Options {
        readonly nowEpochMs: () => number;
        readonly serverId?: string;
        readonly sqlBackend?: string;
        readonly dbPubSub?: string;
    }
}

export class PSqlAdminSystemReader {
    private readonly sql: PSqlSql;
    private readonly options: PSqlAdminSystemReader.Options;

    constructor(sql: PSqlSql, options: PSqlAdminSystemReader.Options) {
        this.sql = sql;
        this.options = options;
    }

    async execute(_input: AdminOperationReadRequest): Promise<AdminOperationsSystemResponse> {
        const [
            runtimeRows,
            runtimeExpiredRows,
            runtimeByNamespace,
            appDataRows,
            appDataExpiredRows,
            appDataByNamespaceStore,
            clientEvents,
            groupEvents
        ] = await Promise.all([
            this.countRuntimeRows(),
            this.countExpiredRuntimeRows(),
            this.countRuntimeByNamespace(),
            this.countAppDataRows(),
            this.countExpiredAppDataRows(),
            this.countAppDataByNamespaceStore(),
            this.countClientEvents(),
            this.countGroupEvents()
        ]);

        return {
            ...createAdminOperationBaseResponse(this.options),
            runtimeState: {
                rows: runtimeRows,
                expiredRows: runtimeExpiredRows,
                byNamespace: runtimeByNamespace
            },
            appData: {
                rows: appDataRows,
                expiredRows: appDataExpiredRows,
                byNamespaceStore: appDataByNamespaceStore
            },
            stateEvents: { clientEvents, groupEvents },
            configuration: {
                sqlBackend: this.options.sqlBackend,
                dbPubSub: this.options.dbPubSub
            }
        };
    }

    private async countRuntimeRows(): Promise<number> {
        return await this.readCount(this.sql<PSqlAdminCountRow[]>`
            select count(*) as count from runtime_state_store
        `);
    }

    private async countExpiredRuntimeRows(): Promise<number> {
        return await this.readCount(this.sql<PSqlAdminCountRow[]>`
            select count(*) as count from runtime_state_store where expire_at_ts <= now()
        `);
    }

    private async countAppDataRows(): Promise<number> {
        return await this.readCount(this.sql<PSqlAdminCountRow[]>`
            select count(*) as count from app_data_store
        `);
    }

    private async countExpiredAppDataRows(): Promise<number> {
        return await this.readCount(this.sql<PSqlAdminCountRow[]>`
            select count(*) as count from app_data_store where expire_at_ts <= now()
        `);
    }

    private async countClientEvents(): Promise<number> {
        return await this.readCount(this.sql<PSqlAdminCountRow[]>`
            select count(*) as count from client_state_events
        `);
    }

    private async countGroupEvents(): Promise<number> {
        return await this.readCount(this.sql<PSqlAdminCountRow[]>`
            select count(*) as count from group_state_events
        `);
    }

    private async countRuntimeByNamespace(): Promise<readonly AdminCountByStatus[]> {
        const rows = await this.sql<StatusCountRow[]>`
            select store_namespace as status, count(*) as count
            from runtime_state_store
            group by store_namespace
            order by store_namespace
        `;
        return rows.map((row) => ({
            status: row.status,
            count: decodePSqlAdminCount(row.count)
        }));
    }

    private async countAppDataByNamespaceStore(): Promise<readonly AdminCountByTypeStatus[]> {
        const rows = await this.sql<NamespaceStoreCountRow[]>`
            select app_namespace as namespace, store_name as store, count(*) as count
            from app_data_store
            group by app_namespace, store_name
            order by app_namespace, store_name
        `;
        return rows.map((row) => ({
            typeId: row.namespace,
            status: row.store,
            count: decodePSqlAdminCount(row.count)
        }));
    }

    private async readCount(rowsPromise: Promise<PSqlAdminCountRow[]>): Promise<number> {
        const row = (await rowsPromise)[0];
        return decodePSqlAdminCount(row?.count);
    }
}
