import { assertEquals } from '@std/assert';

import { distributedManifest } from './support/control-api-test-fixtures.ts';
import { ADMIN_TOKEN, adminHeaders, canBindLoopback, startControlServer } from './support/control-api-test-server.ts';

interface RouteExpectation {
    readonly method: string;
    readonly path: string;
    readonly headers?: HeadersInit;
    readonly body?: string;
    readonly status: number;
    readonly json?: object;
}

const UNMATCHED_ROUTE_EXPECTATIONS: readonly RouteExpectation[] = [
    { method: 'OPTIONS', path: '/runs', status: 204 },
    { method: 'GET', path: '/not-a-route', status: 302 },
    { method: 'POST', path: '/not-a-route', status: 404, json: { error: 'Not found.' } },
    { method: 'PUT', path: '/runs/route-run', status: 404, json: { error: 'Not found.' } },
    { method: 'GET', path: '/control', status: 426, json: { error: 'Expected WebSocket upgrade.' } },
    { method: 'POST', path: '/health', status: 404, json: { error: 'Not found.' } }
];

const REPORT_FOR_OTHER_RUN = JSON.stringify({
    kind: 'report',
    protocolVersion: 1,
    runId: 'other-run',
    agentId: 'agent-a',
    atEpochMs: 1_000,
    payload: {}
});

const RUN_ROUTE_EXPECTATIONS: readonly RouteExpectation[] = [
    { method: 'GET', path: '/runs/missing', status: 404, json: { error: 'Run not found.' } },
    { method: 'GET', path: '/runs/missing/failure-bundle', status: 404, json: { error: 'Run not found.' } },
    { method: 'GET', path: '/runs/missing/events.jsonl', status: 404, json: { error: 'Run not found.' } },
    { method: 'GET', path: '/runs/missing/artifacts/nope.txt', status: 404, json: { error: 'Artifact file not found.' } },
    { method: 'DELETE', path: '/runs/missing', status: 401, json: { error: 'Admin token is required or invalid.' } },
    { method: 'DELETE', path: '/runs/missing', headers: adminHeaders(), status: 404, json: { error: 'Run not found.' } },
    { method: 'POST', path: '/runs/missing/reset', headers: adminHeaders(), status: 404, json: { error: 'Run not found.' } },
    { method: 'POST', path: '/runs/route-run/agents/agent-a/commands', body: '{}', status: 400, json: { error: 'Command request requires command.' } },
    { method: 'POST', path: '/runs/route-run/agents/agent-a/commands', body: '{', status: 400 },
    {
        method: 'POST',
        path: '/runs/route-run/agents/agent-a/commands',
        body: JSON.stringify({ commandId: 'health-1', command: { kind: 'health' } }),
        status: 202
    },
    {
        method: 'POST',
        path: '/runs/route-run/agents/agent-a/commands',
        body: JSON.stringify({ commandId: 'health-2', command: { kind: 'health' } }),
        status: 429,
        json: { error: 'Command rate limit exceeded.' }
    },
    {
        method: 'POST',
        path: '/runs/route-run/agents/agent-a/report',
        body: REPORT_FOR_OTHER_RUN,
        status: 400,
        json: { error: 'Report upload envelope does not match the target run and agent.' }
    },
    {
        method: 'POST',
        path: '/runs/route-run/commands',
        headers: adminHeaders(),
        body: JSON.stringify({ command: { kind: 'health' } }),
        status: 400,
        json: { error: 'Bulk command request requires agentIds.' }
    },
    { method: 'GET', path: '/runs/route-run/failure-bundle', status: 200 },
    { method: 'POST', path: '/runs/route-run/reset', headers: adminHeaders(), status: 200 },
    { method: 'DELETE', path: '/runs/route-run', headers: adminHeaders(), status: 200, json: { deleted: true, runId: 'route-run' } }
];

const DISTRIBUTED_MANIFEST_BODY = JSON.stringify({ manifest: { ...distributedManifest(), distributedRunId: 'route-dist', controlRunId: 'route-dist-run' } });

const DISTRIBUTED_AND_FLEET_ROUTE_EXPECTATIONS: readonly RouteExpectation[] = [
    { method: 'GET', path: '/distributed-runs/missing', status: 404, json: { error: 'Distributed run not found.' } },
    { method: 'GET', path: '/distributed-runs/missing/artifacts', status: 404, json: { error: 'Distributed run not found.' } },
    { method: 'POST', path: '/distributed-runs/missing/stage', status: 401, json: { error: 'Admin token is required or invalid.' } },
    {
        method: 'POST',
        path: '/distributed-runs/missing/stage',
        headers: adminHeaders(),
        status: 404,
        json: { error: 'Distributed run not found: missing.' }
    },
    { method: 'POST', path: '/distributed-runs', headers: adminHeaders(), body: DISTRIBUTED_MANIFEST_BODY, status: 201 },
    {
        method: 'POST',
        path: '/distributed-runs',
        headers: adminHeaders(),
        body: DISTRIBUTED_MANIFEST_BODY,
        status: 400,
        json: { error: 'Distributed run route-dist already exists.' }
    },
    { method: 'POST', path: '/distributed-runs/route-dist/cancel', headers: adminHeaders(), body: JSON.stringify({ reason: '  stop  ' }), status: 202 },
    {
        method: 'POST',
        path: '/distributed-runs/route-dist/start',
        headers: adminHeaders(),
        status: 409,
        json: { error: 'Cannot start distributed run route-dist in terminal state cancelled.' }
    },
    { method: 'GET', path: '/fleet/reports/missing', status: 404, json: { error: 'Fleet report not found.' } },
    { method: 'GET', path: '/fleet/reports/missing/artifacts', status: 404, json: { error: 'Fleet report not found.' } },
    { method: 'POST', path: '/fleet/reports/rebuild', status: 401, json: { error: 'Admin token is required or invalid.' } }
];

// The tables pin each route family's routing, authorization, and error-body contract end to end.
Deno.test('control route families keep their statuses, authorization, and error bodies', async () => {
    if (!(await canBindLoopback())) {
        return;
    }

    const server = await startControlServer({
        RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN,
        RALLAR_BLACK_BOX_COMMAND_RATE_LIMIT_MAX: '1'
    });
    try {
        for (
            const expectation of [
                ...UNMATCHED_ROUTE_EXPECTATIONS,
                ...RUN_ROUTE_EXPECTATIONS,
                ...DISTRIBUTED_AND_FLEET_ROUTE_EXPECTATIONS
            ]
        ) {
            await assertRouteExpectation(server.baseUrl, expectation);
        }
    }
    finally {
        await server.stop();
    }
});

async function assertRouteExpectation(baseUrl: string, expectation: RouteExpectation): Promise<void> {
    const response = await fetch(`${baseUrl}${expectation.path}`, {
        method: expectation.method,
        headers: expectation.headers,
        body: expectation.body,
        redirect: 'manual'
    });
    const text = await response.text();
    assertEquals(response.status, expectation.status, `${expectation.method} ${expectation.path}: ${text}`);
    if (expectation.json) {
        assertEquals(JSON.parse(text), expectation.json, `${expectation.method} ${expectation.path}`);
    }
}
