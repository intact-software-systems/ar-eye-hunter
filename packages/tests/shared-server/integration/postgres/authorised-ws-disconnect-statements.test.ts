import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { createWsConnectionHolderRecordReader } from '@shared-server/rallar-system/client-state/connection-holder/ws-connection-holder-record-reader.ts';
import { toAuthorisedWsClientConnection } from '@shared-server/rallar-system/client-state/inbox/authorised-ws-client-app-inbox.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import { putAuthorisedWsTestTicket } from '../../rallar-system/client-state/authorised-ws-test-ticket.ts';
import {
    createRuntimeStatePostgresSql,
    requirePostgresClient,
    requirePostgresDatabaseUrl,
    withPostgresClients
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import {
    deletePostgresRunRows,
    NO_POSTGRES_RUN_ROWS,
    readPostgresRunRowCounts
} from './test-support/delete-postgres-run-rows.ts';
import {
    createPostgresAppInboxWorkerRuntime,
    createPostgresAppInboxWorkerTrace
} from './test-support/postgres-app-inbox-worker-runtime.ts';
import {
    recordPostgresStatements,
    type PostgresStatementLog,
    type RecordedPostgresStatement
} from './test-support/record-postgres-statements.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;
const HOLDERS_NAMESPACE = 'client-state:ws-connection-holders';
const CLOSE_HIGH_WATER_NAMESPACE = 'ws-session-close-high-water';
/** What a disconnect of an active session issued before it released a holder record: its reads, and its transaction. */
const UNRECORDED_DISCONNECT_RUNTIME_STATE_READS = 6;
const UNRECORDED_DISCONNECT_TRANSACTION_STATEMENTS = 9;

describe('Postgres authorised WebSocket disconnect statements', () => {
    postgresIt('releases the holder record with one read more and one statement more in its transaction', async () => {
        await withPostgresClients({
            namespace: null,
            clientCount: 2,
            createClient: async () => await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl(), 4)
        }, async (clients) => {
            const setupSql = requirePostgresClient(clients, 0);
            const runId = crypto.randomUUID();
            try {
                await measureDisconnect(setupSql, requirePostgresClient(clients, 1), runId);
            }
            finally {
                await deletePostgresRunRows(setupSql, runId);
            }
            expect(await readPostgresRunRowCounts(setupSql, runId)).toEqual(NO_POSTGRES_RUN_ROWS);
        });
    }, 60_000);
});

async function measureDisconnect(setupSql: PSqlSql, sql: PSqlSql, runId: string): Promise<void> {
    const scope: StateScope = { applicationId: 'disconnect-statements-test', workspaceId: runId };
    const log: PostgresStatementLog = { statements: [], transactions: 0 };
    const runtime = createPostgresAppInboxWorkerRuntime({
        sql: recordPostgresStatements(sql, log, null),
        serviceId: 'disconnect-statements',
        newLaneHeldRows: undefined,
        atEpochMs: Date.now(),
        trace: createPostgresAppInboxWorkerTrace()
    });
    const authSession = toAuthSession(runId);
    await runtime.authSessions.putSession(authSession);
    const input = { ...scope, clientInstanceId: 'browser', connectedAtEpochMs: Date.now() };
    const connection = toAuthorisedWsClientConnection({ authSession, generationId: `${runId}-generation`, input });
    const connected = await runtime.runUntilCompletion(async () =>
        await runtime.client.writeAuthorisedWsClientConnect({
            authSession,
            generationId: connection.generationId,
            ticketDigest: await putAuthorisedWsTestTicket(runtime.authSessions, authSession),
            holderId: runId,
            traceId: 'trace-authorised-ws-disconnect-statements',
            input
        })
    );
    expect(connected.right?.status).toBe('ok');
    expect(await readHeldGenerations(setupSql, runId)).toEqual([connection.generationId]);
    log.statements.length = 0;

    await runtime.client.enqueueAuthorisedWsClientDisconnect({
        connection,
        disconnectedAtEpochMs: Date.now(),
        reason: 'socket-closed'
    });
    await runtime.dequeueUntilSettled(waitUntilReleased(setupSql, runId));

    const transaction = requireDisconnectTransaction(log);
    const reads = log.statements.slice(0, log.statements.indexOf(transaction[0]!)).filter((statement) =>
        statement.transaction === null && statement.text.includes('runtime_state_store')
    );
    expect(reads.filter((statement) => namesValue(statement, HOLDERS_NAMESPACE))).toHaveLength(1);
    expect(transaction.filter((statement) => namesValue(statement, HOLDERS_NAMESPACE)).map(({ text }) => text.split(' ', 1)[0]))
        .toEqual(['delete']);
    expect(reads.length).toBe(UNRECORDED_DISCONNECT_RUNTIME_STATE_READS + 1);
    expect(transaction.length).toBe(UNRECORDED_DISCONNECT_TRANSACTION_STATEMENTS + 1);
    expect(await readHeldGenerations(setupSql, runId)).toEqual([]);
}

function toAuthSession(runId: string): IssuedAuthSession {
    const nowEpochMs = Date.now();
    return {
        clientId: 'bob',
        username: 'bob',
        sessionId: `bob-${runId}`,
        accessToken: 'bob-disconnect-statements-token',
        issuedAtEpochMs: nowEpochMs - 1_000,
        expiresAtEpochMs: nowEpochMs + 60 * 60 * 1_000
    };
}

/** The disconnect's transaction is the one that writes the generation's close high-water row. */
function requireDisconnectTransaction(log: PostgresStatementLog): readonly RecordedPostgresStatement[] {
    const closeWrite = log.statements.find((statement) => statement.transaction !== null && namesValue(statement, CLOSE_HIGH_WATER_NAMESPACE));
    if (closeWrite === undefined) {
        throw new Error('The disconnect wrote no close high-water row inside a transaction');
    }
    return log.statements.filter(({ transaction }) => transaction === closeWrite.transaction);
}

function namesValue(statement: RecordedPostgresStatement, value: string): boolean {
    return JSON.stringify(statement.values).includes(value);
}

async function readHeldGenerations(sql: PSqlSql, holderId: string): Promise<readonly string[]> {
    const page = await createWsConnectionHolderRecordReader({ repository: new PSqlRuntimeStateRepository(sql), nowMs: Date.now })
        .readHolderPage({ holderId, afterKey: null, limit: 100 });
    return page.records.map((entry) => entry.record.connection.generationId);
}

async function waitUntilReleased(sql: PSqlSql, runId: string): Promise<void> {
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
        const [row] = await sql<Array<{ status: string | null; }>>`
            select store_value::jsonb ->> 'status' as status
            from runtime_state_store
            where store_namespace = 'client-state:sessions' and store_key like ${`%bob-${runId}%`}
        `;
        if (row?.status === 'disconnected') {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('The disconnect did not complete');
}
