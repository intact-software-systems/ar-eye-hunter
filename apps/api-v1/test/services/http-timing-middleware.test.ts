import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono';
import { createHttpTimingMiddleware } from '../../src/services/http-timing-middleware.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';

Deno.test('HTTP timing middleware records request duration and response headers', async () => {
  const events: RallarTimingEvent[] = [];
  const app = new Hono();

  app.use('/api/*', createHttpTimingMiddleware({
    timing: (event) => events.push(event),
  }));
  app.get('/api/health', (c) => c.json({ ok: true }));

  const response = await app.request('/api/health', {
    headers: {
      'x-request-id': 'request-1',
      'x-client-id': 'alice',
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-request-id'), 'request-1');
  assert.match(response.headers.get('server-timing') ?? '', /^total;dur=/);
  assert.equal(events.length, 1);
  assert.deepEqual(
    {
      type: events[0].type,
      component: events[0].component,
      operation: events[0].operation,
      status: events[0].status,
      requestId: events[0].requestId,
      method: events[0].method,
      path: events[0].path,
      httpStatus: events[0].httpStatus,
      clientId: events[0].details?.clientId,
    },
    {
      type: 'rallar.timing',
      component: 'http',
      operation: 'request',
      status: 'ok',
      requestId: 'request-1',
      method: 'GET',
      path: '/api/health',
      httpStatus: 200,
      clientId: 'alice',
    },
  );
  assert.equal(typeof events[0].durationMs, 'number');
});
