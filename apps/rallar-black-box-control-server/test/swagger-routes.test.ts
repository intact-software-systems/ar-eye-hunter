import {
  controlOpenApiSpec,
  handleSwaggerRoute,
  swaggerFallbackResponse,
} from '../src/routes/swagger-routes.ts';

type OpenApiSchema = Readonly<{
  $ref?: string;
  enum?: readonly unknown[];
  items?: OpenApiSchema;
  properties?: Record<string, OpenApiSchema>;
  required?: readonly string[];
  schema?: OpenApiSchema;
}>;

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
  assert(spec.paths?.['/distributed-runs/resolve-targets']);
  assert(spec.paths?.['/distributed-runs/{distributedRunId}']);
  assert(spec.paths?.['/distributed-runs/{distributedRunId}/stage']);
  assert(spec.paths?.['/distributed-runs/{distributedRunId}/start']);
  assert(spec.paths?.['/distributed-runs/{distributedRunId}/cancel']);
  assert(spec.paths?.['/distributed-runs/{distributedRunId}/artifacts']);
  assert(spec.paths?.['/fleet/reports']);
  assert(spec.paths?.['/fleet/reports/rebuild']);
  assert(spec.paths?.['/fleet/reports/{distributedRunId}']);
  assert(spec.paths?.['/fleet/reports/{distributedRunId}/artifacts']);
  assert(spec.paths?.['/runs/{runId}/commands']);
  assert(spec.paths?.['/runs/{runId}/reset']);
  assert(spec.paths?.['/runs/{runId}/artifacts']);
  assert(spec.paths?.['/runs/{runId}/events.jsonl']);
  assert(spec.paths?.['/runs/{runId}/results.jsonl']);
  assert(spec.paths?.['/runs/{runId}/failure-bundle']);
  assert(spec.paths?.['/runs/{runId}/agents/{agentId}/commands']);
  assert(spec.paths?.['/control']);
  const schemas = (spec as { components?: { schemas?: Record<string, OpenApiSchema> } }).components
    ?.schemas;
  const parameters = (spec as { components?: { parameters?: Record<string, OpenApiSchema> } })
    .components?.parameters;
  const crdtCapability = schemas?.ControlAgentIdentity?.properties?.capabilities
    ?.properties?.crdt;
  const runArtifact = schemas?.ControlRunArtifactBundle;
  const distributedArtifact = schemas?.ControlDistributedRunArtifactBundle;
  const fleetReport = schemas?.ControlFleetRunReport;
  const fleetBundle = schemas?.ControlFleetReportBundle;
  const geoLocation = schemas?.RallarBlackBoxGeoLocation;
  assertEquals(crdtCapability?.required, ['supported']);
  assert(
    crdtCapability?.properties?.transports?.items?.enum?.includes('rtc-with-ws-fallback'),
    'ControlAgentIdentity should document CRDT transport capability metadata.',
  );
  assert(
    distributedArtifact?.properties?.artifactSchemaVersion?.enum?.includes(2),
    'Distributed artifact schema should document v2 analysis files.',
  );
  assert(
    Boolean(distributedArtifact?.properties?.files?.properties?.['failures.json']),
    'Distributed artifact schema should document failures.json.',
  );
  assert(
    parameters?.ArtifactFileName?.schema?.enum?.includes('results.jsonl'),
    'Artifact file-name parameter should document results.jsonl.',
  );
  assert(
    runArtifact?.properties?.files?.required?.includes('results.jsonl'),
    'Run artifact schema should require results.jsonl.',
  );
  assert(
    Boolean(runArtifact?.properties?.files?.properties?.['results.jsonl']),
    'Run artifact schema should document results.jsonl.',
  );
  assert(
    Boolean(schemas?.ControlAgentIdentity?.properties?.region),
    'ControlAgentIdentity should document fleet region metadata.',
  );
  assert(
    schemas?.ControlAgentIdentity?.properties?.location?.$ref ===
      '#/components/schemas/RallarBlackBoxGeoLocation',
    'ControlAgentIdentity should document fleet location metadata.',
  );
  assert(
    schemas?.ControlFleetAgentLabel?.properties?.location?.$ref ===
      '#/components/schemas/RallarBlackBoxGeoLocation',
    'ControlFleetAgentLabel should document fleet report location metadata.',
  );
  assert(
    Boolean(geoLocation?.properties?.latitude && geoLocation?.properties?.longitude),
    'Fleet location schema should document latitude and longitude.',
  );
  assert(
    Boolean(fleetReport?.properties?.failureSignatures),
    'Fleet report schema should document failure signatures.',
  );
  assert(
    Boolean(fleetBundle?.properties?.files?.properties?.['summary.md']),
    'Fleet report bundle should document shareable summary.md.',
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

Deno.test('swagger route applies configured CORS origins', () => {
  const request = new Request('http://localhost:5180/api/openapi.json', {
    headers: {
      origin: 'http://localhost:5176',
    },
  });
  const response = handleSwaggerRoute(request, undefined, {
    corsOrigins: ['http://localhost:5176'],
  });
  assert(response);
  assertEquals(response.headers.get('access-control-allow-origin'), 'http://localhost:5176');
  assertEquals(response.headers.get('vary'), 'Origin');
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
