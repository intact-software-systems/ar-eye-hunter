import assert from 'node:assert/strict';
import {
  createAuthorisedWsConnectionContext,
  toAuthorisedWsClientInput,
} from '../src/routes/ws-routes.ts';
import { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';

Deno.test('websocket route forwards scoped state parameters to authorised connect', () => {
  const input = toAuthorisedWsClientInput(
    new URL(
      'https://api.example.test/api/ws/session-1?ticket=ticket-1&applicationId=ar-eye-hunter&workspaceId=default',
    ),
    'Browser',
    123,
  );

  assert.deepEqual(input, {
    applicationId: 'ar-eye-hunter',
    workspaceId: 'default',
    userAgent: 'Browser',
    connectedAtEpochMs: 123,
  });
});

Deno.test('websocket connection generation is stable per context and fresh per upgrade', () => {
  const socket = {} as WebSocket;
  const first = createAuthorisedWsConnectionContext('session-1', socket);
  const second = createAuthorisedWsConnectionContext('session-1', socket);

  assert.equal(first.generationId, first.generationId);
  assert.notEqual(first.generationId, second.generationId);
  assert.equal(
    createAuthorisedWsConnectionContext('session-1', socket, 'fixed-generation')
      .generationId,
    'fixed-generation',
  );
});

Deno.test('websocket server captures a strictly monotonic generation start fact once per upgrade', () => {
  const socket = {} as WebSocket;
  const server = new JsonWebSocketServer();
  const first = server.createConnectionContext(
    'session-1',
    socket,
    'generation-a',
    100,
  );
  const tiedClock = server.createConnectionContext(
    'session-2',
    socket,
    'generation-b',
    100,
  );
  const regressedClock = server.createConnectionContext(
    'session-3',
    socket,
    'generation-c',
    99,
  );

  assert.equal(first.generationStartedAtEpochMs, 100);
  assert.equal(tiedClock.generationStartedAtEpochMs, 101);
  assert.equal(regressedClock.generationStartedAtEpochMs, 102);
});
