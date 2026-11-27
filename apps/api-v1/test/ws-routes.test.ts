import { test } from 'bun:test';
import assert from 'node:assert/strict';

import type { ToAuthorisedWsClientConnectEnqueueInput } from '@shared-server/rallar-system/client-state/inbox/authorised-ws-client-app-inbox.ts';
import { Either } from '@shared/resilience/Either.ts';
import { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { registerWsRoutes, toAuthorisedWsClientInput } from '../src/routes/ws-routes.ts';
import { PGliteTestSocket } from './db/pglite-test-socket.ts';
import { createTracedApiTestApp } from './services/create-traced-api-test-app.ts';

const HOLDER_ID = '00000000-0000-4000-8000-0000000000a1';

test('websocket route forwards scoped state parameters to authorised connect', () => {
    const input = toAuthorisedWsClientInput(
        new URL(
            'https://api.example.test/api/ws/session-1?ticket=ticket-1&applicationId=ar-eye-hunter&workspaceId=default'
        ),
        'Browser',
        123
    );

    assert.deepEqual(input, {
        applicationId: 'ar-eye-hunter',
        workspaceId: 'default',
        userAgent: 'Browser',
        connectedAtEpochMs: 123
    });
});

test('websocket connection generation is stable per context and fresh per upgrade', () => {
    const socket = new PGliteTestSocket();
    const server = new JsonWebSocketServer();
    const first = server.createConnectionContext({ id: 'session-1', socket });
    const second = server.createConnectionContext({ id: 'session-1', socket });

    assert.match(first.generationId, /^[a-f0-9-]{36}$/u);
    assert.equal(first.socket, socket);
    assert.notEqual(first.generationId, second.generationId);
    assert.equal(
        server.createConnectionContext({ id: 'session-1', socket, generationId: 'fixed-generation' })
            .generationId,
        'fixed-generation'
    );
});

test('websocket server captures a strictly monotonic generation start fact once per upgrade', () => {
    const socket = new PGliteTestSocket();
    const server = new JsonWebSocketServer();
    const first = server.createConnectionContext(
        { id: 'session-1', socket, generationId: 'generation-a', observedAtEpochMs: 100 }
    );
    const tiedClock = server.createConnectionContext(
        { id: 'session-2', socket, generationId: 'generation-b', observedAtEpochMs: 100 }
    );
    const regressedClock = server.createConnectionContext(
        { id: 'session-3', socket, generationId: 'generation-c', observedAtEpochMs: 99 }
    );

    assert.equal(first.generationStartedAtEpochMs, 100);
    assert.equal(tiedClock.generationStartedAtEpochMs, 101);
    assert.equal(regressedClock.generationStartedAtEpochMs, 102);
});

test('websocket route names its own process as the holder of the connect it enqueues', async () => {
    const enqueued: ToAuthorisedWsClientConnectEnqueueInput[] = [];
    const app = createTracedApiTestApp();
    registerWsRoutes(app, {
        serverPeerId: 'route-server',
        holderId: HOLDER_ID,
        socketServer: new JsonWebSocketServer(),
        appClientInboxService: {
            writeAuthorisedWsClientConnect: async (input) => {
                enqueued.push(input);
                return Either.ofRight({ status: 'inactive', sessionId: input.authSession.sessionId, generationId: input.generationId });
            },
            enqueueAuthorisedWsClientDisconnect: async () => {
                throw new Error('An inactive connect enqueues no disconnect');
            }
        },
        readWsConnectTicket: async (ticketDigest) => ({
            ticketDigest,
            accessTokenDigest: 'access-token-digest',
            sessionId: 'session-1',
            clientId: 'player',
            issuedAtEpochMs: 1,
            expiresAtEpochMs: Number.MAX_SAFE_INTEGER
        }),
        readWsConnectSession: async (sessionId) => ({
            clientId: 'player',
            username: 'player',
            sessionId,
            accessTokenDigest: 'access-token-digest',
            issuedAtEpochMs: 1,
            expiresAtEpochMs: Number.MAX_SAFE_INTEGER
        }),
        upgradeWebSocket: async () => {
            throw new Error('An inactive connect upgrades no socket');
        },
        nowEpochMs: Date.now
    });

    const response = await app.request('http://localhost/api/ws/session-1?ticket=ticket-1', {
        headers: { upgrade: 'websocket' }
    });

    assert.equal(response.status, 409);
    assert.deepEqual(enqueued.map((input) => input.holderId), [HOLDER_ID]);
});
