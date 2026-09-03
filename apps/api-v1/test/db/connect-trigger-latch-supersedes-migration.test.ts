import assert from 'node:assert/strict';

import { createApiV1TestPGliteDatabaseLifecycle } from './api-v1-test-pglite-database.ts';

const MIGRATION_URL = new URL(
    '../../prisma/migrations/20260903120000_connect_trigger_latch_supersedes/migration.sql',
    import.meta.url
);
const NAMESPACE = 'group-state:connect-trigger-latches';

interface StoredLayoutIdentity {
    readonly groupRevision: number;
    readonly presenceRevision: number;
    readonly version: number;
    readonly state: 'active' | 'removed';
}

/** A stored latch, before and after the superseded candidate existed. */
interface StoredLatch {
    readonly groupRef: { readonly applicationId: string; readonly workspaceId: string; readonly groupId: string; };
    readonly formationEpoch: number;
    readonly triggerGeneration: string;
    readonly notBeforeEpochMs: number;
    readonly supersedesLayoutIdentity?: StoredLayoutIdentity | null;
    readonly state: 'awaiting-publication' | 'consumed';
}

const SUPERSEDED: StoredLayoutIdentity = {
    groupRevision: 7,
    presenceRevision: 3,
    version: 4,
    state: 'active'
};

function toStoredLatch(supersedes: StoredLayoutIdentity | null | undefined): string {
    const latch: StoredLatch = {
        groupRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
        formationEpoch: 2,
        triggerGeneration: 'plan-1',
        notBeforeEpochMs: 0,
        ...(supersedes === undefined ? {} : { supersedesLayoutIdentity: supersedes }),
        state: 'awaiting-publication'
    };
    return JSON.stringify(latch);
}

Deno.test('the supersedes migration backfills latches written before the candidate existed', async () => {
    const lifecycle = await createApiV1TestPGliteDatabaseLifecycle();
    try {
        const sql = lifecycle.database;
        const rows = [
            ['legacy', NAMESPACE, toStoredLatch(undefined)],
            ['reconfigure', NAMESPACE, toStoredLatch(SUPERSEDED)],
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
        // A plan-armed latch names no candidate, so any active planned layout
        // still satisfies it -- the behaviour those rows were written under.
        assert.equal(byKey.get('legacy')?.supersedesLayoutIdentity, null);
        assert.equal(byKey.get('legacy')?.notBeforeEpochMs, 0);
        assert.deepEqual(byKey.get('reconfigure')?.supersedesLayoutIdentity, SUPERSEDED);
        // Scoped to the latch namespace: the row in another namespace is
        // still there, and still without the field.
        assert.ok(byKey.has('other'));
        assert.equal(byKey.get('other')?.supersedesLayoutIdentity, undefined);
    }
    finally {
        await lifecycle.close();
    }
});
