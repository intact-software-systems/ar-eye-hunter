import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';

import { controlOpenApiSpec, handleSwaggerRoute, swaggerFallbackResponse } from '../src/routes/swagger-routes.ts';

interface OpenApiSchema {
    readonly $ref?: string;
    readonly additionalProperties?: boolean;
    readonly enum?: readonly unknown[];
    readonly items?: OpenApiSchema;
    readonly properties?: Record<string, OpenApiSchema>;
    readonly required?: readonly string[];
    readonly schema?: OpenApiSchema;
}

test('OpenAPI explains durable result release and distinguishes acknowledgement from deferred cleanup', async () => {
    const response = handleSwaggerRoute(new Request('http://localhost:5180/openapi.json'));
    assert(response);
    const spec = await response.json();
    const operation = spec.paths['/runs/{runId}/agents/{agentId}/results/release']?.post;
    assert(operation);
    expect(operation).toMatchObject({
        security: [{ bearerAuth: [] }, { runTokenHeader: [] }, { queryToken: [] }],
        requestBody: {
            required: true,
            content: {
                'application/json': {
                    schema: {
                        type: 'object',
                        required: ['requestId', 'commandIds'],
                        properties: {
                            requestId: { type: 'string', minLength: 1 },
                            commandIds: { type: 'array', minItems: 1, maxItems: 1000, items: { type: 'string', minLength: 1 } }
                        }
                    }
                }
            }
        }
    });
    assert(operation.description.includes('durable capture'));
    assert(operation.description.includes('unavailable'));
    assert(operation.description.includes('tombstones'));
    assert(operation.responses['200'].description.includes('browser acknowledgement'));
    assert(operation.responses['409']);
    assert(operation.responses['400']);
    assert(operation.responses['401']);
});

test('control OpenAPI spec describes the current server and control endpoints', () => {
    const request = new Request('http://internal-control:5180/openapi.json', {
        headers: {
            'x-forwarded-host': 'control.rallar.intactss.com',
            'x-forwarded-proto': 'https'
        }
    });
    const spec = controlOpenApiSpec(request) as {
        openapi?: string;
        servers?: readonly { url: string; }[];
        paths?: Record<string, unknown>;
    };

    expect(spec.openapi).toEqual('3.1.0');
    expect(spec.servers?.[0]?.url).toEqual('/');
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
    const schemas = (spec as { components?: { schemas?: Record<string, OpenApiSchema>; }; }).components
        ?.schemas;
    const parameters = (spec as { components?: { parameters?: Record<string, OpenApiSchema>; }; })
        .components?.parameters;
    const crdtCapability = schemas?.ControlAgentIdentity?.properties?.capabilities
        ?.properties?.crdt;
    const runArtifact = schemas?.ControlRunArtifactBundle;
    const distributedArtifact = schemas?.ControlDistributedRunArtifactBundle;
    const fleetReport = schemas?.ControlFleetRunReport;
    const fleetBundle = schemas?.ControlFleetReportBundle;
    const geoLocation = schemas?.RallarBlackBoxGeoLocation;
    expect(crdtCapability?.required).toEqual(['supported']);
    assert(crdtCapability?.properties?.transports?.items?.enum?.includes('rtc-with-ws-fallback'));
    assert(distributedArtifact?.properties?.artifactSchemaVersion?.enum?.includes(2));
    assert(Boolean(distributedArtifact?.properties?.files?.properties?.['failures.json']));
    assert(parameters?.ArtifactFileName?.schema?.enum?.includes('results.jsonl'));
    assert(runArtifact?.properties?.files?.required?.includes('results.jsonl'));
    assert(Boolean(runArtifact?.properties?.files?.properties?.['results.jsonl']));
    assert(Boolean(schemas?.ControlAgentIdentity?.properties?.region));
    assert(
        schemas?.ControlAgentIdentity?.properties?.location?.$ref ===
            '#/components/schemas/RallarBlackBoxGeoLocation'
    );
    assert(
        schemas?.ControlFleetAgentLabel?.properties?.location?.$ref ===
            '#/components/schemas/RallarBlackBoxGeoLocation'
    );
    assert(Boolean(geoLocation?.properties?.latitude && geoLocation?.properties?.longitude));
    assert(Boolean(fleetReport?.properties?.failureSignatures));
    assert(Boolean(fleetBundle?.properties?.files?.properties?.['summary.md']));
});

test('control OpenAPI documents preview-first guarded retention compatibility', () => {
    const spec = controlOpenApiSpec(new Request('http://127.0.0.1:5180/openapi.json')) as {
        paths?: Record<string, {
            post?: {
                parameters?: readonly {
                    name?: string;
                    schema?: { enum?: readonly string[]; pattern?: string; maxLength?: number; };
                }[];
                responses?: Record<string, {
                    content?: { 'application/json'?: { schema?: { $ref?: string; oneOf?: unknown[]; }; }; };
                }>;
            };
        }>;
        components?: { schemas?: Record<string, OpenApiSchema>; };
    };
    const operation = spec.paths?.['/retention/cleanup']?.post;
    const dryRun = operation?.parameters?.find((parameter) => parameter.name === 'dryRun');
    const planToken = operation?.parameters?.find((parameter) => parameter.name === 'planToken');
    const success = operation?.responses?.['200']?.content?.['application/json']?.schema;
    const schemas = spec.components?.schemas;

    expect(dryRun?.schema?.enum).toEqual(['true']);
    expect(planToken?.schema?.maxLength).toEqual(512);
    assert(planToken?.schema?.pattern?.startsWith('^v1\\.'));
    expect(success?.oneOf).toEqual([
        { $ref: '#/components/schemas/RetentionCleanupResponse' },
        { $ref: '#/components/schemas/RetentionPreviewResponse' }
    ]);
    assert(operation?.responses?.['400']);
    assert(operation?.responses?.['401']);
    assert(operation?.responses?.['409']);
    assert(operation?.responses?.['413']);
    expect(schemas?.RetentionCleanupResponse?.required).toEqual([
        'deletedRunIds',
        'retainedRuns',
        'maxRuns'
    ]);
    expect(schemas?.RetentionCleanupResponse?.additionalProperties).toEqual(false);
    expect(schemas?.RetentionPreviewResponse?.additionalProperties).toEqual(false);
    expect(schemas?.RetentionCandidate?.additionalProperties).toEqual(false);
    assert(schemas?.RetentionPreviewResponse?.required?.includes('planToken'));
    assert(schemas?.RetentionPreviewResponse?.required?.includes('wouldDeleteRuns'));
    assert(Boolean(
        schemas?.RetentionCandidate?.properties?.issuedRunTokenCount &&
            schemas?.RetentionPreviewResponse?.properties?.preserves
    ));
});

test('swagger route serves OpenAPI JSON', async () => {
    const request = new Request('http://localhost:5180/api/openapi.json');
    const response = handleSwaggerRoute(request);
    assert(response);
    expect(response.status).toEqual(200);
    expect(response.headers.get('content-type')).toEqual('application/json');

    const body = await response.json();
    expect(body.info.title).toEqual('Rallar Black Box Control Server');
    expect(body.servers[0]).toEqual({
        url: '/',
        description: 'Current control server'
    });
});

test('swagger route applies configured CORS origins', () => {
    const request = new Request('http://localhost:5180/api/openapi.json', {
        headers: {
            origin: 'http://localhost:5176'
        }
    });
    const response = handleSwaggerRoute(request, undefined, {
        corsOrigins: ['http://localhost:5176']
    });
    assert(response);
    expect(response.headers.get('access-control-allow-origin')).toEqual('http://localhost:5176');
    expect(response.headers.get('vary')).toEqual('Origin');
});

test('swagger route serves Swagger UI HTML', async () => {
    const request = new Request('http://localhost:5180/swagger-ui');
    const response = handleSwaggerRoute(request);
    assert(response);
    expect(response.status).toEqual(200);
    assert(response.headers.get('content-type')?.startsWith('text/html'));

    const html = await response.text();
    assert(html.includes('SwaggerUIBundle'));
    assert(html.includes('/api/openapi.json'));
});

test('swagger route ignores non-doc paths', () => {
    const request = new Request('http://localhost:5180/health');
    expect(handleSwaggerRoute(request)).toEqual(undefined);
});

test('swagger fallback redirects reads to Swagger UI', () => {
    const response = swaggerFallbackResponse();
    expect(response.status).toEqual(302);
    expect(response.headers.get('location')).toEqual('/swagger-ui');
});
