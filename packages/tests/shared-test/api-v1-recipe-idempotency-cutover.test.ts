import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  decodeJsonWireValue,
  type JsonWireObject,
  type JsonWireValue,
} from '@shared-server/rallar-system/services/mutation-command-identity.ts';

interface CoveredRecipeRequest {
  readonly body: JsonWireObject | undefined;
  readonly expectedBody: JsonWireObject | undefined;
  readonly expectedStatus: number | undefined;
  readonly file: string;
  readonly headers: JsonWireObject | undefined;
  readonly method: string;
  readonly name: string | undefined;
  readonly path: string;
}

interface MutationRoutePattern {
  readonly method: 'DELETE' | 'POST' | 'PUT';
  readonly path: RegExp;
}

interface SameLogicalActionRequestIdentityReuse {
  readonly actionNames: readonly string[];
  readonly file: string;
  readonly kind: 'concurrent-contenders' | 'sequential-replay';
  readonly requestId: string;
}

interface RequestIdentityIsolationProbe {
  readonly actionNames: readonly string[];
  readonly dimension: 'actor' | 'document' | 'operation' | 'scope';
  readonly file: string;
  readonly requestId: string;
}

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const recipeRoots = ['packages/shared-test/black-box-runner', 'apps/rallar-black-box'] as const;
const segment = '[^/]+';
const stateScope = `/api/state/apps/${segment}/workspaces/${segment}`;
const client = `${stateScope}/clients/${segment}`;
const instance = `${client}/instances/${segment}`;
const session = `${instance}/sessions/${segment}`;
const groupCollection = `${stateScope}/groups`;
const group = `${groupCollection}/${segment}`;
const mutationRoutes: readonly MutationRoutePattern[] = [
  ...[
    'register',
    'login',
    'logout',
    'ws-ticket',
    'agent-session-tickets',
    'agent-session-tickets/consume',
  ].map((suffix) => ({ method: 'POST' as const, path: exact(`/api/auth/${suffix}`) })),
  { method: 'PUT', path: exact(`${client}/principal`) },
  { method: 'PUT', path: exact(instance) },
  { method: 'PUT', path: exact(session) },
  { method: 'POST', path: exact(`${session}/heartbeat`) },
  { method: 'POST', path: exact(`${session}/disconnect`) },
  { method: 'POST', path: exact(groupCollection) },
  { method: 'PUT', path: exact(group) },
  ...[
    'director/appoint',
    'lifecycle/establish',
    'lifecycle/activate',
    'lifecycle/reopen',
    'join',
    `invites/${segment}`,
    `invites/${segment}/revoke`,
    'invites/accept',
    'join-code/rotate',
    `members/${segment}/remove`,
    `members/${segment}/ban`,
    `members/${segment}/unban`,
    'owner/transfer',
    `sessions/${segment}/heartbeat`,
    `sessions/${segment}/disconnect`,
    'topology/reconfigure',
  ].map((suffix) => ({ method: 'POST' as const, path: exact(`${group}/${suffix}`) })),
  { method: 'PUT', path: exact(`${group}/members/${segment}/role`) },
  { method: 'PUT', path: exact(`${group}/members/${segment}`) },
  { method: 'PUT', path: exact(`${group}/sessions/${segment}`) },
  { method: 'PUT', path: exact(`${group}/topology/config`) },
  { method: 'DELETE', path: exact(`${group}/topology/config`) },
  { method: 'PUT', path: exact(`${group}/topology/override`) },
  { method: 'DELETE', path: exact(`${group}/topology/override`) },
  ...[
    '/api/admin/operations/topology/recompute',
    '/api/admin/operations/maintenance/prune-expired',
    '/api/admin/operations/crdt/compact',
    '/api/admin/operations/crdt/lifecycle',
    '/api/admin/operations/crdt/erase',
    '/api/crdt/admin/documents/rebuild-projection',
    '/api/crdt/admin/documents/compact',
    '/api/crdt/admin/documents/lifecycle',
    '/api/crdt/admin/documents/erase',
  ].map((routePath) => ({ method: 'POST' as const, path: exact(routePath) })),
];
const identityRejectionSteps = new Set([
  'rejectBodyRequestIdentity',
  'rejectHeaderRequestIdentity',
  'rejectTopologyConfigBodyRequestIdentity',
  'rejectTopologyConfigIdempotencyHeader',
  'rejectTopologyConfigMultipleRequestIdentitySources',
]);
const apiV1RecipeDirectory = 'packages/shared-test/black-box-runner/tests/api-v1';
const sameLogicalActionRequestIdentityReuse: readonly SameLogicalActionRequestIdentityReuse[] = [
  {
    actionNames: [
      'rejectConflictingAlicePrincipalReplay',
      'replayEquivalentAlicePrincipal',
      'upsertAlicePrincipal',
    ],
    file: `${apiV1RecipeDirectory}/api-v1-client-state.json`,
    kind: 'sequential-replay',
    requestId: 'upsert-principal-scope-{runId}',
  },
  {
    actionNames: [
      'firstCrdtHttpMutation',
      'rejectChangedCrdtHttpIntent',
      'replayCrdtHttpMutation',
    ],
    file: `${apiV1RecipeDirectory}/api-v1-idempotency-contract.json`,
    kind: 'sequential-replay',
    requestId: 'idem-contract-crdt-http-{runId}',
  },
  {
    actionNames: ['differentContenderPrimary', 'differentContenderSecondary'],
    file: `${apiV1RecipeDirectory}/api-v1-idempotency-contract.json`,
    kind: 'concurrent-contenders',
    requestId: 'idem-contract-different-contenders-{runId}',
  },
  {
    actionNames: [
      'exactGroupReplayAfterSessionRenewal',
      'firstGroupMutation',
      'normalizedGroupReplay',
      'rejectChangedGroupIntent',
    ],
    file: `${apiV1RecipeDirectory}/api-v1-idempotency-contract.json`,
    kind: 'sequential-replay',
    requestId: 'idem-contract-group-replay-{runId}',
  },
  {
    actionNames: ['firstLogout', 'replayLogout'],
    file: `${apiV1RecipeDirectory}/api-v1-idempotency-contract.json`,
    kind: 'sequential-replay',
    requestId: 'idem-contract-logout-replay-{runId}',
  },
  {
    actionNames: ['performNoOpMutation', 'replayNoOpMutation'],
    file: `${apiV1RecipeDirectory}/api-v1-idempotency-contract.json`,
    kind: 'sequential-replay',
    requestId: 'idem-contract-no-op-{runId}',
  },
  {
    actionNames: ['replayTerminalFailure', 'replayTerminalFailureFirst'],
    file: `${apiV1RecipeDirectory}/api-v1-idempotency-contract.json`,
    kind: 'sequential-replay',
    requestId: 'idem-contract-terminal-failure-{runId}',
  },
  {
    actionNames: ['firstTopologyRestartBoundary', 'replayTopologyAfterRestartBoundary'],
    file: `${apiV1RecipeDirectory}/api-v1-idempotency-contract.json`,
    kind: 'sequential-replay',
    requestId: 'idem-contract-topology-restart-{runId}',
  },
  {
    actionNames: ['changedDuplicatePrimary', 'changedDuplicateSecondary'],
    file: `${apiV1RecipeDirectory}/api-v1-state-medium-scale-churn.json`,
    kind: 'concurrent-contenders',
    requestId: 'medium-scale-changed-duplicate-wave-{runId}',
  },
  {
    actionNames: ['equalDuplicatePrimary', 'equalDuplicateSecondary', 'equalDuplicateTertiary'],
    file: `${apiV1RecipeDirectory}/api-v1-state-medium-scale-churn.json`,
    kind: 'concurrent-contenders',
    requestId: 'medium-scale-equal-duplicate-wave-{runId}',
  },
];
const requestIdentityIsolationProbes: readonly RequestIdentityIsolationProbe[] = [
  {
    actionNames: ['proveActorIsolation', 'seedActorIsolation'],
    dimension: 'actor',
    file: `${apiV1RecipeDirectory}/api-v1-idempotency-contract.json`,
    requestId: 'idem-contract-actor-isolation-{runId}',
  },
  {
    actionNames: ['proveDocumentIsolation', 'seedDocumentIsolation'],
    dimension: 'document',
    file: `${apiV1RecipeDirectory}/api-v1-idempotency-contract.json`,
    requestId: 'idem-contract-document-isolation-{runId}',
  },
  {
    actionNames: [
      'equalContenderPrimary',
      'equalContenderSecondary',
      'equalContenderTertiary',
      'proveOperationIsolation',
    ],
    dimension: 'operation',
    file: `${apiV1RecipeDirectory}/api-v1-idempotency-contract.json`,
    requestId: 'idem-contract-equal-contenders-{runId}',
  },
  {
    actionNames: [
      'firstNormalizedPruneCategories',
      'proveAdminActorIsolation',
      'replayNormalizedPruneCategories',
    ],
    dimension: 'actor',
    file: `${apiV1RecipeDirectory}/api-v1-idempotency-contract.json`,
    requestId: 'idem-contract-prune-normalized-{runId}',
  },
  {
    actionNames: ['proveScopeIsolation', 'seedScopeIsolation'],
    dimension: 'scope',
    file: `${apiV1RecipeDirectory}/api-v1-idempotency-contract.json`,
    requestId: 'idem-contract-scope-isolation-{runId}',
  },
];

describe('API-v1 recipe mutation identity cutover', () => {
  it('uses strict path-only request identity in every covered JSON recipe request', () => {
    const requests = readCoveredRecipeRequests();
    const staleRequests = requests.filter((request) => mutationIdentityIssues(request).length > 0);

    expect(mutationRoutes).toHaveLength(45);
    if (staleRequests.length > 0) {
      const examples = staleRequests
        .slice(0, 100)
        .map(
          (request) =>
            `${request.file}: ${request.method} ${request.path} ` +
            `[${mutationIdentityIssues(request).join(', ')}]`,
        );
      throw new Error(
        `${staleRequests.length} covered recipe requests retain stale mutation identity:\n` +
          examples.join('\n'),
      );
    }
  });

  it('expects mutation results to echo the strict path request identity', () => {
    const staleExpectations = readCoveredRecipeRequests().flatMap((request) => {
      const pathRequestId = readPathRequestId(request.path);
      const expectedRequestId = request.expectedBody?.requestId;
      if (
        !pathRequestId ||
        typeof expectedRequestId !== 'string' ||
        expectedRequestId === pathRequestId
      ) {
        return [];
      }
      return [`${request.file}:${request.name ?? '<unnamed>'}: ${expectedRequestId}`];
    });

    expect(staleExpectations).toEqual([]);
  });

  it('expects durable topology reads to retain the path-owned write identity', () => {
    const recipe = readApiV1Recipe('api-v1-state-write-convergence.json');
    const write = findNamedObject(recipe, 'putFinalTopologyConfig');
    const writePath = optionalObject(write?.request)?.path;
    const requestId = typeof writePath === 'string' ? readPathRequestId(writePath) : undefined;

    expect(requestId).toBeDefined();
    for (const readName of [
      'readPrimaryDurableConfig',
      'readSecondaryDurableConfig',
      'readTertiaryDurableConfig',
    ]) {
      const read = findNamedObject(recipe, readName);
      const durable = optionalObject(optionalObject(optionalObject(read?.expect)?.body)?.durable);

      expect(durable?.requestId, readName).toBe(requestId);
    }
  });

  it('keeps strict mutation request identities private to one API-v1 recipe', () => {
    const requests = readCoveredRecipeRequests().filter((request) =>
      request.file.startsWith(`${apiV1RecipeDirectory}/`),
    );
    const filesByRequestId = new Map<string, Set<string>>();
    for (const request of requests) {
      const requestId = readPathRequestId(request.path);
      if (!requestId) {
        continue;
      }
      const files = filesByRequestId.get(requestId) ?? new Set<string>();
      files.add(request.file);
      filesByRequestId.set(requestId, files);
    }
    const collisions = [...filesByRequestId]
      .filter(([, files]) => files.size > 1)
      .map(([requestId, files]) => `${requestId}: ${[...files].sort().join(', ')}`)
      .sort();

    expect(collisions).toEqual([]);
  });

  it('permits identity reuse only for named equivalence or isolation probes', () => {
    const requests = readCoveredRecipeRequests().filter((request) =>
      request.file.startsWith(`${apiV1RecipeDirectory}/`),
    );
    const actionsByRecipeRequestId = new Map<string, string[]>();
    for (const request of requests) {
      const requestId = readPathRequestId(request.path);
      if (!requestId) {
        continue;
      }
      const key = `${request.file}\n${requestId}`;
      const actions = actionsByRecipeRequestId.get(key) ?? [];
      actions.push(request.name ?? '<unnamed>');
      actionsByRecipeRequestId.set(key, actions);
    }
    const reuse = [...actionsByRecipeRequestId]
      .filter(([, actions]) => actions.length > 1)
      .map(([key, actions]) => {
        const [file, requestId] = key.split('\n');
        return { actionNames: actions.sort(), file, requestId };
      })
      .sort((left, right) =>
        `${left.file}\n${left.requestId}`.localeCompare(`${right.file}\n${right.requestId}`),
      );
    const expectedReuse = [
      ...sameLogicalActionRequestIdentityReuse,
      ...requestIdentityIsolationProbes,
    ]
      .map(({ actionNames, file, requestId }) => ({ actionNames, file, requestId }))
      .sort((left, right) =>
        `${left.file}\n${left.requestId}`.localeCompare(`${right.file}\n${right.requestId}`),
      );

    expect(reuse).toEqual(expectedReuse);
  });

  it('preserves legacy auth failures for reads and non-AppInbox routes', () => {
    for (const [file, stepName] of [
      ['api-v1-auth-session.json', 'rejectMissingBearerToken'],
      ['api-v1-admin-operations.json', 'rejectMissingAdminAuth'],
      ['api-v1-black-box-control-auth.json', 'rejectMissingControlTokenAuth'],
    ] as const) {
      const step = findNamedObject(readApiV1Recipe(file), stepName);

      expect(step?.expect, `${file}:${stepName}`).toEqual({
        status: 401,
        body: { error: 'Unauthorized: Missing bearer token' },
      });
    }
  });

  it('expects topology writes only on strict OpenAPI request paths', () => {
    const step = findNamedObject(
      readApiV1Recipe('api-v1-openapi-topology-auth.json'),
      'openApiListsGraphTopologyAuth',
    );
    const expectedPaths = optionalObject(optionalObject(step?.expect)?.body)?.paths;
    const paths = optionalObject(expectedPaths);
    const prefix =
      '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology';

    expect(optionalObject(paths?.[`${prefix}/config`])).toHaveProperty('get');
    expect(optionalObject(paths?.[`${prefix}/config`])).not.toHaveProperty('put');
    expect(optionalObject(paths?.[`${prefix}/config`])).not.toHaveProperty('delete');
    expect(optionalObject(paths?.[`${prefix}/override`])).toHaveProperty('get');
    expect(optionalObject(paths?.[`${prefix}/override`])).not.toHaveProperty('put');
    expect(optionalObject(paths?.[`${prefix}/override`])).not.toHaveProperty('delete');
    expect(optionalObject(paths?.[`${prefix}/config/requests/{requestId}`])).toMatchObject({
      put: expect.any(Object),
      delete: expect.any(Object),
    });
    expect(optionalObject(paths?.[`${prefix}/override/requests/{requestId}`])).toMatchObject({
      put: expect.any(Object),
      delete: expect.any(Object),
    });
    expect(optionalObject(paths?.[`${prefix}/reconfigure/requests/{requestId}`])).toHaveProperty(
      'post',
    );
    expect(paths).not.toHaveProperty(`${prefix}/reconfigure`);
  });

  it('uses the canonical failure code owned by each mutation family', () => {
    for (const [file, stepName, code] of [
      [
        'api-v1-client-state.json',
        'rejectConflictingAlicePrincipalReplay',
        'app-inbox-idempotency-conflict',
      ],
      [
        'api-v1-black-box-control-auth.json',
        'rejectConsumedAgentSessionTicket',
        'auth-mutation-rejected',
      ],
      [
        'api-v1-presence-lease-bound.json',
        'rejectGroupPresenceFutureHeartbeat',
        'group-mutation-rejected',
      ],
      [
        'api-v1-presence-lease-bound.json',
        'rejectGroupPresenceFutureConnected',
        'group-mutation-rejected',
      ],
      [
        'api-v1-presence-lease-bound.json',
        'rejectClientSessionFutureHeartbeat',
        'client-mutation-rejected',
      ],
      [
        'api-v1-group-lifecycle-transitions.json',
        'bobCannotStartEstablishment',
        'member-not-active',
      ],
      [
        'api-v1-idempotency-contract.json',
        'rejectChangedGroupIntent',
        'app-inbox-idempotency-conflict',
      ],
    ] as const) {
      const step = findNamedObject(readApiV1Recipe(file), stepName);
      const expectedBody = optionalObject(optionalObject(step?.expect)?.body);

      expect(expectedBody?.code, `${file}:${stepName}`).toBe(code);
    }
  });

  it('replays the exact canonical terminal failure exposed by the live route', () => {
    const recipe = readApiV1Recipe('api-v1-idempotency-contract.json');
    for (const stepName of ['replayTerminalFailureFirst', 'replayTerminalFailure']) {
      const step = findNamedObject(recipe, stepName);
      const expected = optionalObject(step?.expect);

      expect(expected, stepName).toMatchObject({
        status: 500,
        body: {
          type: 'api-mutation-failure',
          version: 'canonical.v1',
          code: 'api-mutation-unexpected',
          status: 500,
        },
      });
    }
  });

  it('does not require already-consumed admin prune pages in final queue evidence', () => {
    const evidence = findNamedObject(
      readApiV1Recipe('api-v1-admin-operations.json'),
      'exposeStateWriteEvidence',
    );
    const request = optionalObject(evidence?.request);
    const spec = optionalObject(request?.stateWriteEvidence);

    expect(spec).toEqual({
      match: 'bb-request-prune-{executionToken}',
      commandTypes: ['ADMIN_PRUNE_EXPIRED'],
      minimumMatchedRows: 1,
    });
  });
});

function readApiV1Recipe(file: string): JsonWireValue {
  const recipePath = path.join(
    repoRoot,
    'packages/shared-test/black-box-runner/tests/api-v1',
    file,
  );
  return decodeJsonWireValue(JSON.parse(readFileSync(recipePath, 'utf8')), file);
}

function findNamedObject(value: JsonWireValue, name: string): JsonWireObject | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findNamedObject(item, name);
      if (match) {
        return match;
      }
    }
    return undefined;
  }
  const object = optionalObject(value);
  if (!object) {
    return undefined;
  }
  if (object.name === name) {
    return object;
  }
  for (const child of Object.values(object)) {
    const match = findNamedObject(child, name);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function readCoveredRecipeRequests(): readonly CoveredRecipeRequest[] {
  const requests: CoveredRecipeRequest[] = [];
  for (const recipeRoot of recipeRoots) {
    for (const file of readJsonFiles(path.join(repoRoot, recipeRoot))) {
      const value = decodeJsonWireValue(
        JSON.parse(readFileSync(file, 'utf8')),
        path.relative(repoRoot, file),
      );
      collectCoveredRequests(value, path.relative(repoRoot, file), requests);
    }
  }
  return requests;
}

function collectCoveredRequests(
  value: JsonWireValue,
  file: string,
  requests: CoveredRecipeRequest[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectCoveredRequests(item, file, requests);
    }
    return;
  }
  const object = optionalObject(value);
  if (!object) {
    return;
  }
  const request = optionalObject(object.request);
  const method = typeof request?.method === 'string' ? request.method.toUpperCase() : undefined;
  const routePath = typeof request?.path === 'string' ? request.path : undefined;
  if (request && method && routePath && isCoveredMutation(method, routePath)) {
    const expected = optionalObject(object.expect);
    requests.push({
      body: optionalObject(request.body),
      expectedBody: optionalObject(expected?.body),
      expectedStatus: typeof expected?.status === 'number' ? expected.status : undefined,
      file,
      headers: optionalObject(request.headers),
      method,
      name: typeof object.name === 'string' ? object.name : undefined,
      path: routePath,
    });
  }
  for (const child of Object.values(object)) {
    collectCoveredRequests(child, file, requests);
  }
}

function mutationIdentityIssues(request: CoveredRecipeRequest): readonly string[] {
  const issues: string[] = [];
  const requestId = readPathRequestId(request.path);
  if (!requestId) {
    if (!isOldPathRejection(request)) {
      issues.push('old-path');
    }
  } else if (!isValidRequestIdTemplate(requestId)) {
    issues.push('invalid-path-request-id');
  }
  const hasBodyIdentity = request.body?.requestId !== undefined;
  const hasHeaderIdentity =
    request.headers &&
    Object.keys(request.headers).some((name) => name.toLowerCase() === 'idempotency-key');
  if (hasBodyIdentity && !isCanonicalIdentityRejection(request)) {
    issues.push('body-request-id');
  }
  if (hasHeaderIdentity && !isCanonicalIdentityRejection(request)) {
    issues.push('idempotency-header');
  }
  if (
    requestId &&
    request.expectedStatus !== undefined &&
    request.expectedStatus >= 400 &&
    !hasCanonicalFailureExpectation(request)
  ) {
    issues.push('noncanonical-failure-expectation');
  }
  return issues;
}

function isOldPathRejection(request: CoveredRecipeRequest): boolean {
  return request.name === 'rejectOldMutationPath' && request.expectedStatus === 404;
}

function isCanonicalIdentityRejection(request: CoveredRecipeRequest): boolean {
  return (
    request.name !== undefined &&
    identityRejectionSteps.has(request.name) &&
    request.expectedStatus === 400 &&
    hasCanonicalFailureExpectation(request)
  );
}

function hasCanonicalFailureExpectation(request: CoveredRecipeRequest): boolean {
  return (
    typeof request.expectedBody?.code === 'string' &&
    request.expectedBody?.type === 'api-mutation-failure' &&
    request.expectedBody.version === 'canonical.v1' &&
    request.expectedBody.status === request.expectedStatus
  );
}

function isCoveredMutation(method: string, routePath: string): boolean {
  const basePath = routePath.replace(/\/requests\/[^/]+$/, '');
  return mutationRoutes.some((route) => route.method === method && route.path.test(basePath));
}

function readPathRequestId(routePath: string): string | undefined {
  const match = /\/requests\/([^/]+)$/.exec(routePath);
  return match?.[1];
}

function isValidRequestIdTemplate(requestId: string): boolean {
  const representative = requestId.replace(/\{[^{}]+\}/g, 'placeholder');
  return (
    representative.length >= 20 &&
    representative.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(representative)
  );
}

function exact(source: string): RegExp {
  return new RegExp(`^${source}$`);
}

function readJsonFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return readJsonFiles(entryPath);
    }
    return entry.isFile() && entry.name.endsWith('.json') ? [entryPath] : [];
  });
}

function optionalObject(value: JsonWireValue | undefined): JsonWireObject | undefined {
  return value !== undefined && isJsonWireObject(value) ? value : undefined;
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
