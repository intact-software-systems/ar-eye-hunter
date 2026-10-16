import assert from 'node:assert/strict';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { SESSIONS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { InMemoryGroupStateEventStore } from '@shared-server/rallar-system/state-events/in-memory-group-state-event-store.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { GroupPresenceSession } from '@shared/api/group-types.ts';

import { createApiV1TestPGliteDatabaseLifecycle } from './api-v1-test-pglite-database.ts';

const UNRELATED_SESSION_COUNT = 5_000;

interface TableReadCounters {
    readonly heapRowsRead: number;
}

Deno.test('a session presence lookup reads only that session\'s rows, however many other sessions the store holds', async () => {
    const lifecycle = await createApiV1TestPGliteDatabaseLifecycle();
    const sql = lifecycle.database;
    try {
        const seed = new GroupStateRepository(new PSqlRuntimeStateRepository(sql), new InMemoryGroupStateEventStore());
        await seed.putPresenceSession(createPresenceSession({ groupId: 'room-one', sessionId: 'session:alice=1' }));
        await seed.putPresenceSession(createPresenceSession({ groupId: 'room-two', sessionId: 'session:alice=1' }));
        await seed.putPresenceSession(createPresenceSession({ groupId: 'room-two', sessionId: 'session:alice=12' }));
        await seed.putPresenceSession(createPresenceSession({ groupId: 'room-two', sessionId: 'xsession:alice=1' }));
        // Unreadable values: the lookup fails if it ever returns one of these rows.
        await sql`
          insert into runtime_state_store (store_namespace, store_key, store_value, expire_at_ts)
          select ${SESSIONS_NAMESPACE},
                 'app=app-1:ws=workspace-1:group=unrelated-' || n || ':session=unrelated-' || n,
                 'not json',
                 '9999-12-31T00:00:00Z'::timestamptz
          from generate_series(1, ${UNRELATED_SESSION_COUNT}) as n
        `;

        const { sessions, heapRowsRead } = await sql.begin(async (transaction) => {
            const before = await readTableReadCounters(transaction);
            const lookup = new GroupStateRepository(
                new PSqlRuntimeStateRepository(transaction),
                new InMemoryGroupStateEventStore()
            );
            const found = await lookup.listPresenceSessionsForSessionIds(['session:alice=1']);
            const after = await readTableReadCounters(transaction);
            return { sessions: found, heapRowsRead: after.heapRowsRead - before.heapRowsRead };
        });

        assert.deepEqual(sessions.map((session) => `${session.groupId}/${session.sessionId}`), [
            'room-one/session:alice=1',
            'room-two/session:alice=1'
        ]);
        // An index range over the key's final segment: the two rows it returns, not the namespace.
        assert.ok(heapRowsRead <= 2, `the lookup read ${heapRowsRead} store rows`);
    }
    finally {
        await lifecycle.close();
    }
});

async function readTableReadCounters(transaction: PSqlSql): Promise<TableReadCounters> {
    const [row] = await transaction<{ heap_rows_read: number; }[]>`
      select (coalesce(seq_tup_read, 0) + coalesce(idx_tup_fetch, 0))::int as heap_rows_read
      from pg_stat_xact_user_tables
      where relname = 'runtime_state_store'
    `;
    return { heapRowsRead: row?.heap_rows_read ?? 0 };
}

function createPresenceSession(
    input: Readonly<{ groupId: string; sessionId: string; }>
): GroupPresenceSession {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: input.groupId,
        sessionId: input.sessionId,
        principalId: 'alice',
        generationId: 'generation-1',
        generationVersion: 2_000,
        connectedAtEpochMs: 2_000,
        lastHeartbeatAtEpochMs: 3_000,
        expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}
