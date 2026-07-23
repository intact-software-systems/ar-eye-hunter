import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import { Either } from '@shared/resilience/Either.ts';
import * as configRoutes from '../src/routes/config-route.ts';

const SESSION = {
  clientId: 'client-a',
  username: 'alice',
  accessToken: 'access-a',
  sessionId: 'session-a',
  issuedAtEpochMs: 1_000,
  expiresAtEpochMs: 61_000,
} as const;

Deno.test('logout routes the session mutation through AppAuthInbox', async () => {
  const calls: unknown[] = [];
  const app = new Hono();
  configRoutes.init(app, {
    requireApiAuthSession: () => Promise.resolve(SESSION),
    now: () => 2_000,
    createTokenId: () => 'logout-request-1',
    readAppAuthInbox: () => ({
      logoutSession: (input: unknown) => {
        calls.push(input);
        return Promise.resolve(Either.ofRight({ loggedOut: true }));
      },
    }) as never,
  });

  const response = await app.request('/api/auth/logout', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { loggedOut: true });
  assert.deepEqual(calls, [{
    requestId: 'logout-request-1',
    capturedAtEpochMs: 2_000,
    session: SESSION,
  }]);
});

Deno.test('logout returns the durable AppInbox failure status', async () => {
  const app = new Hono();
  configRoutes.init(app, {
    requireApiAuthSession: () => Promise.resolve(SESSION),
    readAppAuthInbox: () => ({
      logoutSession: () => Promise.resolve(Either.ofLeft({
        message: 'Auth logout authority differs',
        status: 403,
      })),
    }) as never,
  });

  const response = await app.request('/api/auth/logout', { method: 'POST' });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: 'Auth logout authority differs',
  });
});
