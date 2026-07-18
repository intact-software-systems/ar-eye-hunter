import assert from 'node:assert/strict';
import {
  createAuthorisedWsConnectionContext,
  toAuthorisedWsClientInput,
} from '../src/routes/ws-routes.ts';

Deno.test('websocket route forwards scoped state parameters to authorised connect', () => {
  const input = toAuthorisedWsClientInput(
    new URL(
      'https://api.example.test/api/ws/session-1?ticket=ticket-1&applicationId=ar-eye-hunter&workspaceId=default',
    ),
    'Browser',
  );

  assert.deepEqual(input, {
    applicationId: 'ar-eye-hunter',
    workspaceId: 'default',
    userAgent: 'Browser',
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
