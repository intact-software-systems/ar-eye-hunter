import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';
import { Hono, type Context, type Next } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';
import { createHttpTimingMiddleware } from '../../src/services/http-timing-middleware.ts';

Deno.test('HTTP timing middleware records request duration and response headers', async () => {
    const events: RallarTimingEvent[] = [];
    const app = new Hono();

    app.use(
        '/api/*',
        createHttpTimingMiddleware({
            timing: (event) => events.push(event)
        })
    );
    app.get('/api/health', (c) => c.json({ ok: true }));

    const response = await app.request('/api/health', {
        headers: {
            'x-request-id': 'request-1',
            'x-client-id': 'alice'
        }
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
            clientId: events[0].details?.clientId
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
            clientId: 'alice'
        }
    );
    assert.equal(typeof events[0].durationMs, 'number');
});

Deno.test('HTTP timing middleware records 4xx responses as errors', async () => {
    const events: RallarTimingEvent[] = [];
    const app = new Hono();

    app.use(
        '/api/*',
        createHttpTimingMiddleware({
            timing: (event) => events.push(event)
        })
    );
    app.post('/api/reject', (c) => c.json({ error: 'bad input' }, 400));

    const response = await app.request('/api/reject', {
        method: 'POST',
        headers: {
            'x-request-id': 'request-400'
        }
    });

    assert.equal(response.status, 400);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'error');
    assert.equal(events[0].httpStatus, 400);
    assert.equal(events[0].error?.message, 'HTTP 400');
});

Deno.test('HTTP timing middleware snapshots request headers before next handlers can close the request', async () => {
    const events: RallarTimingEvent[] = [];
    const responseHeaders = new Headers();
    let closed = false;

    const context = {
        req: {
            method: 'GET',
            path: '/api/ws/session-1',
            header(name: string): string | undefined {
                if (closed) {
                    throw new TypeError('Request closed');
                }

                switch (name.toLowerCase()) {
                    case 'x-request-id':
                        return 'request-ws';
                    case 'x-client-id':
                        return 'client-1';
                    case 'origin':
                        return 'https://app.example.test';
                    case 'user-agent':
                        return 'closing-client';
                    default:
                        return undefined;
                }
            }
        },
        res: {
            status: 200
        },
        header(name: string, value: string): void {
            responseHeaders.set(name, value);
        }
    } as unknown as Context;

    const middleware = createHttpTimingMiddleware({
        timing: (event) => events.push(event)
    });
    const next: Next = () => {
        closed = true;
        return Promise.resolve();
    };

    await middleware(context, next);

    assert.match(responseHeaders.get('server-timing') ?? '', /^total;dur=/);
    assert.equal(events.length, 1);
    assert.equal(events[0].requestId, 'request-ws');
    assert.equal(events[0].method, 'GET');
    assert.equal(events[0].path, '/api/ws/session-1');
    assert.equal(events[0].details?.clientId, 'client-1');
    assert.equal(events[0].details?.origin, 'https://app.example.test');
    assert.equal(events[0].details?.userAgent, 'closing-client');
});

Deno.test('HTTP timing middleware does not mutate websocket upgrade responses', async () => {
    const events: RallarTimingEvent[] = [];
    const responseHeaders = new Headers();

    const context = {
        req: {
            method: 'GET',
            path: '/api/ws/session-1',
            header(name: string): string | undefined {
                switch (name.toLowerCase()) {
                    case 'upgrade':
                        return 'websocket';
                    case 'x-request-id':
                        return 'request-upgrade';
                    default:
                        return undefined;
                }
            }
        },
        res: {
            status: 200
        },
        header(name: string, value: string): void {
            responseHeaders.set(name, value);
        }
    } as unknown as Context;

    const middleware = createHttpTimingMiddleware({
        timing: (event) => events.push(event)
    });
    const next: Next = () => {
        Object.assign(context.res, { status: 101 });
        return Promise.resolve();
    };

    await middleware(context, next);

    assert.equal(responseHeaders.has('x-request-id'), false);
    assert.equal(responseHeaders.has('server-timing'), false);
    assert.equal(events.length, 1);
    assert.equal(events[0].requestId, 'request-upgrade');
    assert.equal(events[0].httpStatus, 101);
    assert.equal(events[0].status, 'ok');
});
