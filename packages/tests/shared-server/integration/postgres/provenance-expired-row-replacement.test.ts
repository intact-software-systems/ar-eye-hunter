import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { runInPSqlTransaction } from '@shared-server/postgres/run-in-p-sql-transaction.ts';
import { ResourceInboxInvariantCorruptionError } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { writeAuthLogoutProvenance } from '@shared-server/rallar-system/auth/mutation/compute/auth-logout-provenance.ts';
import { writeClientSnapshotProvenance } from '@shared-server/rallar-system/client-state/persistence/client-snapshot-provenance.ts';
import { writeCrdtOutboxProvenance } from '@shared-server/rallar-system/crdt/persistence/crdt-outbox-provenance.ts';
import { writeGroupDeltaProvenance } from '@shared-server/rallar-system/group-state/presence/group-delta-provenance.ts';
import { writeRtcTopologyOutboxProvenance } from '@shared-server/rallar-system/topology/publication/rtc-topology-outbox-provenance.ts';
import { WS_OUTBOX_PROVENANCE_NAMESPACE } from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';

import {
    createRuntimeStatePostgresSql,
    requirePostgresClient,
    requirePostgresDatabaseUrl,
    withPostgresClients
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

interface Proof {
    readonly queueKey: Key;
    readonly key: string;
    readonly value: string;
    readonly expiresAt: string;
}

/** Each WS-outbox producer's proof writer, as its transaction calls it with one proof. */
const PROOF_WRITERS: readonly (readonly [string, (transaction: PSqlSql, proof: Proof) => Promise<void>])[] = [
    ['group delta', async (transaction, proof) => await writeGroupDeltaProvenance(transaction, [proof])],
    [
        'client snapshot',
        async (transaction, proof) => await writeClientSnapshotProvenance(transaction, [{ ...proof, namespace: WS_OUTBOX_PROVENANCE_NAMESPACE }])
    ],
    ['CRDT', async (transaction, proof) => await writeCrdtOutboxProvenance(transaction, [proof])],
    ['RTC topology', async (transaction, proof) => await writeRtcTopologyOutboxProvenance(transaction, [proof])],
    ['auth logout', async (transaction, proof) => await writeAuthLogoutProvenance(transaction, proof)]
];

describe.each(PROOF_WRITERS)('Postgres %s provenance proof over an expired row', (_producer, writeProof) => {
    postgresIt('writes a proof over an expired one, one revision past it, and still refuses a live one', async () => {
        await withProofSql(async (sql, runId) => {
            const proof = toProof(runId, 'first');
            await runInPSqlTransaction(sql, async (transaction) => await writeProof(transaction, proof));
            await sql`
                update runtime_state_store set expire_at_ts = now() - interval '1 minute'
                where store_namespace = ${WS_OUTBOX_PROVENANCE_NAMESPACE} and store_key = ${proof.key}
            `;

            const replay = toProof(runId, 'replay');
            await runInPSqlTransaction(sql, async (transaction) => await writeProof(transaction, replay));
            expect(await readProof(sql, proof.key)).toEqual({ value: replay.value, revision: 1 });

            await expect(
                runInPSqlTransaction(sql, async (transaction) => await writeProof(transaction, proof))
            ).rejects.toBeInstanceOf(ResourceInboxInvariantCorruptionError);
            expect(await readProof(sql, proof.key)).toEqual({ value: replay.value, revision: 1 });
        });
    }, 60_000);
});

async function withProofSql(run: (sql: PSqlSql, runId: string) => Promise<void>): Promise<void> {
    await withPostgresClients({
        namespace: null,
        clientCount: 1,
        createClient: async () => await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl(), 2)
    }, async (clients) => {
        const sql = requirePostgresClient(clients, 0);
        const runId = crypto.randomUUID();
        try {
            await run(sql, runId);
        }
        finally {
            await sql`delete from runtime_state_store where store_key like ${`%${runId}%`}`;
        }
    });
}

function toProof(runId: string, label: string): Proof {
    return {
        queueKey: { topicId: 'provenance-test', contextId: runId, resourceId: label },
        key: `provenance-test:${runId}`,
        value: JSON.stringify({ label }),
        expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
}

async function readProof(sql: PSqlSql, key: string): Promise<Readonly<{ value: string; revision: number; }> | undefined> {
    const [row] = await sql<{ value: string; revision: number; }[]>`
        select store_value as value, revision::int as revision
        from runtime_state_store
        where store_namespace = ${WS_OUTBOX_PROVENANCE_NAMESPACE} and store_key = ${key}
    `;
    return row;
}
