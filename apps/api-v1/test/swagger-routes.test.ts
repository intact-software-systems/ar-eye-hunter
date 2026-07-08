import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import { init, resolvePublicServerUrl } from '../src/routes/swagger-routes.ts';

Deno.test('swagger public server URL trusts proxy HTTPS headers', () => {
  const request = new Request('http://internal-api:8080/swagger-ui', {
    headers: {
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'api.rallar.intactss.com',
    },
  });

  assert.equal(resolvePublicServerUrl(request), 'https://api.rallar.intactss.com');
});

Deno.test('swagger public server URL falls back to request origin', () => {
  const request = new Request('http://localhost:8080/swagger-ui');

  assert.equal(resolvePublicServerUrl(request), 'http://localhost:8080');
});

Deno.test('OpenAPI JSON route publishes the forwarded HTTPS server URL', async () => {
  const app = init(new Hono());
  const response = await app.request('/api/openapi.json', {
    headers: {
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'api.rallar.intactss.com',
    },
  });
  const json = await response.json() as { servers?: readonly { url: string }[] };

  assert.equal(json.servers?.[0]?.url, 'https://api.rallar.intactss.com');
});

Deno.test('OpenAPI JSON includes scoped graph and topology management contracts', async () => {
  const app = init(new Hono());
  const response = await app.request('/api/openapi.json');
  const json = await response.json() as {
    paths: Record<string, {
      deprecated?: boolean;
      get?: OpenApiOperation;
      put?: OpenApiOperation;
      delete?: OpenApiOperation;
      post?: OpenApiOperation;
    }>;
    components: {
      schemas: Record<
        string,
        {
          required?: string[];
          properties?: Record<string, unknown>;
          enum?: string[];
          minimum?: number;
        }
      >;
    };
  };

  for (
    const path of [
      '/api/state/apps/{applicationId}/workspaces/{workspaceId}/graphs/global',
      '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/graphs/latest',
      '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology',
      '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology/config',
      '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology/override',
      '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology/reconfigure',
    ]
  ) {
    assert.ok(json.paths[path], `missing OpenAPI path ${path}`);
  }

  assert.equal(json.paths['/api/graph'].get?.deprecated, true);
  assert.equal(json.paths['/api/graph/tree/{groupId}'].get?.deprecated, true);
  assert.deepEqual(json.components.schemas.GraphInfo.required, [
    'groupRef',
    'graph',
    'groupGraph',
    'coreNodes',
  ]);
  assert.deepEqual(json.components.schemas.GraphInfoSnapshot.required, [
    'groupRef',
    'predicted',
    'createdAtEpochMs',
    'version',
  ]);
  assert.deepEqual(
    json.components.schemas.GroupTopologyKindSetting.enum,
    ['auto', 'star', 'tree', 'mesh'],
  );
  assert.equal(json.components.schemas.GroupTopologyPositiveInteger.minimum, 1);
  assert.ok(
    json.components.schemas.ReconfigureGroupTopologyResponse.properties?.changed,
  );
  assert.ok(
    json.components.schemas.ReconfigureGroupTopologyResponse.properties?.published,
  );
  assert.ok(
    json.components.schemas.ReconfigureGroupTopologyResponse.properties?.snapshot,
  );
  assert.ok(
    json.components.schemas.ReconfigureGroupTopologyResponse.properties?.config,
  );

  assert.deepEqual(
    parameterRefs(
      json.paths['/api/state/apps/{applicationId}/workspaces/{workspaceId}/graphs/global']
        .get,
    ),
    [
      '#/components/parameters/ApplicationId',
      '#/components/parameters/WorkspaceId',
      '#/components/parameters/GraphIncludeMeasured',
      '#/components/parameters/GraphRefresh',
    ],
  );
  assert.deepEqual(
    parameterRefs(
      json.paths[
        '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/graphs/latest'
      ].get,
    ),
    [
      '#/components/parameters/ApplicationId',
      '#/components/parameters/WorkspaceId',
      '#/components/parameters/GroupId',
      '#/components/parameters/GraphIncludeMeasured',
      '#/components/parameters/GraphRefresh',
    ],
  );
  assert.deepEqual(
    parameterRefs(
      json.paths[
        '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology/config'
      ].delete,
    ),
    [
      '#/components/parameters/ApplicationId',
      '#/components/parameters/WorkspaceId',
      '#/components/parameters/GroupId',
      '#/components/parameters/TopologyReconfigure',
    ],
  );
  assert.deepEqual(
    parameterRefs(
      json.paths[
        '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology/override'
      ].delete,
    ),
    [
      '#/components/parameters/ApplicationId',
      '#/components/parameters/WorkspaceId',
      '#/components/parameters/GroupId',
      '#/components/parameters/TopologyReconfigure',
    ],
  );
});

Deno.test('graph topology product docs describe implemented REST and recompute behavior', async () => {
  const apiReference = await Deno.readTextFile('../../docs/rallar-api-reference.md');
  const rttDoc = await Deno.readTextFile('../../docs/rallar-rtc-rtt-reporting.md');

  assert.match(apiReference, /\/graphs\/global/);
  assert.match(apiReference, /\/topology\/reconfigure/);
  assert.match(rttDoc, /REST reconfigure/i);
  assert.match(rttDoc, /shared recompute path/i);
});

type OpenApiOperation = {
  deprecated?: boolean;
  parameters?: readonly { $ref?: string }[];
};

function parameterRefs(operation: OpenApiOperation | undefined): string[] {
  return operation?.parameters?.map((parameter) => parameter.$ref ?? '') ?? [];
}
