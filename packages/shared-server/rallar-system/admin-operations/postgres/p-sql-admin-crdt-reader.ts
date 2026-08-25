import type {
    AdminCountByStatus,
    AdminCountByTypeStatus,
    AdminOperationsCrdtResponse
} from '@shared/api/admin-operations-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import type { AdminOperationReadRequest } from '../admin-operation-request.ts';
import { createAdminOperationBaseResponse } from '../admin-operation-response.ts';

import { decodePSqlAdminCount, type PSqlAdminCountRow } from './decode-p-sql-admin-count.ts';

interface StatusCountRow {
    readonly status: string;
    readonly count: number | string | bigint;
}

interface CrdtScopeTypeRow {
    readonly document_scope: string;
    readonly document_type: string;
    readonly count: number | string | bigint;
}

interface CrdtStorageRow {
    readonly updates: number | string | bigint | null;
    readonly snapshots: number | string | bigint | null;
    readonly stored_update_bytes: number | string | bigint | null;
}

export namespace PSqlAdminCrdtReader {
    export interface Options {
        readonly nowEpochMs: () => number;
        readonly serverId?: string;
    }
}

export class PSqlAdminCrdtReader {
    private readonly sql: PSqlSql;
    private readonly options: PSqlAdminCrdtReader.Options;

    constructor(sql: PSqlSql, options: PSqlAdminCrdtReader.Options) {
        this.sql = sql;
        this.options = options;
    }

    async execute(input: AdminOperationReadRequest): Promise<AdminOperationsCrdtResponse> {
        const scope = input.scope;
        const [total, byLifecycle, byScopeType, storage] = await Promise.all([
            this.countDocuments(scope),
            this.countByLifecycle(scope),
            this.countByScopeType(scope),
            this.readStorage(scope)
        ]);

        return {
            ...createAdminOperationBaseResponse({ ...this.options, scope }),
            documents: { total, byLifecycle, byScopeType },
            storage
        };
    }

    private async countDocuments(scope?: StateScope): Promise<number> {
        const row = scope
            ? (await this.sql<PSqlAdminCountRow[]>`
                select count(*) as count
                from crdt_documents
                where application_id = ${scope.applicationId}
                  and workspace_id = ${scope.workspaceId}
            `)[0]
            : (await this.sql<PSqlAdminCountRow[]>`
                select count(*) as count from crdt_documents
            `)[0];
        return decodePSqlAdminCount(row?.count);
    }

    private async countByLifecycle(scope?: StateScope): Promise<readonly AdminCountByStatus[]> {
        const rows = scope
            ? await this.sql<StatusCountRow[]>`
                select lifecycle as status, count(*) as count
                from crdt_documents
                where application_id = ${scope.applicationId}
                  and workspace_id = ${scope.workspaceId}
                group by lifecycle
                order by lifecycle
            `
            : await this.sql<StatusCountRow[]>`
                select lifecycle as status, count(*) as count
                from crdt_documents
                group by lifecycle
                order by lifecycle
            `;
        return rows.map((row) => ({
            status: row.status,
            count: decodePSqlAdminCount(row.count)
        }));
    }

    private async countByScopeType(
        scope?: StateScope
    ): Promise<readonly AdminCountByTypeStatus[]> {
        const rows = scope
            ? await this.sql<CrdtScopeTypeRow[]>`
                select document_scope, document_type, count(*) as count
                from crdt_documents
                where application_id = ${scope.applicationId}
                  and workspace_id = ${scope.workspaceId}
                group by document_scope, document_type
                order by document_scope, document_type
            `
            : await this.sql<CrdtScopeTypeRow[]>`
                select document_scope, document_type, count(*) as count
                from crdt_documents
                group by document_scope, document_type
                order by document_scope, document_type
            `;
        return rows.map((row) => ({
            typeId: row.document_scope,
            status: row.document_type,
            count: decodePSqlAdminCount(row.count)
        }));
    }

    private async readStorage(scope?: StateScope): Promise<AdminOperationsCrdtResponse['storage']> {
        const row = scope
            ? (await this.sql<CrdtStorageRow[]>`
                select
                    coalesce(sum(update_count), 0) as updates,
                    coalesce(sum(snapshot_count), 0) as snapshots,
                    coalesce(sum(stored_update_bytes), 0) as stored_update_bytes
                from crdt_documents
                where application_id = ${scope.applicationId}
                  and workspace_id = ${scope.workspaceId}
            `)[0]
            : (await this.sql<CrdtStorageRow[]>`
                select
                    coalesce(sum(update_count), 0) as updates,
                    coalesce(sum(snapshot_count), 0) as snapshots,
                    coalesce(sum(stored_update_bytes), 0) as stored_update_bytes
                from crdt_documents
            `)[0];
        return {
            updates: decodePSqlAdminCount(row?.updates),
            snapshots: decodePSqlAdminCount(row?.snapshots),
            storedUpdateBytes: decodePSqlAdminCount(row?.stored_update_bytes)
        };
    }
}
