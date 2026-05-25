import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono';
import { Temporal } from '@js-temporal/polyfill';
import {
  CircuitBreaker,
  CircuitBreakerPolicy,
  RateLimiterPolicy,
} from '@shared/resilience/Resilience.ts';
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

Deno.test('state API circuit breaker ignores client errors', async () => {
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
  app.get('/api/state/client-error', (c) => c.json({ error: 'bad' }, 400));

  const first = await app.request('/api/state/client-error', {
    headers: { 'x-client-id': 'alice' },
  });
  const second = await app.request('/api/state/client-error', {
    headers: { 'x-client-id': 'alice' },
  });

  assert.equal(first.status, 400);
  assert.equal(second.status, 400);
});
