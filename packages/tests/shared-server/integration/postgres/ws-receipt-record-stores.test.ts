import { afterEach, describe, expect, it } from 'vitest';

import { createServerWsQBoxALReceiptRecordStores } from '@shared-server/al-runtime/postgres/create-p-sql-al-receipt-record-stores.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { ALReceiptRecordOpening } from '@shared/alm/receipt-record/al-receipt-record-rows.ts';
import { ALReceiptRecord } from '@shared/alm/receipt-record/al-receipt-record.ts';

import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl,
    type PostgresSql
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import {
    deletePostgresRunRows,
    NO_POSTGRES_RUN_ROWS,
    readPostgresRunRowCounts
} from './test-support/delete-postgres-run-rows.ts';

interface StoreNamespaceRow {
    readonly store_namespace: string;
}

describe.skipIf(process.env.RALLAR_POSTGRES_INTEGRATION !== '1')('PostgreSQL WS server receipt record stores', () => {
    const opened: Array<{ readonly runId: string; readonly sql: PostgresSql; }> = [];
    afterEach(async () => {
        for (const { runId, sql } of opened.splice(0)) {
            try {
                await deletePostgresRunRows(sql, runId);
                expect(await readPostgresRunRowCounts(sql, runId)).toEqual(NO_POSTGRES_RUN_ROWS);
            }
            finally {
                await sql.end();
            }
        }
    });

    // The sampler counts `server-ws-qbox:*:receipt:record`; a store under any other namespace grows unseen.
    it('keeps the server\'s receipt record under the namespace the growth proof reads', async () => {
        const runId = crypto.randomUUID();
        const sql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl(), 2);
        opened.push({ runId, sql });
        const stores = createServerWsQBoxALReceiptRecordStores(`run-${runId}`, new PSqlRuntimeStateRepository(sql));
        const record = new ALReceiptRecord({ ...stores, nowMs: Date.now });

        expect((await record.open(toOpening())).right?.head.phase).toBe('open');

        expect(stores.namespace).toBe(`server-ws-qbox:run-${runId}:receipt:record`);
        const rows = await sql<StoreNamespaceRow[]>`
            select store_namespace from runtime_state_store where store_key like ${`%${runId}%`}
        `;
        expect(rows.length).toBeGreaterThan(0);
        expect([...new Set(rows.map((row) => row.store_namespace))]).toEqual([stores.namespace]);
    }, 60_000);
});

function toOpening(): ALReceiptRecordOpening {
    return {
        originPeerId: 'origin',
        msgId: `msg-${crypto.randomUUID()}`,
        traceId: 'trace',
        expectedRecipientPeerIds: ['r1'],
        neverSentRecipientPeerIds: [],
        snapshotVersion: 1,
        deadlineAtMs: Date.now() + 30_000
    };
}
