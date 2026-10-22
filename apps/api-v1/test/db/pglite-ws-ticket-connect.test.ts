import { Temporal } from '@js-temporal/polyfill';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import { PSqlClientStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { pauseNextAuthorisedWsConnectRead } from '../../../../packages/tests/shared-server/rallar-system/app-inbox/test-support/app-inbox-ws-close-test-harness.ts';
import { TEST_APP_INBOX_FINISHED_RETENTION_MS } from '../../../../packages/tests/shared-server/rallar-system/app-inbox/test-support/test-app-inbox-finished-retention.ts';
import { putAuthorisedWsTestTicket } from '../../../../packages/tests/shared-server/rallar-system/client-state/authorised-ws-test-ticket.ts';
import { TEST_DISCONNECTED_SESSION_RETENTION_MS } from '../../../../packages/tests/shared-server/rallar-system/client-state/test-disconnected-session-retention.ts';
import { TestWebSocket } from '../../../../packages/tests/shared/websocket/test-web-socket.ts';
import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';
import { registerWsRoutes } from '../../src/routes/ws-routes.ts';
import { releaseAuthorisedWsCloseFacts } from '../../src/runtime/rtc-topology/authorised-ws-connection-registry.ts';
import { createApiV1TestQueueResilience } from '../api-v1-test-queue-resilience.ts';
import { createPGliteAppInboxWsCloseHarness } from './pglite-app-inbox-ws-close-test-harness.ts';
import { FUTURE_MS, withPGliteSql } from './pglite-auth-test-harness.ts';

const OPTIONS = { waitMaxElapsedMsecs: 5_000, waitRetryIntervalMsecs: 1, waitMaxRetryIntervalMsecs: 4, waitJitterRatio: 0 } as const;
const SESSION: IssuedAuthSession = {
    clientId: 'player',
    username: 'player',
    sessionId: 'player-session',
    accessToken: 'player-token',
    issuedAtEpochMs: Date.now() - 1_000,
    expiresAtEpochMs: FUTURE_MS
};

interface WsConnectFixture {
    readonly sql: PGliteSql;
    readonly sessions: AuthSessionRepository;
    readonly reader: InboxQueueReader;
    readonly socketServer: JsonWebSocketServer;
    readonly clients: ClientStateRepository;
    readonly upgradedSockets: TestWebSocket[];
    readonly app: Hono;
}

interface QueuedRow {
    readonly type: string;
    readonly status: string;
}

async function createWsConnectFixture(
    sql: PGliteSql,
    upgrade: (sockets: TestWebSocket[]) => Deno.WebSocketUpgrade = upgradeToTestSocket
): Promise<WsConnectFixture> {
    const runtime = new PSqlRuntimeStateRepository(sql);
    const resourceInbox = createPSqlResourceInboxRepository(sql, () => new Date());
    const results = new ResourceInboxResultsRepository(sql);
    const reader = new InboxQueueReader(new PSqlQueueBox(resourceInbox, Temporal.Now.instant), {
        newLaneConcurrency: 1
    });
    const sessions = new AuthSessionRepository(runtime);
    await sessions.putSession(SESSION);
    const events = new PSqlClientStateEventRepository(sql);
    const client = new AppClientInboxService({
        inboxQueueReader: reader,
        resourceInboxRepository: resourceInbox.entries,
        resourceInboxResultsRepository: results,
        database: sql,
        clientStateService: createClientStateService({
            runtimeRepository: runtime,
            clientStateEventStore: events,
            serviceId: 'ws-ticket-connect'
        })
    }, {
        finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS,
        serviceId: 'ws-ticket-connect',
        disconnectedSessionRetentionMs: TEST_DISCONNECTED_SESSION_RETENTION_MS,
        timing: undefined,
        options: OPTIONS
    });
    const socketServer = new JsonWebSocketServer();
    const upgradedSockets: TestWebSocket[] = [];
    const app = new Hono();
    registerWsRoutes(app, {
        socketServer,
        appClientInboxService: client,
        readWsConnectTicket: async (ticketDigest) => (await sessions.findWebSocketTicketByDigestEntry(ticketDigest))?.value,
        readWsConnectSession: (sessionId) => sessions.findBySessionId(sessionId),
        upgradeWebSocket: () => upgrade(upgradedSockets),
        nowEpochMs: Date.now
    });
    return {
        sql,
        sessions,
        reader,
        socketServer,
        clients: new ClientStateRepository(runtime, events),
        upgradedSockets,
        app
    };
}

function upgradeToTestSocket(sockets: TestWebSocket[]): Deno.WebSocketUpgrade {
    const socket = new TestWebSocket('ws://player');
    sockets.push(socket);
    return { socket, response: new Response(null, { status: 200, headers: { 'x-test-upgrade': 'switched' } }) };
}

/** Drives the lane the way the server's queue engine does while the upgrade request waits for its connect. */
async function requestUpgrade(fixture: WsConnectFixture, ticket: string): Promise<Response> {
    let settled = false;
    const response = Promise.resolve(fixture.app.request(`http://localhost/api/ws/${SESSION.sessionId}?ticket=${ticket}`, {
        headers: { upgrade: 'websocket' }
    })).finally(() => {
        settled = true;
    });
    while (!settled) {
        await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createApiV1TestQueueResilience());
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return await response;
}

async function readQueuedRows(sql: PGliteSql): Promise<readonly QueuedRow[]> {
    const rows = await sql<{ ri_status: string; ri_resource: string; }[]>`
        select ri_status, ri_resource from resource_inbox where ri_type_id = 'APP_INBOX' order by ri_row_id
    `;
    return rows.map((row) => {
        const message = JSON.parse(row.ri_resource) as { payload: { typeId: string; }; };
        return { type: message.payload.typeId, status: row.ri_status };
    });
}

async function readActiveSessionIds(fixture: WsConnectFixture): Promise<readonly string[]> {
    const snapshot = await fixture.clients.readSnapshot({
        applicationId: DEFAULT_STATE_APPLICATION_ID,
        workspaceId: DEFAULT_STATE_WORKSPACE_ID,
        principalId: SESSION.clientId
    });
    return snapshot?.activeSessions.map((session) => session.sessionId) ?? [];
}

function releaseRegisteredFacts(fixture: WsConnectFixture): void {
    const connection = fixture.socketServer.connections.get(SESSION.sessionId);
    if (connection !== undefined) {
        releaseAuthorisedWsCloseFacts({
            sessionId: connection.id,
            generationId: connection.generationId,
            generationStartedAtEpochMs: connection.generationStartedAtEpochMs,
            disconnectedAtEpochMs: Date.now(),
            reason: 'test-finished'
        });
    }
}

Deno.test('a WebSocket connect consumes its ticket in its own transaction: one lane item per player, registered after the commit', async () => {
    await withPGliteSql(async (sql) => {
        const fixture = await createWsConnectFixture(sql);
        const ticketDigest = await putAuthorisedWsTestTicket(fixture.sessions, SESSION, 'player-ticket');
        const before = sql.getExecutorCounters?.().statements ?? 0;

        const response = await requestUpgrade(fixture, 'player-ticket');
        const statements = (sql.getExecutorCounters?.().statements ?? 0) - before;

        assert.equal(response.headers.get('x-test-upgrade'), 'switched');
        assert.deepEqual(await readQueuedRows(sql), [{ type: 'CLIENT_AUTHORISED_WS_CONNECT', status: 'COMPLETED' }]);
        assert.deepEqual(await fixture.sessions.readWebSocketTicketByDigestEntry(ticketDigest), {
            value: undefined,
            expiredEntry: undefined
        });
        assert.equal(fixture.socketServer.connections.get(SESSION.sessionId)?.socket, fixture.upgradedSockets[0]);
        assert.deepEqual(await readActiveSessionIds(fixture), [SESSION.sessionId]);
        // Until the client completes the handshake, the connect's own outbox rows wait for this socket.
        assert.equal(fixture.socketServer.expectedConnections.isAwaiting(SESSION.sessionId), true);
        fixture.upgradedSockets[0]?.open();
        assert.equal(fixture.socketServer.expectedConnections.isAwaiting(SESSION.sessionId), false);
        // The separate ticket-consume lane item cost 46 statements together with the connect (D269 baseline).
        assert.ok(statements < 46, `the connect issued ${statements} statements`);
        console.info(`WebSocket connect statements per player: ${statements}`);
        releaseRegisteredFacts(fixture);
    });
});

Deno.test('a garbage, expired or foreign ticket for a known session is answered 401 without touching its lane', async () => {
    await withPGliteSql(async (sql) => {
        const fixture = await createWsConnectFixture(sql);
        await fixture.sessions.putSession({ ...SESSION, clientId: 'other-player', sessionId: 'other-session' });
        await fixture.sessions.putWebSocketTicket({
            ticket: 'foreign-ticket',
            sessionId: 'other-session',
            clientId: 'other-player',
            issuedAtEpochMs: Date.now() - 1,
            expiresAtEpochMs: FUTURE_MS
        });
        await fixture.sessions.putWebSocketTicket({
            ticket: 'expired-ticket',
            sessionId: SESSION.sessionId,
            clientId: SESSION.clientId,
            issuedAtEpochMs: Date.now() - 2_000,
            expiresAtEpochMs: Date.now() - 1_000
        });

        for (const ticket of ['garbage-ticket', 'foreign-ticket', 'expired-ticket']) {
            const response = await requestUpgrade(fixture, ticket);
            assert.equal(response.status, 401, ticket);
            assert.deepEqual(await response.json(), { error: 'Unauthorized: Invalid or expired websocket auth ticket' });
        }

        assert.deepEqual(await readQueuedRows(sql), []);
        assert.equal(fixture.upgradedSockets.length, 0);
        assert.equal(fixture.socketServer.expectedConnections.isAwaiting(SESSION.sessionId), false);
    });
});

Deno.test('a replayed WebSocket ticket is answered 401 and never upgrades or displaces the live socket', async () => {
    await withPGliteSql(async (sql) => {
        const fixture = await createWsConnectFixture(sql);
        await putAuthorisedWsTestTicket(fixture.sessions, SESSION, 'player-ticket');
        const live = await requestUpgrade(fixture, 'player-ticket');
        fixture.upgradedSockets[0]?.open();
        const liveConnection = fixture.socketServer.connections.get(SESSION.sessionId);

        const replay = await requestUpgrade(fixture, 'player-ticket');

        assert.equal(live.headers.get('x-test-upgrade'), 'switched');
        assert.equal(replay.status, 401);
        assert.deepEqual(await replay.json(), { error: 'Unauthorized: Invalid or expired websocket auth ticket' });
        assert.equal(fixture.upgradedSockets.length, 1);
        assert.equal(fixture.socketServer.connections.get(SESSION.sessionId), liveConnection);
        assert.equal(fixture.upgradedSockets[0]?.closedWith, undefined);
        assert.equal(fixture.socketServer.expectedConnections.isAwaiting(SESSION.sessionId), false);
        // The consumed ticket is refused at the route: the replay costs the session's lane nothing.
        assert.deepEqual(await readQueuedRows(sql), [{ type: 'CLIENT_AUTHORISED_WS_CONNECT', status: 'COMPLETED' }]);
        assert.deepEqual(await readActiveSessionIds(fixture), [SESSION.sessionId]);
        releaseRegisteredFacts(fixture);
    });
});

Deno.test('two upgrades racing on one ticket: the conditional delete admits exactly one', async () => {
    await withPGliteSql(async (sql) => {
        const fixture = await createWsConnectFixture(sql);
        await putAuthorisedWsTestTicket(fixture.sessions, SESSION, 'player-ticket');

        const statuses = (await Promise.all([
            requestUpgrade(fixture, 'player-ticket'),
            requestUpgrade(fixture, 'player-ticket')
        ])).map((response) => response.status).toSorted();

        assert.deepEqual(statuses, [200, 401]);
        assert.equal(fixture.upgradedSockets.length, 1);
        releaseRegisteredFacts(fixture);
    });
});

Deno.test('a connect whose ticket was spent after its read conflicts on the guarded delete and its retry is rejected', async () => {
    await withPGliteSql(async (sql) => {
        const harness = await createPGliteAppInboxWsCloseHarness(sql);
        const sessions = new AuthSessionRepository(harness.runtime);
        const ticketDigest = await putAuthorisedWsTestTicket(sessions, harness.authority, 'shared-ticket');
        const connectInScope = (applicationId: string, generationId: string) =>
            harness.client.writeAuthorisedWsClientConnect({
                authSession: harness.authority,
                generationId,
                ticketDigest,
                input: { applicationId, workspaceId: 'default', connectedAtEpochMs: Date.now() }
            });
        // Different scopes are different lanes: the stale connect holds its ticket read while the other spends it.
        const pause = pauseNextAuthorisedWsConnectRead(harness.clientState);
        const stale = connectInScope('scope-stale', 'generation-stale');
        const staleKey = await waitForQueuedConnectKey(harness.reader, sql, 'generation-stale');
        const staleAttempt = harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createApiV1TestQueueResilience());
        await pause.reached;
        const winner = connectInScope('scope-winner', 'generation-winner');
        await waitForQueuedConnectKey(harness.secondReader, sql, 'generation-winner');
        await harness.secondReader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createApiV1TestQueueResilience());
        pause.resume();
        await staleAttempt;

        const conflicted = await harness.reader.inbox.getItem(staleKey);
        // Attempt one read the live ticket and lost the guarded delete; attempt two read it spent.
        assert.deepEqual([conflicted?.status, conflicted?.dequeueAudit.attempts], ['COMPLETED', 2]);

        assert.equal((await winner).right?.status, 'ok');
        assert.equal((await stale).right?.status, 'ticket-rejected');
    });
});

async function waitForQueuedConnectKey(reader: InboxQueueReader, sql: PGliteSql, generationId: string) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const [row] = await sql<{ topic: string; resource: string; context: string; }[]>`
            select ri_topic_id as topic, ri_resource_id as resource, fk_ext_bank_id as context from resource_inbox
            where ri_type_id = 'APP_INBOX' and ri_resource like ${`%${generationId}%`}
        `;
        if (row !== undefined) {
            const key = { topicId: row.topic, resourceId: row.resource, contextId: row.context };
            assert.ok(await reader.inbox.getItem(key));
            return key;
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error(`The ${generationId} connect was not queued`);
}

Deno.test('an upgrade that fails after its connect committed closes that generation behind it', async () => {
    await withPGliteSql(async (sql) => {
        const fixture = await createWsConnectFixture(sql, () => {
            throw new TypeError('client went away before the upgrade');
        });
        await putAuthorisedWsTestTicket(fixture.sessions, SESSION, 'player-ticket');

        const response = await requestUpgrade(fixture, 'player-ticket');
        assert.equal(response.status, 500);
        assert.equal(fixture.socketServer.connections.has(SESSION.sessionId), false);
        assert.equal(fixture.socketServer.expectedConnections.isAwaiting(SESSION.sessionId), false);
        assert.deepEqual(await readQueuedRows(sql), [
            { type: 'CLIENT_AUTHORISED_WS_CONNECT', status: 'COMPLETED' },
            { type: 'CLIENT_AUTHORISED_WS_DISCONNECT', status: 'NEW' }
        ]);

        await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createApiV1TestQueueResilience());
        assert.deepEqual((await readQueuedRows(sql)).map((row) => row.status), ['COMPLETED', 'COMPLETED']);
        assert.deepEqual(await readActiveSessionIds(fixture), []);
    });
});
