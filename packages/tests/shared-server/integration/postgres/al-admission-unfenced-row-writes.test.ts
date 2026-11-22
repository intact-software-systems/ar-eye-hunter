import { describe, expect, it } from 'vitest';

import { PSqlAdmissionWorkBackend } from '@shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { decodeALAdmissionString } from '@shared/alm/al-admission-value-validation.ts';

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
import { holdPostgresCommit } from './test-support/hold-postgres-commit.ts';
import { createWorkerHold, type WorkerHold } from './test-support/postgres-worker-hold.ts';
import { racePastHeldCommit } from './test-support/race-past-held-commit.ts';
import { recordPostgresStatements, type PostgresStatementLog } from './test-support/record-postgres-statements.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

/** Long enough that no probe row expires while a test still reads it. */
const ROW_TTL_MS = 60_000;
/** Far longer than one uncontended single-row commit; a write still waiting after it is waiting on a lock. */
const BLOCKED_AFTER_MS = 5_000;

/**
 * Probes the premise of a per-recipient receipt record: unfenced rows of one namespace, written concurrently to
 * distinct keys through the PostgreSQL admission backend, neither conflict nor wait on a shared row, and one such
 * write costs a pinned number of statements.
 */
describe('Postgres unfenced admission row writes', () => {
    // A shared revision row or a namespace-wide lock would reject some of these writes as conflicts.
    postgresIt('writes thirty distinct keys of one namespace from three backends without a conflict', async () => {
        await withProbe(async ({ namespace, backends, expireAtMs }) => {
            const keys = Array.from({ length: 30 }, (_, index) => toProbeKey(namespace, index));
            const settled = await Promise.allSettled(
                keys.map((key, index) => backends[index % 3]!.write(async (write) => await write.set(key, key, expireAtMs)))
            );
            expect(settled.filter((result) => result.status === 'rejected')).toEqual([]);
            expect(await backends[0]!.list(`${namespace}:probe:`, decodeALAdmissionString)).toHaveLength(30);
        });
    }, 60_000);

    // A write that touched a shared row would wait here until the held transaction commits, which it never does first.
    postgresIt('commits a row while another backend\'s write to a different key is still uncommitted', async () => {
        await withProbe(async ({ namespace, backends, heldBackend, hold, expireAtMs }) => {
            const keyA = toProbeKey(namespace, 0);
            const keyB = toProbeKey(namespace, 1);
            const { raced } = await racePastHeldCommit({
                hold,
                startHeld: () => heldBackend.write(async (write) => await write.set(keyA, keyA, expireAtMs)),
                startRaced: () => backends[1]!.write(async (write) => await write.set(keyB, keyB, expireAtMs)),
                blockedAfterMs: BLOCKED_AFTER_MS
            });
            expect(raced).toBe('finished');
            expect(await backends[2]!.read(keyA, decodeALAdmissionString)).toBe(keyA);
        });
    }, 60_000);

    // Pins the cost the receipt record pays per confirmation: the key read in autocommit, then the insert in one
    // transaction, so four round trips with BEGIN and COMMIT.
    postgresIt('writes one unfenced row in a pinned number of statements and one transaction', async () => {
        await withProbe(async ({ namespace, recordedBackend, log, expireAtMs }) => {
            const keyC = toProbeKey(namespace, 0);
            await recordedBackend.write(async (write) => await write.set(keyC, keyC, expireAtMs));
            expect(log.transactions).toBe(1);
            expect(log.statements.map((statement) => statement.transaction)).toEqual([null, 1]);
        });
    }, 60_000);
});

interface UnfencedRowProbe {
    readonly namespace: string;
    readonly expireAtMs: number;
    /** Three backends of one namespace, each on its own client, as three servers would hold them. */
    readonly backends: readonly PSqlAdmissionWorkBackend[];
    /** A fourth backend whose every commit waits for `hold` to be released. */
    readonly heldBackend: PSqlAdmissionWorkBackend;
    readonly hold: WorkerHold;
    /** A fifth backend whose statements `log` records. */
    readonly recordedBackend: PSqlAdmissionWorkBackend;
    readonly log: PostgresStatementLog;
}

/** Runs one probe on a namespace of its own run id, then deletes every row that carries the run id. */
async function withProbe(run: (probe: UnfencedRowProbe) => Promise<void>): Promise<void> {
    const runId = crypto.randomUUID();
    const namespace = `receipt-probe:${runId}`;
    const clients: PostgresSql[] = [];
    try {
        for (let index = 0; index < 3; index += 1) {
            clients.push(await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl(), 10));
        }
        const hold = createWorkerHold();
        const log: PostgresStatementLog = { statements: [], transactions: 0 };
        const toBackend = (sql: PSqlSql) => new PSqlAdmissionWorkBackend({ sql, namespace, nowMs: Date.now });
        try {
            await run({
                namespace,
                expireAtMs: Date.now() + ROW_TTL_MS,
                backends: clients.map(toBackend),
                heldBackend: toBackend(holdPostgresCommit(clients[0]!, hold)),
                hold,
                recordedBackend: toBackend(recordPostgresStatements(clients[2]!, log, null)),
                log
            });
        }
        finally {
            await deletePostgresRunRows(clients[0]!, runId);
        }
        expect(await readPostgresRunRowCounts(clients[0]!, runId)).toEqual(NO_POSTGRES_RUN_ROWS);
    }
    finally {
        await Promise.all(clients.map(async (client) => await client.end()));
    }
}

function toProbeKey(namespace: string, index: number): string {
    return `${namespace}:probe:${index}`;
}
