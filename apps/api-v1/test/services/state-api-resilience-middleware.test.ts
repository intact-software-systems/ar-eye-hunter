import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import { Temporal } from '@js-temporal/polyfill';
import { CircuitBreaker, CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { RateLimiterPolicy } from '@shared/resilience/Resilience.ts';
import { createStateApiResilienceMiddleware } from '../../src/services/state-api-resilience-middleware.ts';

Deno.test('state API event-list middleware rate limits by authenticated client id', async () => {
  const app = new Hono();
  app.use(
    '/api/state/*',
    createStateApiResilienceMiddleware({
      namespace: `test-${crypto.randomUUID()}`,
      eventListRateLimitPolicy: new RateLimiterPolicy(60_000, 1),
      stateRateLimitPolicy: new RateLimiterPolicy(60_000, 100),
    }),
  );
  app.get(
    '/api/state/apps/app/workspaces/workspace/groups/room/events',
    (c) => c.json({ ok: true }),
  );

  const first = await app.request(
    '/api/state/apps/app/workspaces/workspace/groups/room/events',
    { headers: { 'x-client-id': 'alice' } },
  );
  const second = await app.request(
    '/api/state/apps/app/workspaces/workspace/groups/room/events',
    { headers: { 'x-client-id': 'alice' } },
  );

  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.deepEqual(await second.json(), {
    error: 'Too many state API requests',
  });
});

Deno.test('state API event page middleware uses event-list rate limits', async () => {
  const app = new Hono();
  app.use(
    '/api/state/*',
    createStateApiResilienceMiddleware({
      namespace: `test-${crypto.randomUUID()}`,
      eventListRateLimitPolicy: new RateLimiterPolicy(60_000, 1),
      stateRateLimitPolicy: new RateLimiterPolicy(60_000, 100),
    }),
  );
  app.get(
    '/api/state/apps/app/workspaces/workspace/groups/room/events/page',
    (c) => c.json({ ok: true }),
  );

  const first = await app.request(
    '/api/state/apps/app/workspaces/workspace/groups/room/events/page',
    { headers: { 'x-client-id': 'alice' } },
  );
  const second = await app.request(
    '/api/state/apps/app/workspaces/workspace/groups/room/events/page',
    { headers: { 'x-client-id': 'alice' } },
  );

  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.deepEqual(await second.json(), {
    error: 'Too many state API requests',
  });
});

Deno.test('state API circuit breaker opens after repeated server failures', async () => {
  const app = new Hono();
  const duration = Temporal.Duration.from({ seconds: 60 });
  app.use(
    '/api/state/*',
    createStateApiResilienceMiddleware({
      namespace: `test-${crypto.randomUUID()}`,
      stateRateLimitPolicy: new RateLimiterPolicy(60_000, 100),
      circuitBreaker: CircuitBreaker.create(
        new CircuitBreakerPolicy(0, duration, duration, duration),
      ),
    }),
  );
  app.get('/api/state/failing', (c) => c.json({ error: 'failed' }, 500));

  const first = await app.request('/api/state/failing', {
    headers: { 'x-client-id': 'alice' },
  });
  const second = await app.request('/api/state/failing', {
    headers: { 'x-client-id': 'alice' },
  });

  assert.equal(first.status, 500);
  assert.equal(second.status, 503);
  assert.deepEqual(await second.json(), {
    error: 'State API is temporarily unavailable',
  });
});

Deno.test('state API circuit breaker ignores repeated revision-floor conflicts', async () => {
  const app = new Hono();
  const duration = Temporal.Duration.from({ seconds: 60 });
  app.use(
    '/api/state/*',
    createStateApiResilienceMiddleware({
      namespace: `test-${crypto.randomUUID()}`,
      stateRateLimitPolicy: new RateLimiterPolicy(60_000, 100),
      circuitBreaker: CircuitBreaker.create(
        new CircuitBreakerPolicy(0, duration, duration, duration),
      ),
    }),
  );
  app.get(
    '/api/state/client-error',
    (c) => c.json({ code: 'state-revision-floor-not-satisfied' }, 409),
  );

  const first = await app.request('/api/state/client-error', {
    headers: { 'x-client-id': 'alice' },
  });
  const second = await app.request('/api/state/client-error', {
    headers: { 'x-client-id': 'alice' },
  });

  assert.equal(first.status, 409);
  assert.equal(second.status, 409);
});

Deno.test('state API rate limiting uses the canonical client mutation failure', async () => {
  const app = new Hono();
  app.use(
    '/api/state/*',
    createStateApiResilienceMiddleware({
      namespace: `test-${crypto.randomUUID()}`,
      stateRateLimitPolicy: new RateLimiterPolicy(12_500, 1),
    }),
  );
  const path = '/api/state/apps/app/workspaces/workspace/clients/alice/principal/' +
    'requests/Request_ID-012345678';
  app.put(path, (context) => context.json({ ok: true }));

  const success = await app.request(path, { method: 'PUT' });
  assert.equal(success.status, 200);
  assert.equal(success.headers.get('retry-after'), null);
  const response = await app.request(path, { method: 'PUT' });

  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '13');
  assert.deepEqual(await response.json(), {
    type: 'api-mutation-failure',
    version: 'canonical.v1',
    code: 'rate-limited',
    status: 429,
    message: 'Too many state API requests',
    issues: null,
    denial: null,
    retry: {
      kind: 'rate-limited',
      retryAfterMs: 12_500,
      attempts: null,
      lane: null,
      queueAgeMs: null,
      dueAgeMs: null,
    },
  });
});

Deno.test('state API circuit breaking uses the canonical client mutation failure', async () => {
  const app = new Hono();
  const duration = Temporal.Duration.from({ seconds: 60 });
  app.use(
    '/api/state/*',
    createStateApiResilienceMiddleware({
      namespace: `test-${crypto.randomUUID()}`,
      stateRateLimitPolicy: new RateLimiterPolicy(60_000, 100),
      circuitBreaker: CircuitBreaker.create(
        new CircuitBreakerPolicy(0, duration, duration, duration),
      ),
    }),
  );
  const path = '/api/state/apps/app/workspaces/workspace/clients/alice/principal/' +
    'requests/Request_ID-012345678';
  app.put(path, (context) => context.json({ error: 'failed' }, 500));

  assert.equal((await app.request(path, { method: 'PUT' })).status, 500);
  const response = await app.request(path, { method: 'PUT' });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    type: 'api-mutation-failure',
    version: 'canonical.v1',
    code: 'api-mutation-unavailable',
    status: 503,
    message: 'State API is temporarily unavailable',
    issues: null,
    denial: null,
    retry: {
      kind: 'unavailable',
      retryAfterMs: null,
      attempts: null,
      lane: null,
      queueAgeMs: null,
      dueAgeMs: null,
    },
  });
});

Deno.test('removed client mutation paths bypass resilience and remain 404', async () => {
  const app = new Hono();
  app.use(
    '/api/state/*',
    createStateApiResilienceMiddleware({
      namespace: `test-${crypto.randomUUID()}`,
      stateRateLimitPolicy: new RateLimiterPolicy(60_000, 0),
    }),
  );
  const path = '/api/state/apps/app/workspaces/workspace/clients/alice/principal';

  assert.equal((await app.request(path, { method: 'PUT' })).status, 404);
});
