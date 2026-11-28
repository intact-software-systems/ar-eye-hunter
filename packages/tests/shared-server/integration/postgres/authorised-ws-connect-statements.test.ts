import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { AUTH_SESSIONS_BY_SESSION_NAMESPACE } from '@shared-server/rallar-system/auth/persistence/auth-storage-keys.ts';
import { createWsConnectionHolderRecordReader } from '@shared-server/rallar-system/client-state/connection-holder/ws-connection-holder-record-reader.ts';
import { PSqlRtcTopologyDeliveryRepository } from '@shared-server/rallar-system/topology/replay/postgres/p-sql-rtc-topology-delivery-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import { createApiV1WsConnectionHolderLeases } from '../../../../../apps/api-v1/src/composition/create-api-v1-ws-connection-holder-leases.ts';
import { isAppOutboxSidecarInsert } from '../../rallar-system/app-inbox/test-support/create-app-inbox-test-database-sql.ts';
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

const LIVE_LEASE_MS = 30_000;

interface ConnectStatementsRun {
    readonly setupSql: PSqlSql;
    readonly sql: PSqlSql;
    /** A UUID that marks every row the run writes; it is also the connecting process's holder id. */
    readonly runId: string;
}

describe('Postgres authorised WebSocket connect statements', () => {
    postgresIt('reads a co-member connect in one lease read and at most seven runtime-state statements, and writes it in at most five', async () => {
        await withConnectStatementsRun(async (run) => {
            await registerHolderStream(run.setupSql, run.runId, LIVE_LEASE_MS);
            await measureCoMemberConnect(run);
        });
    }, 60_000);

    postgresIt('answers a connect whose holder\'s lease has lapsed inactive', async () => {
        await withConnectStatementsRun(async ({ setupSql, sql, runId }) => {
            await registerHolderStream(setupSql, runId, 1);
            await new Promise((resolve) => setTimeout(resolve, 20));
            const runtime = createConnectRuntime(sql, 'connect-lapsed-holder');
            const connect = await prepareConnect(runtime, toConnectScope(runId), toAuthSession('bob', Date.now(), runId));

            expect(await connect(runId)).toBe('inactive');
            expect(await readHeldGenerations(setupSql, runId)).toEqual([]);
        });
    }, 60_000);

    postgresIt('records the enqueuing process as holder when another worker runs the connect', async () => {
        await withConnectStatementsRun(async ({ setupSql, sql, runId }) => {
            await registerHolderStream(setupSql, runId, LIVE_LEASE_MS);
            const enqueuing = createConnectRuntime(sql, 'connect-enqueuer');
            const worker = createConnectRuntime(sql, 'connect-worker');
            const authSession = toAuthSession('bob', Date.now(), runId);
            await enqueuing.authSessions.putSession(authSession);
            const ticketDigest = await putAuthorisedWsTestTicket(enqueuing.authSessions, authSession);

            const result = await worker.dequeueUntilSettled(enqueuing.client.writeAuthorisedWsClientConnect({
                authSession,
                generationId: `${authSession.sessionId}-generation`,
                ticketDigest,
                holderId: runId,
                traceId: 'trace-authorised-ws-connect-statements',
                input: { ...toConnectScope(runId), clientInstanceId: 'browser', connectedAtEpochMs: Date.now() }
            }));

            expect(result.right?.status).toBe('ok');
            expect(await readHeldGenerations(setupSql, runId)).toEqual([`${authSession.sessionId}-generation`]);
            expect(await readHeldGenerations(setupSql, crypto.randomUUID())).toEqual([]);
        });
    }, 60_000);
});

async function withConnectStatementsRun(test: (run: ConnectStatementsRun) => Promise<void>): Promise<void> {
    await withPostgresClients({
        namespace: null,
        clientCount: 2,
        createClient: async () => await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl(), 4)
    }, async (clients) => {
        const setupSql = requirePostgresClient(clients, 0);
        const runId = crypto.randomUUID();
        try {
            await test({ setupSql, sql: requirePostgresClient(clients, 1), runId });
        }
        finally {
            await deletePostgresRunRows(setupSql, runId);
            await setupSql`delete from rtc_topology_delivery_stream where stream_id = ${runId}::uuid`;
        }
        expect(await readPostgresRunRowCounts(setupSql, runId)).toEqual(NO_POSTGRES_RUN_ROWS);
    });
}

/** Connects alice, then measures bob's connect as her co-member; every row it writes carries the run id. */
async function measureCoMemberConnect({ setupSql, sql, runId }: ConnectStatementsRun): Promise<void> {
    const atEpochMs = Date.now();
    const scope = toConnectScope(runId);
    await seedGroupFormation({
        sql: setupSql,
        scope,
        activeMemberIds: ['bob'],
        atEpochMs,
        requestIdFor: createPostgresTestRequestIdFactory()
    });
    const log: PostgresStatementLog = { statements: [], transactions: 0 };
    const runtime = createConnectRuntime(recordPostgresStatements(sql, log, null), 'connect-statements');
    const bob = toAuthSession('bob', atEpochMs, runId);
    expect(await (await prepareConnect(runtime, scope, toAuthSession('alice', atEpochMs, runId)))(runId)).toBe('ok');
    const bobConnect = await prepareConnect(runtime, scope, bob);
    log.statements.length = 0;

    expect(await bobConnect(runId)).toBe('ok');

    const connectTransaction = requireConnectTransaction(log);
    const beforeTransaction = log.statements.slice(0, log.statements.indexOf(connectTransaction[0]!));
    const reads = beforeTransaction.filter((statement) => statement.transaction === null && statement.text.includes('runtime_state_store'));
    const leaseReads = log.statements.filter(({ text }) => text.includes('rtc_topology_delivery_stream'));
    // The holder's lease is one primary-key read of the stream table, in the read phase and never in the transaction.
    expect(leaseReads).toHaveLength(1);
    expect(leaseReads[0]!.transaction).toBeNull();
    expect(beforeTransaction).toContain(leaseReads[0]);
    // Runtime-state statements only, under the worker runtime's cache-less group read (no current-snapshot cache).
    expect(reads.length, reads.map(({ text }) => text.slice(0, 80)).join('\n')).toBeLessThanOrEqual(7);
    expect(countValueOccurrences(reads, AUTH_SESSIONS_BY_SESSION_NAMESPACE)).toBe(1);
    expect(connectTransaction.length, connectTransaction.map(({ text }) => text.slice(0, 80)).join('\n'))
        .toBeLessThanOrEqual(5);
    // The principal event is ordered, so the outbox rows go in with its track index row and the proofs as one tracked insert.
    const outboxInserts = connectTransaction.filter(({ text }) => isAppOutboxSidecarInsert(text));
    expect(outboxInserts).toHaveLength(1);
    // Three outbox rows, the event's track index row and the three proofs.
    expect(outboxInserts[0]!.rowCount).toBe(7);
    expect(await readHeldGenerations(setupSql, runId)).toEqual([
        `${toAuthSession('alice', atEpochMs, runId).sessionId}-generation`,
        `${bob.sessionId}-generation`
    ].toSorted());
}

/** A worker runtime whose connects read the holder's lease with the production function over its own client. */
function createConnectRuntime(sql: PSqlSql, serviceId: string): PostgresAppInboxWorkerRuntime {
    return createPostgresAppInboxWorkerRuntime({
        sql,
        serviceId,
        newLaneHeldRows: undefined,
        atEpochMs: Date.now(),
        holderLeases: createApiV1WsConnectionHolderLeases(sql),
        trace: createPostgresAppInboxWorkerTrace()
    });
}

async function registerHolderStream(sql: PSqlSql, holderId: string, leaseDurationMs: number): Promise<void> {
    const registered = await new PSqlRtcTopologyDeliveryRepository(sql).registerStream({
        streamId: holderId,
        leaseDurationMs
    });
    expect(registered.status).toBe('registered');
}

async function readHeldGenerations(sql: PSqlSql, holderId: string): Promise<readonly string[]> {
    const page = await createWsConnectionHolderRecordReader({ repository: new PSqlRuntimeStateRepository(sql), nowMs: Date.now })
        .readHolderPage({ holderId, afterKey: null, limit: 100 });
    return page.records.map((entry) => entry.record.connection.generationId);
}

function toConnectScope(runId: string): StateScope {
    return { applicationId: 'connect-statements-test', workspaceId: runId };
}

/** Stores the session and its ticket, and returns the connect that consumes them. */
async function prepareConnect(
    runtime: PostgresAppInboxWorkerRuntime,
    scope: StateScope,
    authSession: IssuedAuthSession
): Promise<(holderId: string) => Promise<string | undefined>> {
    await runtime.authSessions.putSession(authSession);
    const ticketDigest = await putAuthorisedWsTestTicket(runtime.authSessions, authSession);
    return async (holderId) => {
        const result = await runtime.runUntilCompletion(() =>
            runtime.client.writeAuthorisedWsClientConnect({
                authSession,
                generationId: `${authSession.sessionId}-generation`,
                ticketDigest,
                holderId,
                traceId: 'trace-authorised-ws-connect-statements',
                input: { ...scope, clientInstanceId: 'browser', connectedAtEpochMs: Date.now() }
            })
        );
        return result.right?.status;
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
