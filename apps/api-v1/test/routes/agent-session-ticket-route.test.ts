import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import type {
  AgentSessionTicketResponse,
  ConsumeAgentSessionTicketResponse,
} from '@shared/api/api-config.ts';
import * as configRoutes from '../../src/routes/config-route.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';

const NOW_EPOCH_MS = Date.now();

Deno.test('agent session ticket route rejects unauthenticated issue requests', async () => {
  const app = createApp({
    requireApiAuthSession: () => Promise.reject(new Error('Unauthorized: Missing bearer token')),
  });

  const response = await app.request('/api/auth/agent-session-tickets', {
    method: 'POST',
    body: JSON.stringify({ agentIds: ['controller-01'] }),
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: 'Unauthorized: Missing bearer token',
  });
});

Deno.test('agent session ticket route mints distinct same-user sessions and consumes a ticket once', async () => {
  const sessions = new Map<string, ConsumeAgentSessionTicketResponse>();
  const app = createApp({
    requireApiAuthSession: () => Promise.resolve(createAuthSession()),
    readAppAuthInbox: () => ({
      issueAgentSessionTickets: (input: {
        agents: readonly { agentId: string; sessionId: string }[];
        ticketExpiresAtEpochMs: number;
        sessionExpiresAtEpochMs: number;
      }) => Promise.resolve(Either.ofRight({
        tickets: input.agents.map(({ agentId, sessionId }) => {
          const ticket = `ticket-for-${sessionId}-long-enough`;
          sessions.set(ticket, {
            clientId: 'alice-client',
            username: 'alice',
            accessToken: `access-for-${sessionId}-long-enough`,
            sessionId,
            expiresAtEpochMs: input.sessionExpiresAtEpochMs,
          });
          return {
            agentId,
            ticket,
            sessionId,
            expiresAtEpochMs: input.ticketExpiresAtEpochMs,
          };
        }),
      })),
      consumeAgentSessionTicket: (input: { ticket: string }) => {
        const session = sessions.get(input.ticket);
        if (!session) {
          return Promise.resolve(Either.ofLeft({
            message: 'Agent session ticket is invalid or expired.',
            status: 404,
          }));
        }
        sessions.delete(input.ticket);
        return Promise.resolve(Either.ofRight(session));
      },
    }) as never,
    now: () => NOW_EPOCH_MS,
  });

  const issueResponse = await app.request('/api/auth/agent-session-tickets', {
    method: 'POST',
    headers: {
      authorization: 'Bearer operator-token',
      'x-client-id': 'alice-client',
    },
    body: JSON.stringify({ agentIds: ['controller-01', 'controller-02'] }),
  });
  const issued = await issueResponse.json() as AgentSessionTicketResponse;

  assert.equal(issueResponse.status, 200);
  assert.equal(issued.tickets.length, 2);
  assert.deepEqual(issued.tickets.map((ticket) => ticket.agentId), [
    'controller-01',
    'controller-02',
  ]);
  assert.notEqual(issued.tickets[0].sessionId, 'operator-session');
  assert.notEqual(issued.tickets[0].sessionId, issued.tickets[1].sessionId);
  assert.ok(issued.tickets[0].ticket.length > 20);

  const consumeResponse = await app.request('/api/auth/agent-session-tickets/consume', {
    method: 'POST',
    body: JSON.stringify({ ticket: issued.tickets[0].ticket }),
  });
  const consumed = await consumeResponse.json() as ConsumeAgentSessionTicketResponse;

  assert.equal(consumeResponse.status, 200);
  assert.equal(consumed.clientId, 'alice-client');
  assert.equal(consumed.username, 'alice');
  assert.equal(consumed.sessionId, issued.tickets[0].sessionId);
  assert.ok(consumed.accessToken.length > 20);
  assert.equal(issued.tickets[0].expiresAtEpochMs, NOW_EPOCH_MS + 60_000);
  assert.equal(consumed.expiresAtEpochMs, NOW_EPOCH_MS + 86_400_000);

  const repeatConsumeResponse = await app.request('/api/auth/agent-session-tickets/consume', {
    method: 'POST',
    body: JSON.stringify({ ticket: issued.tickets[0].ticket }),
  });

  assert.equal(repeatConsumeResponse.status, 404);
  assert.deepEqual(await repeatConsumeResponse.json(), {
    error: 'Agent session ticket is invalid or expired.',
  });
});

function createApp(
  dependencies: configRoutes.ConfigRouteDependencies,
): Hono {
  const app = new Hono();
  configRoutes.init(app, dependencies);
  return app;
}

function createAuthSession(): IssuedAuthSession {
  return {
    clientId: 'alice-client',
    username: 'alice',
    accessToken: 'operator-token',
    sessionId: 'operator-session',
    issuedAtEpochMs: NOW_EPOCH_MS,
    expiresAtEpochMs: NOW_EPOCH_MS + 86_400_000,
  };
}
