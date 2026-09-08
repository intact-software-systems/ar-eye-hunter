import assert from 'node:assert/strict';

import { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { toAuthorisedWsClientInput } from '../src/routes/ws-routes.ts';
import { PGliteTestSocket } from './db/pglite-test-socket.ts';

Deno.test('websocket route forwards scoped state parameters to authorised connect', () => {
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

Deno.test('websocket connection generation is stable per context and fresh per upgrade', () => {
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

Deno.test('websocket server captures a strictly monotonic generation start fact once per upgrade', () => {
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
