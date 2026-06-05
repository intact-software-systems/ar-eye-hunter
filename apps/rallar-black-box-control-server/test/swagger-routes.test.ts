import {
    controlOpenApiSpec,
    handleSwaggerRoute,
    swaggerFallbackResponse,
} from '../src/routes/swagger-routes.ts';

function assert(condition: unknown, message = 'Assertion failed.'): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEquals<T>(actual: T, expected: T): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
            `Expected ${JSON.stringify(expected, null, 2)}, got ${JSON.stringify(actual, null, 2)}`,
        );
    }
}

Deno.test('control OpenAPI spec describes the current server and control endpoints', () => {
    const request = new Request('http://127.0.0.1:5180/openapi.json');
    const spec = controlOpenApiSpec(request) as {
        openapi?: string;
        servers?: readonly { url: string }[];
        paths?: Record<string, unknown>;
    };

    assertEquals(spec.openapi, '3.1.0');
    assertEquals(spec.servers?.[0]?.url, 'http://127.0.0.1:5180');
    assert(spec.paths?.['/health']);
    assert(spec.paths?.['/retention/cleanup']);
    assert(spec.paths?.['/distributed-runs']);
    assert(spec.paths?.['/distributed-runs/{distributedRunId}']);
    assert(spec.paths?.['/distributed-runs/{distributedRunId}/stage']);
    assert(spec.paths?.['/distributed-runs/{distributedRunId}/start']);
    assert(spec.paths?.['/distributed-runs/{distributedRunId}/cancel']);
    assert(spec.paths?.['/distributed-runs/{distributedRunId}/artifacts']);
    assert(spec.paths?.['/runs/{runId}/commands']);
    assert(spec.paths?.['/runs/{runId}/reset']);
    assert(spec.paths?.['/runs/{runId}/artifacts']);
    assert(spec.paths?.['/runs/{runId}/events.jsonl']);
    assert(spec.paths?.['/runs/{runId}/results.jsonl']);
    assert(spec.paths?.['/runs/{runId}/failure-bundle']);
    assert(spec.paths?.['/runs/{runId}/agents/{agentId}/commands']);
    assert(spec.paths?.['/control']);
    const schemas = (spec as { components?: { schemas?: Record<string, any> } }).components?.schemas;
    const crdtCapability = schemas?.ControlAgentIdentity?.properties?.capabilities
        ?.properties?.crdt;
    assertEquals(crdtCapability?.required, ['supported']);
    assert(
        crdtCapability?.properties?.transports?.items?.enum?.includes('rtc-with-ws-fallback'),
        'ControlAgentIdentity should document CRDT transport capability metadata.',
    );
});

Deno.test('swagger route serves OpenAPI JSON', async () => {
    const request = new Request('http://localhost:5180/api/openapi.json');
    const response = handleSwaggerRoute(request);
    assert(response);
    assertEquals(response.status, 200);
    assertEquals(response.headers.get('content-type'), 'application/json');

    const body = await response.json();
    assertEquals(body.info.title, 'Rallar Black Box Control Server');
    assertEquals(body.servers[0].url, 'http://localhost:5180');
});

Deno.test('swagger route serves Swagger UI HTML', async () => {
    const request = new Request('http://localhost:5180/swagger-ui');
    const response = handleSwaggerRoute(request);
    assert(response);
    assertEquals(response.status, 200);
    assert(response.headers.get('content-type')?.startsWith('text/html'));

    const html = await response.text();
    assert(html.includes('SwaggerUIBundle'));
    assert(html.includes('/api/openapi.json'));
});

Deno.test('swagger route ignores non-doc paths', () => {
    const request = new Request('http://localhost:5180/health');
    assertEquals(handleSwaggerRoute(request), undefined);
});

Deno.test('swagger fallback redirects reads to Swagger UI', () => {
    const response = swaggerFallbackResponse();
    assertEquals(response.status, 302);
    assertEquals(response.headers.get('location'), '/swagger-ui');
});
