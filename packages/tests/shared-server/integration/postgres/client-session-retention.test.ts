import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { ClientAuthorisedWsSessionConnectAppInboxPayload } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-contracts.ts';
import { toAuthorisedWsClientConnection } from '@shared-server/rallar-system/client-state/inbox/authorised-ws-client-app-inbox.ts';
import { CLIENT_STATE_SESSIONS_NAMESPACE } from '@shared-server/rallar-system/client-state/persistence/client-state-runtime-namespaces.ts';
import { clientStateSessionStorageKey } from '@shared-server/rallar-system/client-state/persistence/client-state-session-storage-key.ts';
import { toSessionPurgeAfterEpochMs } from '@shared-server/rallar-system/presence/session-expiry.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { ClientSession } from '@shared/api/client-types.ts';
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
    createPostgresAppInboxWorkerTrace,
    type PostgresAppInboxWorkerRuntime
} from './test-support/postgres-app-inbox-worker-runtime.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;
const DAY_MS = 24 * 60 * 60 * 1_000;

interface RetentionHarness {
    /** Carried by every scope, session and ticket this test writes, so its rows can be found and removed. */
    readonly runId: string;
    readonly sql: PSqlSql;
    readonly runtime: PostgresAppInboxWorkerRuntime;
    readonly scope: StateScope;
    readonly nowEpochMs: number;
}

interface StoredClientSession {
    readonly session: ClientSession;
    readonly expireAtEpochMs: number;
}

describe('Postgres disconnected client session retention', () => {
    postgresIt('purges a session disconnected beyond the retention and keeps one inside it', async () => {
        await withRetentionHarness(async (harness) => {
            const expired = await connectAndDisconnect(harness, 'expired', harness.nowEpochMs - 8 * DAY_MS);
            const retained = await connectAndDisconnect(harness, 'retained', harness.nowEpochMs - 6 * DAY_MS);

            // The expiry sweep's statement, scoped to the client session namespace rather than the shared database.
            await new PSqlRuntimeStateRepository(harness.sql).deleteExpired(CLIENT_STATE_SESSIONS_NAMESPACE);

            expect(await readStoredSession(harness, expired)).toBeUndefined();
            const kept = await readStoredSession(harness, retained);
            expect(kept?.session.status).toBe('disconnected');
            expect(kept?.expireAtEpochMs).toBe(harness.nowEpochMs - 6 * DAY_MS + 7 * DAY_MS);
        });
    }, 60_000);

    postgresIt('still fences a reconnect inside the retention by its generation', async () => {
        await withRetentionHarness(async (harness) => {
            const disconnectedAtEpochMs = harness.nowEpochMs - 6 * DAY_MS;
            const connection = await connectAndDisconnect(harness, 'fenced', disconnectedAtEpochMs);

            await connect(harness, { ...connection, generationId: 'stale-generation' }, disconnectedAtEpochMs - 2_000);
            const fenced = await readStoredSession(harness, connection);
            expect(fenced?.session).toMatchObject({ generationId: connection.generationId, status: 'disconnected' });

            await connect(harness, { ...connection, generationId: 'newer-generation' }, harness.nowEpochMs);
            const replaced = await readStoredSession(harness, connection);
            expect(replaced?.session).toMatchObject({
                generationId: 'newer-generation',
                generationVersion: 2,
                status: 'active'
            });
            expect(replaced?.expireAtEpochMs).toBe(toSessionPurgeAfterEpochMs(connection.authSession.expiresAtEpochMs, null));
        });
    }, 60_000);
});

async function withRetentionHarness(run: (harness: RetentionHarness) => Promise<void>): Promise<void> {
    await withPostgresClients({
        namespace: null,
        clientCount: 1,
        createClient: async () => await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl(), 4)
    }, async (clients) => {
        const sql = requirePostgresClient(clients, 0);
        const nowEpochMs = Date.now();
        const runId = crypto.randomUUID();
        try {
            await run({
                runId,
                sql,
                nowEpochMs,
                scope: { applicationId: 'client-session-retention-test', workspaceId: runId },
                runtime: createPostgresAppInboxWorkerRuntime({
                    sql,
                    serviceId: 'client-session-retention',
                    newLaneHeldRows: undefined,
                    atEpochMs: nowEpochMs,
                    trace: createPostgresAppInboxWorkerTrace()
                })
            });
        }
        finally {
            await deletePostgresRunRows(sql, runId);
        }
        expect(await readPostgresRunRowCounts(sql, runId)).toEqual(NO_POSTGRES_RUN_ROWS);
    });
}

/** A session that connected one second before it disconnected at the given instant. */
async function connectAndDisconnect(
    harness: RetentionHarness,
    principalId: string,
    disconnectedAtEpochMs: number
): Promise<ClientAuthorisedWsSessionConnectAppInboxPayload> {
    const authSession: IssuedAuthSession = {
        clientId: principalId,
        username: principalId,
        sessionId: `${principalId}-${harness.runId}`,
        accessToken: `${principalId}-retention-token`,
        issuedAtEpochMs: harness.nowEpochMs - 9 * DAY_MS,
        expiresAtEpochMs: harness.nowEpochMs + 21 * DAY_MS
    };
    await harness.runtime.authSessions.putSession(authSession);
    const connection = toAuthorisedWsClientConnection({
        authSession,
        generationId: `${principalId}-generation`,
        input: { ...harness.scope, clientInstanceId: 'browser', connectedAtEpochMs: disconnectedAtEpochMs - 1_000 }
    });
    await connect(harness, connection, disconnectedAtEpochMs - 1_000);
    await harness.runtime.client.enqueueAuthorisedWsClientDisconnect({
        connection,
        disconnectedAtEpochMs,
        reason: 'closed'
    });
    await harness.runtime.dequeueUntilSettled(waitForDisconnected(harness, connection));
    return connection;
}

async function connect(
    harness: RetentionHarness,
    connection: ClientAuthorisedWsSessionConnectAppInboxPayload,
    connectedAtEpochMs: number
): Promise<void> {
    const authSession = { ...connection.authSession, accessToken: `${connection.principalId}-retention-token` };
    const ticketDigest = await putAuthorisedWsTestTicket(
        harness.runtime.authSessions,
        authSession,
        `${connection.generationId}-${harness.runId}`
    );
    await harness.runtime.runUntilCompletion(() =>
        harness.runtime.client.writeAuthorisedWsClientConnect({
            authSession,
            generationId: connection.generationId,
            ticketDigest,
            traceId: 'trace-client-session-retention',
            input: { ...harness.scope, clientInstanceId: connection.clientInstanceId, connectedAtEpochMs }
        })
    );
}

async function waitForDisconnected(
    harness: RetentionHarness,
    connection: ClientAuthorisedWsSessionConnectAppInboxPayload
): Promise<void> {
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
        const stored = await readStoredSession(harness, connection);
        if (stored?.session.status === 'disconnected') {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`The ${connection.principalId} session never disconnected`);
}

async function readStoredSession(
    harness: RetentionHarness,
    connection: ClientAuthorisedWsSessionConnectAppInboxPayload
): Promise<StoredClientSession | undefined> {
    const key = clientStateSessionStorageKey({
        ...connection.scope,
        principalId: connection.principalId,
        clientInstanceId: connection.clientInstanceId,
        sessionId: connection.authSession.sessionId
    });
    const [row] = await harness.sql<{ store_value: string; expire_at_epoch_ms: string; }[]>`
        select store_value, round(extract(epoch from expire_at_ts) * 1000)::bigint::text as expire_at_epoch_ms
        from runtime_state_store
        where store_namespace = ${CLIENT_STATE_SESSIONS_NAMESPACE} and store_key = ${key}
    `;
    return row === undefined
        ? undefined
        : { session: JSON.parse(row.store_value) as ClientSession, expireAtEpochMs: Number(row.expire_at_epoch_ms) };
}
