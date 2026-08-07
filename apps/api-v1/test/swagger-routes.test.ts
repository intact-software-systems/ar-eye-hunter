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

Deno.test('OpenAPI JSON includes black-box auth support contracts', async () => {
  const app = init(new Hono());
  const response = await app.request('/api/openapi.json');
  const json = await response.json() as {
    paths: Record<string, {
      post?: OpenApiOperation;
    }>;
    components: {
      parameters: Record<string, { required?: boolean; name?: string; in?: string }>;
      schemas: Record<
        string,
        {
          required?: string[];
          properties?: Record<string, unknown>;
        }
      >;
    };
  };

  assertAuthContract(
    'POST black-box control token',
    json.paths['/api/black-box/control-token']?.post,
    ['200', '401', '403', '503'],
  );
  assertAuthContract(
    'POST agent session tickets',
    json.paths['/api/auth/agent-session-tickets']?.post,
    ['200', '400', '401'],
  );
  assert.ok(
    json.paths['/api/auth/agent-session-tickets/consume']?.post?.responses?.['200'],
    'POST consume agent session ticket missing response 200',
  );
  assert.ok(
    json.paths['/api/auth/agent-session-tickets/consume']?.post?.responses?.['400'],
    'POST consume agent session ticket missing response 400',
  );
  assert.ok(
    json.paths['/api/auth/agent-session-tickets/consume']?.post?.responses?.['404'],
    'POST consume agent session ticket missing response 404',
  );
  assert.deepEqual(
    json.components.schemas.AgentSessionTicketRequest.required,
    ['agentIds'],
  );
  assert.deepEqual(
    json.components.schemas.AgentSessionTicketResponse.required,
    ['tickets'],
  );
  assert.deepEqual(
    json.components.schemas.ConsumeAgentSessionTicketRequest.required,
    ['ticket'],
  );
});

Deno.test('OpenAPI JSON requires an explicit nullable registration display name', async () => {
  const app = init(new Hono());
  const response = await app.request('/api/openapi.json');
  const json = await response.json() as {
    components: {
      schemas: Record<string, {
        required?: string[];
        properties?: Record<string, { nullable?: boolean }>;
      }>;
    };
  };
  const registerResponse = json.components.schemas.RegisterResponse;

  assert.ok(registerResponse.required?.includes('displayName'));
  assert.equal(registerResponse.properties?.displayName?.nullable, true);
});

Deno.test('OpenAPI JSON exposes mandatory convergent group state fields', async () => {
  const app = init(new Hono());
  const response = await app.request('/api/openapi.json');
  const json = await response.json() as {
    components: {
      schemas: Record<string, {
        required?: string[];
        properties?: Record<string, unknown>;
      }>;
    };
  };
  const schemas = json.components.schemas;

  assert.ok(schemas.Group.required?.includes('activeMemberCount'));
  assert.ok(schemas.Group.required?.includes('ownerPrincipalId'));
  assert.ok(schemas.Group.properties?.activeMemberCount);
  assert.ok(schemas.Group.properties?.ownerPrincipalId);
  assert.deepEqual(schemas.GroupStateCausalRevision.required, [
    'groupRevision',
    'presenceRevision',
  ]);
  assert.ok(schemas.GroupSnapshot.required?.includes('stateRevision'));
  assert.ok(schemas.GroupSnapshot.required?.includes('causalRevision'));
  assert.ok(schemas.GroupSnapshot.properties?.stateRevision);
  assert.ok(schemas.GroupSnapshot.properties?.causalRevision);
  assert.ok(schemas.GroupPresenceSession.required?.includes('generationId'));
  assert.ok(schemas.GroupPresenceSession.required?.includes('generationVersion'));
  assert.deepEqual(schemas.GroupJoinCodeResponse.required, [
    'joinCode',
    'expiresAtEpochMs',
    'snapshot',
  ]);
  assert.ok(schemas.GroupJoinCodeResponse.properties?.expiresAtEpochMs);
  for (
    const name of [
      'ConnectGroupPresenceSessionRequest',
      'HeartbeatGroupPresenceSessionRequest',
      'DisconnectGroupPresenceSessionRequest',
    ]
  ) {
    assert.ok(schemas[name]?.required?.includes('generationId'), name);
    assert.ok(schemas[name]?.properties?.generationId, name);
  }
});

Deno.test('OpenAPI JSON exposes point-read floors, headers, and status boundaries', async () => {
  const response = await init(new Hono()).request('/api/openapi.json');
  const json = await response.json() as {
    paths: Record<
      string,
      { get?: { parameters?: Array<{ $ref?: string }>; responses?: Record<string, unknown> } }
    >;
  };
  const clientPath =
    '/api/state/apps/{applicationId}/workspaces/{workspaceId}/clients/{principalId}';
  const groupPath = '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}';
  const client = json.paths[clientPath]?.get;
  const group = json.paths[groupPath]?.get;

  assert.ok(
    client?.parameters?.some((parameter) =>
      parameter.$ref === '#/components/parameters/MinStateRevision'
    ),
  );
  assert.ok(
    group?.parameters?.some((parameter) =>
      parameter.$ref === '#/components/parameters/MinGroupRevision'
    ),
  );
  assert.ok(
    group?.parameters?.some((parameter) =>
      parameter.$ref === '#/components/parameters/MinPresenceRevision'
    ),
  );
  for (const operation of [client, group]) {
    assert.deepEqual(Object.keys(operation?.responses ?? {}), [
      '200',
      '400',
      '401',
      '403',
      '404',
      '409',
      '429',
      '503',
    ]);
  }

  const clientCollection = json.paths[
    '/api/state/apps/{applicationId}/workspaces/{workspaceId}/clients'
  ]?.get;
  assert.ok(
    !clientCollection?.parameters?.some((parameter) => parameter.$ref?.includes('Revision')),
  );
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
      parameters: Record<string, {
        required?: boolean;
        name?: string;
        in?: string;
        description?: string;
        schema?: Record<string, unknown>;
      }>;
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

  assert.equal(json.paths['/api/graph'], undefined);
  assert.equal(json.paths['/api/graph/tree/{groupId}'], undefined);
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
  const topologyOverrideRequest = json.components.schemas
    .PutGroupTopologyOverrideRequest as {
      properties?: Record<string, { minimum?: number; description?: string }>;
    };
  assert.equal(topologyOverrideRequest.properties?.ttlMs?.minimum, 1);
  assert.match(
    topologyOverrideRequest.properties?.expiresAtEpochMs?.description ?? '',
    /future/i,
  );
  const topologyReceipt = json.components.schemas
    .GroupTopologyConfigMutationReceipt;
  assert.deepEqual(topologyReceipt.required, [
    'commandId',
    'requestId',
    'commandHash',
    'operation',
    'outcome',
    'attemptCount',
    'groupRef',
    'target',
    'acceptedVersion',
    'acceptedStorageRevision',
    'acceptedCreatedAtEpochMs',
    'acceptedUpdatedAtEpochMs',
    'acceptedExpiresAtEpochMs',
    'acceptedConfig',
    'acceptedCausalRevision',
    'eventId',
    'outboxId',
    'outboxIds',
  ]);
  assert.deepEqual(topologyReceipt.properties?.eventId, { type: 'null' });
  assert.deepEqual(
    json.components.schemas.GroupTopologyConfigAcceptedCausalRevision.required,
    [
      'stateRevision',
      'snapshotVersion',
      'metadataVersion',
      'rosterVersion',
      'presenceVersion',
      'causalRevision',
    ],
  );
  const reconfigureResponse = json.components.schemas
    .QueuedGroupTopologyReconfigureResponse as {
      required: string[];
      properties: { status: { enum: string[] } };
    };
  assert.deepEqual(reconfigureResponse.required, [
    'status',
    'groupRef',
    'requestId',
    'outboxId',
  ]);
  assert.deepEqual(reconfigureResponse.properties.status.enum, ['queued']);
  assert.deepEqual(json.components.parameters.IdempotencyKey, {
    name: 'Idempotency-Key',
    in: 'header',
    required: true,
    description: 'Stable request identifier for replaying an immutable topology mutation result.',
    schema: { type: 'string', minLength: 1 },
  });
  for (
    const schemaName of [
      'PutGroupTopologyConfigRequest',
      'PutGroupTopologyOverrideRequest',
      'ReconfigureGroupTopologyRequest',
    ]
  ) {
    const schema = json.components.schemas[schemaName] as {
      required?: string[];
      properties: { requestId?: { type?: string; minLength?: number } };
    };
    assert.ok(schema.required?.includes('requestId'), schemaName);
    assert.deepEqual(schema.properties.requestId, { type: 'string', minLength: 1 });
  }
  const topologyPatch = json.components.schemas.GroupTopologyConfigPatch as {
    properties: Record<string, { nullable?: boolean }>;
  };
  for (
    const field of [
      'topologyKind',
      'degreeLimit',
      'treeMinSize',
      'meshMinSize',
      'meshParamK',
    ]
  ) {
    assert.equal(topologyPatch.properties[field]?.nullable, true, `${field} clear contract`);
  }
  assert.deepEqual(
    json.components.schemas.TopologyMutationFailureResponse.required,
    ['error', 'code', 'message', 'issues', 'denial', 'retry'],
  );

  assertAuthContract(
    'GET scoped global graph',
    json.paths['/api/state/apps/{applicationId}/workspaces/{workspaceId}/graphs/global']
      .get,
    ['200', '401'],
  );
  for (
    const [label, operation] of [
      [
        'GET latest scoped group graph',
        json.paths[
          '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/graphs/latest'
        ].get,
      ],
      [
        'GET effective group topology',
        json.paths[
          '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology'
        ].get,
      ],
      [
        'GET durable group topology config',
        json.paths[
          '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology/config'
        ].get,
      ],
      [
        'PUT durable group topology config',
        json.paths[
          '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology/config'
        ].put,
      ],
      [
        'DELETE durable group topology config',
        json.paths[
          '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology/config'
        ].delete,
      ],
      [
        'GET temporary group topology override',
        json.paths[
          '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology/override'
        ].get,
      ],
      [
        'PUT temporary group topology override',
        json.paths[
          '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology/override'
        ].put,
      ],
      [
        'DELETE temporary group topology override',
        json.paths[
          '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology/override'
        ].delete,
      ],
      [
        'POST group topology reconfigure',
        json.paths[
          '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology/reconfigure'
        ].post,
      ],
    ] satisfies readonly (readonly [string, OpenApiOperation | undefined])[]
  ) {
    assertAuthContract(label, operation, ['200', '401', '403', '404']);
  }

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
  const mutationOperations = [
    json.paths[
      '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology/config'
    ].put,
    json.paths[
      '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology/config'
    ].delete,
    json.paths[
      '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology/override'
    ].put,
    json.paths[
      '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology/override'
    ].delete,
    json.paths[
      '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology/reconfigure'
    ].post,
  ];
  for (const operation of mutationOperations) {
    assert.deepEqual(parameterRefs(operation), [
      '#/components/parameters/ApplicationId',
      '#/components/parameters/WorkspaceId',
      '#/components/parameters/GroupId',
      '#/components/parameters/IdempotencyKey',
    ]);
    for (const code of ['403', '409', '422', '503']) {
      assert.equal(
        operation?.responses?.[code]?.$ref,
        '#/components/responses/TopologyMutationFailure',
        `topology mutation response ${code}`,
      );
    }
  }
  for (
    const operation of mutationOperations
  ) {
    assert.ok(operation?.responses?.['409']);
    assert.ok(operation?.responses?.['503']);
  }
});

Deno.test('OpenAPI JSON includes admin operations contracts', async () => {
  const app = init(new Hono());
  const response = await app.request('/api/openapi.json');
  const json = await response.json() as {
    paths: Record<string, {
      get?: OpenApiOperation;
      post?: OpenApiOperation;
    }>;
    components: {
      schemas: Record<string, unknown>;
    };
  };

  for (
    const [path, method] of [
      ['/api/admin/operations/overview', 'get'],
      ['/api/admin/operations/queues', 'get'],
      ['/api/admin/operations/realtime', 'get'],
      ['/api/admin/operations/state', 'get'],
      ['/api/admin/operations/state/apps/{applicationId}/workspaces/{workspaceId}', 'get'],
      ['/api/admin/operations/crdt', 'get'],
      ['/api/admin/operations/crdt/apps/{applicationId}/workspaces/{workspaceId}', 'get'],
      ['/api/admin/operations/system', 'get'],
      ['/api/admin/operations/metrics/reset', 'post'],
      ['/api/admin/operations/topology/recompute', 'post'],
      ['/api/admin/operations/maintenance/prune-expired', 'post'],
      ['/api/admin/operations/crdt/integrity', 'post'],
      ['/api/admin/operations/crdt/debug-export', 'post'],
      ['/api/admin/operations/crdt/compact', 'post'],
      ['/api/admin/operations/crdt/lifecycle', 'post'],
      ['/api/admin/operations/crdt/erase', 'post'],
    ] as const
  ) {
    assert.ok(json.paths[path]?.[method], `missing ${method.toUpperCase()} ${path}`);
    assertAuthContract(`${method.toUpperCase()} ${path}`, json.paths[path]?.[method], [
      '200',
      '401',
      '403',
    ]);
  }

  assert.ok(json.components.schemas.AdminOperationsOverviewResponse);
  assert.ok(json.components.schemas.AdminPruneExpiredRequest);
  assert.ok(json.components.schemas.AdminOperationResultResponse);
});

Deno.test('OpenAPI JSON includes admin support contracts', async () => {
  const app = init(new Hono());
  const response = await app.request('/api/openapi.json');
  const json = await response.json() as {
    paths: Record<string, {
      post?: OpenApiOperation;
    }>;
    components: {
      schemas: Record<string, unknown>;
    };
  };

  for (
    const path of [
      '/api/admin/support/explain/client',
      '/api/admin/support/explain/group',
      '/api/admin/support/explain/request',
      '/api/admin/support/explain/crdt-document',
      '/api/admin/support/explain/queue-item',
    ]
  ) {
    assert.ok(json.paths[path]?.post, `missing POST ${path}`);
    assertAuthContract(`POST ${path}`, json.paths[path]?.post, [
      '200',
      '401',
      '403',
    ]);
  }

  assert.ok(json.components.schemas.AdminSupportNarrativeResponse);
  assert.ok(json.components.schemas.AdminSupportExplainQueueItemRequest);
  assert.ok(json.components.schemas.AdminSupportExplainRequestRequest);
  const explainClientRequest = json.components.schemas
    .AdminSupportExplainClientRequest as {
      properties?: Record<string, { maximum?: number }>;
    };
  const explainGroupRequest = json.components.schemas
    .AdminSupportExplainGroupRequest as {
      properties?: Record<string, { maximum?: number }>;
    };
  assert.equal(explainClientRequest.properties?.limitRecentEvents?.maximum, 50);
  assert.equal(explainGroupRequest.properties?.limitRecentEvents?.maximum, 50);
});

Deno.test('OpenAPI JSON includes SPA statistics contracts', async () => {
  const app = init(new Hono());
  const response = await app.request('/api/openapi.json');
  const json = await response.json() as {
    paths: Record<string, {
      get?: OpenApiOperation;
    }>;
    components: {
      schemas: Record<string, unknown>;
    };
  };

  for (
    const path of [
      '/api/state/apps/{applicationId}/workspaces/{workspaceId}/stats/summary',
      '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/stats',
      '/api/state/apps/{applicationId}/workspaces/{workspaceId}/stats/me/realtime',
    ]
  ) {
    assert.ok(json.paths[path]?.get, `missing GET ${path}`);
    assertAuthContract(`GET ${path}`, json.paths[path]?.get, [
      '200',
      '401',
      '403',
    ]);
    assert.equal(
      json.paths[path]?.get?.responses?.['200'] &&
        JSON.stringify(json.paths[path]?.get?.responses?.['200']).includes('no-store'),
      true,
      `GET ${path} should document no-store actor-specific responses`,
    );
  }

  assert.ok(
    json.paths[
      '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/stats'
    ]?.get?.responses?.['404'],
  );
  assert.ok(json.components.schemas.WorkspaceSpaStatisticsResponse);
  assert.ok(json.components.schemas.GroupSpaStatisticsResponse);
  assert.ok(json.components.schemas.MyRealtimeSpaStatisticsResponse);
  const groupStatsResponse = json.components.schemas.GroupSpaStatisticsResponse as {
    properties?: Record<
      string,
      {
        allOf?: unknown[];
        required?: string[];
        properties?: Record<string, unknown>;
      }
    >;
  };
  const groupStatsGroup = groupStatsResponse.properties?.group;
  assert.equal(groupStatsGroup?.allOf, undefined);
  assert.deepEqual(groupStatsGroup?.required, [
    'groupId',
    'displayName',
    'kind',
    'status',
    'joinMode',
    'memberCount',
    'onlineMemberCount',
    'activeSessionCount',
    'snapshotVersion',
    'presenceVersion',
  ]);
  assert.equal(groupStatsGroup?.properties?.groupRef, undefined);
});

Deno.test('graph topology product docs describe implemented REST and recompute behavior', async () => {
  const apiReference = await Deno.readTextFile(
    new URL('../../../docs/rallar-api-reference.md', import.meta.url),
  );
  const rttDoc = await Deno.readTextFile(
    new URL('../../../docs/rallar-rtc-rtt-reporting.md', import.meta.url),
  );

  assert.match(apiReference, /\/graphs\/global/);
  assert.match(apiReference, /\/topology\/reconfigure/);
  assert.match(rttDoc, /REST reconfigure/i);
  assert.match(rttDoc, /shared recompute path/i);
});

Deno.test('admin operations product docs describe implemented REST auth and safety behavior', async () => {
  const apiReference = await Deno.readTextFile(
    new URL('../../../docs/rallar-api-reference.md', import.meta.url),
  );
  const envDocs = await Deno.readTextFile(
    new URL('../../../docs/environment-variables.md', import.meta.url),
  );

  assert.match(apiReference, /\/api\/admin\/operations\/overview/);
  assert.match(apiReference, /\/api\/admin\/operations\/maintenance\/prune-expired/);
  assert.match(apiReference, /payloads redacted/i);
  assert.match(envDocs, /admin operations/);
  assert.match(envDocs, /platform-admin allow-list/i);
});

Deno.test('SPA statistics product docs describe implemented REST auth and safety behavior', async () => {
  const apiReference = await Deno.readTextFile(
    new URL('../../../docs/rallar-api-reference.md', import.meta.url),
  );
  const envDocs = await Deno.readTextFile(
    new URL('../../../docs/environment-variables.md', import.meta.url),
  );

  assert.match(apiReference, /\/stats\/summary/);
  assert.match(apiReference, /\/stats\/me\/realtime/);
  assert.match(apiReference, /strict read auth independent/i);
  assert.match(apiReference, /does not expose admin operations/i);
  assert.match(envDocs, /SPA statistics/i);
});

type OpenApiOperation = {
  deprecated?: boolean;
  parameters?: readonly { $ref?: string }[];
  security?: readonly Record<string, readonly string[]>[];
  responses?: Record<string, { $ref?: string }>;
};

function parameterRefs(operation: OpenApiOperation | undefined): string[] {
  return operation?.parameters?.map((parameter) => parameter.$ref ?? '') ?? [];
}

function assertAuthContract(
  label: string,
  operation: OpenApiOperation | undefined,
  expectedResponseCodes: readonly string[],
): void {
  assert.deepEqual(
    operation?.security,
    [
      {
        bearerAuth: [],
        clientIdHeader: [],
      },
    ],
    `${label} security contract`,
  );

  for (const code of expectedResponseCodes) {
    assert.ok(operation?.responses?.[code], `${label} missing response ${code}`);
  }
}
