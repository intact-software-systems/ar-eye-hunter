import { Temporal } from '@js-temporal/polyfill';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { authTicketDigestKey } from '@shared-server/rallar-system/auth/persistence/auth-storage-keys.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { PSqlClientStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';
import { registerWsRoutes } from '../../src/routes/ws-routes.ts';
import { createApiV1TestQueueResilience } from '../api-v1-test-queue-resilience.ts';
import { FUTURE_MS, withPGliteSql } from './pglite-auth-test-harness.ts';

const SESSION = {
    clientId: 'stored-client',
    username: 'alice',
    sessionId: 'stored-session',
    accessToken: 'raw-access-token',
    issuedAtEpochMs: 1,
    expiresAtEpochMs: FUTURE_MS
} as const;

interface TicketRejectionFixture {
    readonly sql: PGliteSql;
    readonly runtime: TicketReadRepository;
    readonly sessions: AuthSessionRepository;
    readonly inboxReader: InboxQueueReader;
    readonly app: Hono;
    readonly upgrades: number[];
}

class TicketReadRepository extends PSqlRuntimeStateRepository {
    readonly ticketReads = new Map<string, number>();

    override async findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined> {
        if (namespace === 'auth-sessions:ws-tickets') {
            this.ticketReads.set(key, (this.ticketReads.get(key) ?? 0) + 1);
        }
        return await super.findEntry(namespace, key);
    }
}

await withPGliteSql(async (sql) => {
    const fixture = await createTicketRejectionFixture(sql);
    for (const provenance of ['expired', 'absent', 'foreign'] as const) {
        await verifyTicketRejection(fixture, provenance);
    }
});

async function createTicketRejectionFixture(sql: PGliteSql): Promise<TicketRejectionFixture> {
    const runtime = new TicketReadRepository(sql);
    const sessions = new AuthSessionRepository(runtime);
    const resourceInbox = createPSqlResourceInboxRepository(sql, () => new Date());
    const inboxReader = new InboxQueueReader(new PSqlQueueBox(resourceInbox, Temporal.Now.instant), {
        laneBudgetPolicy: 'fixed-retry-two'
    });
    const client = new AppClientInboxService({
        inboxQueueReader: inboxReader,
        resourceInboxRepository: resourceInbox.entries,
        resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
        database: sql,
        clientStateService: createClientStateService({
            runtimeRepository: runtime,
            clientStateEventStore: new PSqlClientStateEventRepository(sql),
            serviceId: 'ticket-binding'
        }),
        wsTickets: sessions
    }, {
        serviceId: 'ticket-binding',
        timing: undefined,
        options: {
            waitMaxElapsedMsecs: 5_000,
            waitRetryIntervalMsecs: 1,
            waitMaxRetryIntervalMsecs: 4,
            waitJitterRatio: 0
        }
    });
    await sessions.putSession(SESSION);
    await sessions.putSession({ ...SESSION, clientId: 'other-client', sessionId: 'other-session' });
    const upgrades: number[] = [];
    const app = new Hono();
    registerWsRoutes(app, {
        socketServer: new JsonWebSocketServer(),
        appClientInboxService: client,
        readWsConnectSession: (sessionId) => sessions.findBySessionId(sessionId),
        upgradeWebSocket: () => {
            upgrades.push(1);
            throw new Error('A rejected ticket must not upgrade');
        },
        nowEpochMs: Date.now
    });
    return { sql, runtime, sessions, inboxReader, app, upgrades };
}

async function verifyTicketRejection(
    fixture: TicketRejectionFixture,
    provenance: 'expired' | 'absent' | 'foreign'
): Promise<void> {
    const ticket = `raw-ticket-${provenance}`;
    const ticketDigest = await hashAuthSecret(ticket);
    if (provenance !== 'absent') {
        await fixture.sessions.putWebSocketTicket({
            ticket,
            sessionId: provenance === 'foreign' ? 'other-session' : SESSION.sessionId,
            clientId: provenance === 'foreign' ? 'other-client' : SESSION.clientId,
            issuedAtEpochMs: Date.now() - 2_000,
            expiresAtEpochMs: provenance === 'expired' ? Date.now() - 1_000 : FUTURE_MS
        });
    }
    const before = await fixture.runtime.findAllEntries('auth-sessions:ws-tickets');
    const loggedCalls: unknown[][] = [];
    const originalConsoleWarn = console.warn;
    const originalConsoleError = console.error;
    console.warn = (...values) => {
        loggedCalls.push(values);
        originalConsoleError(...values);
    };
    originalConsoleError(`BEGIN ${provenance}`);
    try {
        const response = await requestUpgrade(fixture, ticket);
        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { error: 'Unauthorized: Invalid or expired websocket auth ticket' });
        assert.equal(fixture.upgrades.length, 0);
        assert.deepEqual(await fixture.runtime.findAllEntries('auth-sessions:ws-tickets'), before);
        assert.equal(fixture.runtime.ticketReads.get(authTicketDigestKey(ticketDigest)), 1);
        await verifyDurableRejection(fixture.sql);
        const rendered = Deno.inspect(loggedCalls, { depth: Infinity });
        assert.match(rendered, /RequestAuthFailure/u);
        assert.match(rendered, /sessionId: "stored-session"/u);
        assert.equal(rendered.includes(ticketDigest), false);
        assert.equal(rendered.includes(await hashAuthSecret(SESSION.accessToken)), false);
        for (const entry of before) {
            assert.equal(rendered.includes(entry.key), false);
            assert.equal(rendered.includes(entry.value), false);
        }
    }
    finally {
        originalConsoleError(`END ${provenance}`);
        console.warn = originalConsoleWarn;
    }
}

async function requestUpgrade(fixture: TicketRejectionFixture, ticket: string): Promise<Response> {
    let settled = false;
    const response = Promise.resolve(
        fixture.app.request(`http://localhost/api/ws/${SESSION.sessionId}?ticket=${ticket}`, {
            headers: { upgrade: 'websocket' }
        })
    ).finally(() => {
        settled = true;
    });
    while (!settled) {
        await fixture.inboxReader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createApiV1TestQueueResilience());
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return await response;
}

/** The rejection is the connect's typed durable result: completed, no client state, and no credential in it. */
async function verifyDurableRejection(sql: PGliteSql): Promise<void> {
    const rows = await sql<{ ris_status: string; ris_resource: JsonWireValue; }[]>`
        select ris_status, ris_resource from resource_inbox_results order by ris_resource_id
    `;
    const latest = rows.map((row) => ({
        status: row.ris_status,
        resource: typeof row.ris_resource === 'string' ? JSON.parse(row.ris_resource) : row.ris_resource
    })).filter((row) => row.resource?.status === 'ticket-rejected');
    assert.ok(latest.length > 0);
    for (const row of latest) {
        assert.equal(row.status, 'COMPLETED');
        assert.deepEqual(Object.keys(row.resource).toSorted(), ['generationId', 'sessionId', 'status']);
        assert.equal(row.resource.sessionId, SESSION.sessionId);
    }
    const [clientRows] = await sql<{ count: string | number; }[]>`
        select count(*) as count from runtime_state_store where store_namespace like 'client-state%'
    `;
    assert.equal(Number(clientRows?.count), 0);
}
