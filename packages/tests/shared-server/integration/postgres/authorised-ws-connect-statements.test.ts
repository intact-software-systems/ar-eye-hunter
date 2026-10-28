import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { AUTH_SESSIONS_BY_SESSION_NAMESPACE } from '@shared-server/rallar-system/auth/persistence/auth-storage-keys.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import { putAuthorisedWsTestTicket } from '../../rallar-system/client-state/authorised-ws-test-ticket.ts';
import {
    createRuntimeStatePostgresSql,
    requirePostgresClient,
    requirePostgresDatabaseUrl,
    withPostgresClients
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import { createPostgresTestRequestIdFactory } from './test-support/create-postgres-test-request-id-factory.ts';
import {
    deletePostgresRunRows,
    NO_POSTGRES_RUN_ROWS,
    readPostgresRunRowCounts
} from './test-support/delete-postgres-run-rows.ts';
import {
    createPostgresAppInboxWorkerRuntime,
    createPostgresAppInboxWorkerTrace,
    type PostgresAppInboxWorkerRuntime
} from './test-support/postgres-app-inbox-worker-runtime.ts';
import { seedGroupFormation } from './test-support/postgres-group-formation-fixture.ts';
import {
    recordPostgresStatements,
    type PostgresStatementLog,
    type RecordedPostgresStatement
} from './test-support/record-postgres-statements.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('Postgres authorised WebSocket connect statements', () => {
    postgresIt('reads a co-member connect in at most seven statements and writes it in at most five', async () => {
        await withPostgresClients({
            namespace: null,
            clientCount: 2,
            createClient: async () => await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl(), 4)
        }, async (clients) => {
            const setupSql = requirePostgresClient(clients, 0);
            const sql = requirePostgresClient(clients, 1);
            const runId = crypto.randomUUID();
            try {
                await measureCoMemberConnect(setupSql, sql, runId);
            }
            finally {
                await deletePostgresRunRows(setupSql, runId);
            }
            expect(await readPostgresRunRowCounts(setupSql, runId)).toEqual(NO_POSTGRES_RUN_ROWS);
        });
    }, 60_000);
});

/** Connects alice, then measures bob's connect as her co-member; every row it writes carries the run id. */
async function measureCoMemberConnect(setupSql: PSqlSql, sql: PSqlSql, runId: string): Promise<void> {
    const atEpochMs = Date.now();
    const scope: StateScope = { applicationId: 'connect-statements-test', workspaceId: runId };
    await seedGroupFormation({
        sql: setupSql,
        scope,
        activeMemberIds: ['bob'],
        atEpochMs,
        requestIdFor: createPostgresTestRequestIdFactory()
    });
    const log: PostgresStatementLog = { statements: [], transactions: 0 };
    const runtime = createPostgresAppInboxWorkerRuntime({
        sql: recordPostgresStatements(sql, log, null),
        serviceId: 'connect-statements',
        newLaneHeldRows: undefined,
        atEpochMs,
        trace: createPostgresAppInboxWorkerTrace()
    });
    await (await prepareConnect(runtime, scope, toAuthSession('alice', atEpochMs, runId)))();
    const bobConnect = await prepareConnect(runtime, scope, toAuthSession('bob', atEpochMs, runId));
    log.statements.length = 0;

    await bobConnect();

    const connectTransaction = requireConnectTransaction(log);
    const reads = log.statements.filter((statement) =>
        statement.transaction === null &&
        statement.text.includes('runtime_state_store') &&
        log.statements.indexOf(statement) < log.statements.indexOf(connectTransaction[0]!)
    );
    // Runtime-state statements only, under the worker runtime's cache-less group read (no current-snapshot cache).
    expect(reads.length, reads.map(({ text }) => text.slice(0, 80)).join('\n')).toBeLessThanOrEqual(7);
    expect(countValueOccurrences(reads, AUTH_SESSIONS_BY_SESSION_NAMESPACE)).toBe(1);
    expect(connectTransaction.length, connectTransaction.map(({ text }) => text.slice(0, 80)).join('\n'))
        .toBeLessThanOrEqual(5);
    const outboxInserts = connectTransaction.filter(({ text }) => text.startsWith('insert into resource_inbox ('));
    expect(outboxInserts).toHaveLength(1);
    expect(outboxInserts[0]!.rowCount).toBe(3);
}

/** Stores the session and its ticket, and returns the connect that consumes them. */
async function prepareConnect(
    runtime: PostgresAppInboxWorkerRuntime,
    scope: StateScope,
    authSession: IssuedAuthSession
): Promise<() => Promise<void>> {
    await runtime.authSessions.putSession(authSession);
    const ticketDigest = await putAuthorisedWsTestTicket(runtime.authSessions, authSession);
    return async () => {
        const result = await runtime.runUntilCompletion(() =>
            runtime.client.writeAuthorisedWsClientConnect({
                authSession,
                generationId: `${authSession.sessionId}-generation`,
                ticketDigest,
                traceId: 'trace-authorised-ws-connect-statements',
                input: { ...scope, clientInstanceId: 'browser', connectedAtEpochMs: Date.now() }
            })
        );
        expect(result.right?.status).toBe('ok');
    };
}

function toAuthSession(principalId: string, atEpochMs: number, runId: string): IssuedAuthSession {
    return {
        clientId: principalId,
        username: principalId,
        sessionId: `${principalId}-${runId}`,
        accessToken: `${principalId}-connect-statements-token`,
        issuedAtEpochMs: atEpochMs - 1_000,
        expiresAtEpochMs: atEpochMs + 60 * 60 * 1_000
    };
}

function requireConnectTransaction(log: PostgresStatementLog): readonly RecordedPostgresStatement[] {
    const eventInsert = log.statements.find(({ text }) => text.startsWith('insert into client_state_events'));
    if (eventInsert?.transaction === null || eventInsert === undefined) {
        throw new Error('The connect wrote no client event inside a transaction');
    }
    return log.statements.filter(({ transaction }) => transaction === eventInsert.transaction);
}

function countValueOccurrences(statements: readonly RecordedPostgresStatement[], text: string): number {
    return statements.reduce(
        (count, statement) => count + (JSON.stringify(statement.values).split(text).length - 1),
        0
    );
}
