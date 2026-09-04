import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { AdminPruneAppData } from '@shared-server/rallar-system/admin-operations/inbox/admin-prune-command-codec.ts';
import { PSqlAdminPruneRepository } from '@shared-server/rallar-system/admin-operations/postgres/p-sql-admin-prune-repository.ts';
import type { AdminPrunePageWork } from '@shared-server/rallar-system/admin-operations/prune/admin-prune-page-codec.ts';
import {
    toAdminPrunePageDelete,
    type AdminPruneCandidate
} from '@shared-server/rallar-system/admin-operations/prune/admin-prune-page-worker.ts';
import { toPSqlSql } from '../../../integration/postgres/test-support/postgres-sql-adapter.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

type PostgresSql = PSqlSql & Readonly<{ end(): Promise<void>; }>;

describe('Postgres admin-prune page deletion', () => {
    postgresIt('deletes a non-empty runtime-state page', async () => {
        const sql = await createSql(requireDatabaseUrl());
        const namespace = `admin-prune-${crypto.randomUUID()}`;
        const keys = ['first', 'second'];

        try {
            await sql`
        insert into runtime_state_store (
          store_namespace, store_key, store_value, expire_at_ts, revision
        ) values
          (${namespace}, ${keys[0]}, '{}', now() - interval '1 second', 1),
          (${namespace}, ${keys[1]}, '{}', now() - interval '1 second', 1)
      `;
            const candidates = keys.map((key) => ({
                rowId: JSON.stringify([namespace, key]),
                revisionToken: '1'
            }));

            expect(await deletePage(sql, createPageWork('runtime-state'), candidates)).toBe(2);
        }
        finally {
            await sql`delete from runtime_state_store where store_namespace = ${namespace}`;
            await sql.end();
        }
    });

    postgresIt('deletes a non-empty resource-inbox page', async () => {
        const sql = await createSql(requireDatabaseUrl());
        const resourceIds = [
            `prune-inbox-${crypto.randomUUID()}`,
            `prune-inbox-${crypto.randomUUID()}`
        ];

        try {
            const rows = await sql<{ ri_row_id: number | string; revision_token: number | string; }[]>`
        insert into resource_inbox (
          ri_resource_id,
          ri_topic_id,
          ri_resource,
          ri_type_id,
          ri_status,
          fk_ext_bank_id,
          system_date,
          created_by,
          created_ts,
          expire_ts
        ) values
          (
            ${resourceIds[0]}, 'test.admin-prune', '{}', 'APP_INBOX', 'COMPLETED',
            'admin-prune-test', current_date, 'test', now() - interval '1 second',
            now() - interval '1 second'
          ),
          (
            ${resourceIds[1]}, 'test.admin-prune', '{}', 'APP_INBOX', 'COMPLETED',
            'admin-prune-test', current_date, 'test', now() - interval '1 second',
            now() - interval '1 second'
          )
        returning ri_row_id, xmin::text as revision_token
      `;
            const candidates = rows.map((row) => ({
                rowId: String(row.ri_row_id),
                revisionToken: String(row.revision_token)
            }));

            expect(await deletePage(sql, createPageWork('resource-inbox'), candidates)).toBe(2);
        }
        finally {
            await sql`delete from resource_inbox where ri_resource_id in ${sql(resourceIds)}`;
            await sql.end();
        }
    });

    postgresIt('deletes a non-empty resource-inbox-results page', async () => {
        const sql = await createSql(requireDatabaseUrl());
        const resourceIds = [
            `prune-result-${crypto.randomUUID()}`,
            `prune-result-${crypto.randomUUID()}`
        ];

        try {
            const rows = await sql<{ ris_row_id: number | string; revision_token: number | string; }[]>`
        insert into resource_inbox_results (
          ris_resource_id,
          ris_topic_id,
          ris_resource,
          ris_type_id,
          ris_status,
          fk_ext_bank_id,
          system_date,
          created_by,
          created_ts,
          expire_ts
        ) values
          (
            ${resourceIds[0]},
            'test.admin-prune',
            '{}',
            'APP_INBOX',
            'COMPLETED',
            'admin-prune-test',
            current_date,
            'test',
            now() - interval '1 second',
            now() - interval '1 second'
          ),
          (
            ${resourceIds[1]},
            'test.admin-prune',
            '{}',
            'APP_INBOX',
            'COMPLETED',
            'admin-prune-test',
            current_date,
            'test',
            now() - interval '1 second',
            now() - interval '1 second'
          )
        returning ris_row_id, xmin::text as revision_token
      `;
            const candidates = rows.map((row) => ({
                rowId: String(row.ris_row_id),
                revisionToken: String(row.revision_token)
            }));

            expect(await deletePage(sql, createPageWork('resource-inbox-results'), candidates)).toBe(2);
        }
        finally {
            await sql`
        delete from resource_inbox_results
        where ris_resource_id in ${sql(resourceIds)}
      `;
            await sql.end();
        }
    });

    postgresIt('deletes a non-empty app-data page', async () => {
        const sql = await createSql(requireDatabaseUrl());
        const namespace = `admin-prune-${crypto.randomUUID()}`;
        const storeName = 'store';
        const keys = ['first', 'second'];

        try {
            await sql`
        insert into app_data_store (
          app_namespace, store_name, data_key, data_value, expire_at_ts
        ) values
          (${namespace}, ${storeName}, ${keys[0]}, '{}', now() - interval '1 second'),
          (${namespace}, ${storeName}, ${keys[1]}, '{}', now() - interval '1 second')
      `;
            const candidates = keys.map((key) => ({
                rowId: JSON.stringify([storeName, key]),
                revisionToken: '0'
            }));
            const appData = { namespace, storeName: null } as const;

            expect(await deletePage(sql, createPageWork('app-data', appData), candidates)).toBe(2);
        }
        finally {
            await sql`delete from app_data_store where app_namespace = ${namespace}`;
            await sql.end();
        }
    });
});

async function deletePage(
    sql: PostgresSql,
    work: AdminPrunePageWork,
    candidates: readonly AdminPruneCandidate[]
): Promise<number> {
    const repository = new PSqlAdminPruneRepository(sql);
    return await sql.begin(async (transaction) => {
        return await repository.deletePage(transaction, toAdminPrunePageDelete(work, candidates));
    });
}

function createPageWork(
    category: AdminPrunePageWork['category'],
    appData: AdminPruneAppData | null = null
): AdminPrunePageWork {
    const now = Date.now();
    return {
        kind: 'page',
        jobId: 'admin-prune-postgres-regression',
        category,
        requestedBy: 'admin',
        requestedSessionId: 'session',
        capturedAtEpochMs: now,
        expireAtEpochMs: now,
        pageSize: 2,
        afterCursor: null,
        pageIndex: 0,
        appData
    };
}

async function createSql(databaseUrl: string): Promise<PostgresSql> {
    const postgres = await import('postgres');
    const driver = postgres.default(databaseUrl, {
        max: 1,
        idle_timeout: 1
    });
    return Object.assign(toPSqlSql(driver), { end: () => driver.end() });
}

function requireDatabaseUrl(): string {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        throw new Error('DATABASE_URL is required when RALLAR_POSTGRES_INTEGRATION=1');
    }
    return databaseUrl;
}
