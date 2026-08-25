import { PSqlAdminExpiredDataPruner } from '@shared-server/rallar-system/admin-operations/postgres/p-sql-admin-expired-data-pruner.ts';
import assert from 'node:assert/strict';

import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';
import { createApiV1TestPGliteDatabaseLifecycle } from './api-v1-test-pglite-database.ts';

Deno.test('PostgreSQL admin expiry reader counts only expired supported rows', async () => {
    await withPGliteSql(async (sql) => {
        await seedSupportedPruneRows(sql);
        const pruner = new PSqlAdminExpiredDataPruner(sql);
        const cutoff = { cutoffEpochMs: Date.now() };

        assert.equal(await pruner.countExpired('runtime-state', cutoff), 1);
        assert.equal(await pruner.countExpired('resource-inbox', cutoff), 1);
        assert.equal(await pruner.countExpired('resource-inbox-results', cutoff), 1);
        assert.equal(
            await pruner.countExpired('app-data', {
                ...cutoff,
                appData: { namespace: 'app-ns', storeName: 'settings' }
            }),
            1
        );
    });
});

async function seedSupportedPruneRows(sql: PGliteSql): Promise<void> {
    const expiredAt = new Date('2000-01-01T00:00:00Z');
    await sql`
    insert into resource_inbox (
      ri_resource_id, ri_topic_id, ri_resource, ri_type_id, ri_status,
      fk_ext_bank_id, system_date, created_by, created_ts, expire_ts
    ) values (
      ${'expired-inbox'}, ${'topic'}, ${'payload'}, ${'APP_INBOX'}, ${'COMPLETED'},
      ${'bank'}, ${'2026-08-20'}, ${'test'}, ${expiredAt}, ${expiredAt}
    )
  `;
    await sql`
    insert into resource_inbox_results (
      ris_resource_id, ris_topic_id, ris_resource, ris_type_id, ris_status,
      fk_ext_bank_id, system_date, created_by, created_ts, expire_ts
    ) values (
      ${'expired-result'}, ${'topic'}, ${'payload'}, ${'APP_INBOX'}, ${'COMPLETED'},
      ${'bank'}, ${'2026-08-20'}, ${'test'}, ${expiredAt}, ${expiredAt}
    )
  `;
    await sql`
    insert into runtime_state_store (
      store_namespace, store_key, store_value, expire_at_ts
    ) values (${'test'}, ${'expired-runtime'}, ${'{}'}, ${expiredAt})
  `;
    await sql`
    insert into app_data_store (
      app_namespace, store_name, data_key, data_value, expire_at_ts
    ) values (${'app-ns'}, ${'settings'}, ${'expired-app-data'}, ${'{}'}, ${expiredAt})
  `;
}

async function withPGliteSql(action: (sql: PGliteSql) => Promise<void>): Promise<void> {
    const lifecycle = await createApiV1TestPGliteDatabaseLifecycle();
    try {
        await action(lifecycle.database);
    }
    finally {
        await lifecycle.close();
    }
}
