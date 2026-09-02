import assert from 'node:assert/strict';

import { createApiV1TestPGliteDatabaseLifecycle } from './api-v1-test-pglite-database.ts';

const MIGRATION_URL = new URL(
    '../../prisma/migrations/20260902200000_connect_trigger_latch_settle/migration.sql',
    import.meta.url
);
const NAMESPACE = 'group-state:connect-trigger-latches';

/** A stored latch, before and after the settle instant existed. */
interface StoredLatch {
    readonly groupRef: { readonly applicationId: string; readonly workspaceId: string; readonly groupId: string; };
    readonly formationEpoch: number;
    readonly triggerGeneration: string;
    readonly notBeforeEpochMs?: number;
    readonly state: 'awaiting-publication' | 'consumed';
}

function toStoredLatch(notBeforeEpochMs: number | undefined): string {
    const latch: StoredLatch = {
        groupRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
        formationEpoch: 2,
        triggerGeneration: 'plan-1',
        ...(notBeforeEpochMs === undefined ? {} : { notBeforeEpochMs }),
        state: 'awaiting-publication'
    };
    return JSON.stringify(latch);
}

Deno.test('the latch-settle migration backfills latches written before the settle instant existed', async () => {
    const lifecycle = await createApiV1TestPGliteDatabaseLifecycle();
    try {
        const sql = lifecycle.database;
        const rows = [
            ['legacy', NAMESPACE, toStoredLatch(undefined)],
            ['settled', NAMESPACE, toStoredLatch(1_700)],
            ['other', 'group-state:other', toStoredLatch(undefined)]
        ] as const;
        for (const [key, namespace, value] of rows) {
            await sql`
                insert into runtime_state_store (store_namespace, store_key, store_value, expire_at_ts)
                values (${namespace}, ${key}, ${value}, '9999-12-31 23:59:59+00')
            `;
        }

        await sql.exec(await Deno.readTextFile(MIGRATION_URL));

        const stored = await sql<{ store_key: string; store_value: string; }[]>`
            select store_key, store_value from runtime_state_store order by store_key
        `;
        const byKey = new Map(stored.map((row) => [row.store_key, JSON.parse(row.store_value) as StoredLatch]));
        assert.equal(byKey.get('legacy')?.notBeforeEpochMs, 0);
        assert.equal(byKey.get('legacy')?.state, 'awaiting-publication');
        assert.equal(byKey.get('settled')?.notBeforeEpochMs, 1_700);
        assert.equal(byKey.get('other')?.notBeforeEpochMs, undefined);
    }
    finally {
        await lifecycle.close();
    }
});
