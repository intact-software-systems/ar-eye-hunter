import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { test } from 'bun:test';
import { Hono } from 'hono';
import assert from 'node:assert/strict';

import { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import { registerWsRoutes } from '../../src/routes/ws-routes.ts';
import { installApiHttpMiddleware } from '../../src/services/install-api-http-middleware.ts';
import { validDecodeApiV1ConfigurationInput } from '../configuration/api-v1-configuration-test-fixture.ts';

const ALLOWED_ORIGIN = 'http://localhost:5176';

test('API HTTP middleware permits conditional, traced directory reads from an allowed origin', async () => {
    const app = createTimedApp([]);
    const response = await app.request('/api/state/apps/app-1/workspaces/workspace-1/group-directory', {
        method: 'OPTIONS',
        headers: {
            origin: ALLOWED_ORIGIN,
            'access-control-request-method': 'GET',
            'access-control-request-headers': 'content-type,authorization,x-client-id,if-none-match,x-request-id'
        }
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    const allowedHeaders = response.headers.get('access-control-allow-headers')?.toLowerCase().split(',');
    for (const header of ['content-type', 'authorization', 'x-client-id', 'if-none-match', 'x-request-id']) {
        assert.ok(allowedHeaders?.includes(header), `preflight must allow ${header}`);
    }
});

test('API HTTP middleware does not authorize a disallowed origin', async () => {
    const app = createTimedApp([]);
    const response = await app.request('/api/state/apps/app-1/workspaces/workspace-1/group-directory', {
        method: 'OPTIONS',
        headers: {
            origin: 'https://untrusted.example',
            'access-control-request-method': 'GET',
            'access-control-request-headers': 'if-none-match'
        }
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
});

function createTimedApp(events: RallarTimingEvent[]): Hono {
    const configuration = decodeApiV1Configuration(validDecodeApiV1ConfigurationInput());
    const app = new Hono();
    installApiHttpMiddleware(app, {
        http: configuration.http,
        stateApi: configuration.stateApi,
        timing: (event) => events.push(event)
    });
    app.post('/api/auth/login/requests/:requestId', (c) => c.json({ ok: true }));
    registerWsRoutes(app, {
        socketServer: new JsonWebSocketServer(),
        appClientInboxService: {
            writeAuthorisedWsClientConnect: rejectUnusedDependency,
            enqueueAuthorisedWsClientDisconnect: rejectUnusedDependency
        },
        readWsConnectTicket: rejectUnusedDependency,
        readWsConnectSession: rejectUnusedDependency,
        upgradeWebSocket: rejectUnusedDependency,
        nowEpochMs: Date.now
    });
    return app;
}

function rejectUnusedDependency(): Promise<never> {
    return Promise.reject(new Error('A ticketless WebSocket request reaches no connect dependency'));
}

// Every mutation URL is fresh, so each one pays a preflight the CORS middleware answers by itself.
test('API HTTP middleware times a CORS preflight that never reaches a route', async () => {
    const events: RallarTimingEvent[] = [];
    const app = createTimedApp(events);

    const response = await app.request('/api/auth/login/requests/request-preflight-0001', {
        method: 'OPTIONS',
        headers: {
            origin: ALLOWED_ORIGIN,
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'content-type,x-client-id'
        }
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    assert.equal(events.length, 1);
    assert.deepEqual(
        {
            component: events[0].component,
            operation: events[0].operation,
            status: events[0].status,
            method: events[0].method,
            path: events[0].path,
            httpStatus: events[0].httpStatus,
            origin: events[0].details?.origin
        },
        {
            component: 'http',
            operation: 'request',
            status: 'ok',
            method: 'OPTIONS',
            path: '/api/auth/login/requests/request-preflight-0001',
            httpStatus: 204,
            origin: ALLOWED_ORIGIN
        }
    );
});

test('API HTTP middleware times a routed request once and exposes its timing headers', async () => {
    const events: RallarTimingEvent[] = [];
    const app = createTimedApp(events);

    const response = await app.request('/api/auth/login/requests/request-routed-00001', {
        method: 'POST',
        headers: { origin: ALLOWED_ORIGIN, 'x-request-id': 'request-routed' }
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    assert.equal(response.headers.get('x-request-id'), 'request-routed');
    assert.match(response.headers.get('server-timing') ?? '', /^total;dur=/);
    assert.deepEqual(events.map((event) => [event.method, event.httpStatus]), [['POST', 200]]);
});

test('API HTTP middleware times a refused WebSocket upgrade on the production route without echoing its trace', async () => {
    const events: RallarTimingEvent[] = [];
    const app = createTimedApp(events);

    const response = await app.request('/api/ws/session-1', {
        headers: { origin: ALLOWED_ORIGIN, upgrade: 'websocket', 'x-request-id': 'request-upgrade' }
    });

    assert.equal(response.status, 401);
    assert.equal(response.headers.get('x-request-id'), null);
    assert.deepEqual(events.map((event) => [event.method, event.path, event.httpStatus]), [['GET', '/api/ws/session-1', 401]]);
});

test('API HTTP middleware echoes the trace on the 426 a request without Upgrade: websocket gets', async () => {
    const events: RallarTimingEvent[] = [];
    const app = createTimedApp(events);

    const response = await app.request('/api/ws/session-1', { headers: { 'x-request-id': 'request-no-upgrade' } });

    assert.equal(response.status, 426);
    assert.equal(response.headers.get('x-request-id'), 'request-no-upgrade');
    assert.deepEqual(events.map((event) => [event.method, event.httpStatus]), [['GET', 426]]);
});
