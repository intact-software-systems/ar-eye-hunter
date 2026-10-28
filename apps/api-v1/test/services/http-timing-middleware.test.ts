import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { Hono, type Context, type Next } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';
import { createHttpTimingMiddleware } from '../../src/services/http-timing-middleware.ts';
import { readApiRequestTraceId } from '../../src/services/read-api-request-trace-id.ts';

const MINTED_TRACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function createTracedApp(events: RallarTimingEvent[]): Hono {
    const app = new Hono();
    app.use('/api/*', createHttpTimingMiddleware({ timing: (event) => events.push(event) }));
    app.post('/api/trace', (c) => c.json({ traceId: readApiRequestTraceId(c) }));
    return app;
}

async function requestTrace(
    headers: Record<string, string>
): Promise<Readonly<{ echoed: string | null; read: string; recorded: string | undefined; }>> {
    const events: RallarTimingEvent[] = [];
    const response = await createTracedApp(events).request('/api/trace', { method: 'POST', headers });
    const body = await response.json() as { traceId: string; };
    return { echoed: response.headers.get('x-request-id'), read: body.traceId, recorded: events[0]?.requestId };
}

function createContextDouble(
    request: Readonly<{ path: string; headers: Readonly<Record<string, string>>; }>,
    responseHeaders: Headers,
    isClosed: () => boolean = () => false
): Context {
    const variables = new Map<string, string>();
    return {
        req: {
            method: 'GET',
            path: request.path,
            header(name: string): string | undefined {
                if (isClosed()) {
                    throw new TypeError('Request closed');
                }
                return request.headers[name.toLowerCase()];
            }
        },
        res: {
            status: 200
        },
        header(name: string, value: string): void {
            responseHeaders.set(name, value);
        },
        set(key: string, value: string): void {
            variables.set(key, value);
        },
        get(key: string): string | undefined {
            return variables.get(key);
        }
    } as Context;
}

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

    const context = createContextDouble(
        {
            path: '/api/ws/session-1',
            headers: {
                'x-request-id': 'request-ws',
                'x-client-id': 'client-1',
                origin: 'https://app.example.test',
                'user-agent': 'closing-client'
            }
        },
        responseHeaders,
        () => closed
    );

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

    const context = createContextDouble(
        { path: '/api/ws/session-1', headers: { upgrade: 'websocket', 'x-request-id': 'request-upgrade' } },
        responseHeaders
    );

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
    assert.equal(readApiRequestTraceId(context), 'request-upgrade');
});

Deno.test('HTTP timing middleware echoes, records and exposes a valid x-request-id as the trace', async () => {
    const trace = await requestTrace({ 'x-request-id': 'trace_Valid-1' });

    assert.deepEqual(trace, { echoed: 'trace_Valid-1', read: 'trace_Valid-1', recorded: 'trace_Valid-1' });
});

Deno.test('HTTP timing middleware names the request trace on its line and keeps the request id equal to it', async () => {
    const events: RallarTimingEvent[] = [];

    await createTracedApp(events).request('/api/trace', {
        method: 'POST',
        headers: { 'x-request-id': 'trace-http-timing-1' }
    });

    assert.deepEqual(
        events.map(({ traceId, requestId }) => ({ traceId, requestId })),
        [{ traceId: 'trace-http-timing-1', requestId: 'trace-http-timing-1' }]
    );
});

Deno.test('HTTP timing middleware echoes the trace on a route that returns its own Response', async () => {
    const app = new Hono();
    app.use('/api/*', createHttpTimingMiddleware({ timing: () => undefined }));
    app.post('/api/raw', () => Response.json({ ok: true }, { headers: { 'content-type': 'application/json' } }));

    const response = await app.request('/api/raw', { method: 'POST', headers: { 'x-request-id': 'trace-raw-response' } });

    assert.equal(response.headers.get('x-request-id'), 'trace-raw-response');
    assert.match(response.headers.get('server-timing') ?? '', /^total;dur=/);
});

Deno.test('HTTP timing middleware keeps a 128-character x-request-id', async () => {
    const longest = 'a'.repeat(128);

    const trace = await requestTrace({ 'x-request-id': longest });

    assert.deepEqual(trace, { echoed: longest, read: longest, recorded: longest });
});

for (
    const [label, header] of [
        ['a space', 'a b'],
        ['129 characters', 'a'.repeat(129)],
        ['the empty string', '']
    ] as const
) {
    Deno.test(`HTTP timing middleware replaces an x-request-id with ${label} by a minted trace`, async () => {
        const trace = await requestTrace({ 'x-request-id': header });

        assert.match(trace.read, MINTED_TRACE_ID);
        assert.deepEqual(trace, { echoed: trace.read, read: trace.read, recorded: trace.read });
    });
}

Deno.test('HTTP timing middleware mints a trace when x-request-id is absent', async () => {
    const first = await requestTrace({});
    const second = await requestTrace({});

    assert.match(first.read, MINTED_TRACE_ID);
    assert.deepEqual(first, { echoed: first.read, read: first.read, recorded: first.read });
    assert.notEqual(first.read, second.read);
});

Deno.test('readApiRequestTraceId refuses an untraced context as a programmer invariant, never a TypeError', () => {
    assert.throws(
        () => readApiRequestTraceId(createContextDouble({ path: '/api/untraced', headers: {} }, new Headers())),
        (error) => error instanceof Error && !(error instanceof TypeError) && /request trace/u.test(error.message)
    );
});
