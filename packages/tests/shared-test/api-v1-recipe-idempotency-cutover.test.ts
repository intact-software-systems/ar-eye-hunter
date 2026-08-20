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
});

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
