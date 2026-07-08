import { Hono } from 'jsr:@hono/hono@4.11.9';
import type { AuthSession } from '@shared/api/api-config.ts';
import type {
  GraphDiagnosticReadOptions,
  GraphDiagnosticReadResponse,
  GroupTopologyConfigPatch,
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { Either } from '@shared/resilience/Either.ts';
import {
  readGroupGraphDiagnostic,
  readScopedGlobalGraphDiagnostic,
} from '@shared-graph/graph-diagnostics-service.ts';
import {
  canReadGroupSnapshot,
  canUpdateGroupSnapshot,
  GroupPolicyDeniedError,
  isGroupPolicyDeniedError,
} from '@shared-server/rallar-system/group-policy.ts';
import { getGroupStateService } from '../services/group-state-service.ts';
import { requireApiAuthSession as defaultRequireApiAuthSession } from '../services/request-auth-service.ts';

export type GraphTopologyRouteAuthSession = Pick<
  AuthSession,
  'clientId' | 'sessionId'
>;

export type GraphTopologyGroupStateService = Readonly<{
  readSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined>;
}>;

export type GraphTopologyRouteGraphDiagnostics = Readonly<{
  readScopedGlobalGraphDiagnostic(
    scope: StateScope,
    options: GraphDiagnosticReadOptions,
  ): Either<string, GraphDiagnosticReadResponse>;
  readGroupGraphDiagnostic(
    groupRef: GroupRef,
    options: GraphDiagnosticReadOptions,
  ): Either<string, GraphDiagnosticReadResponse>;
}>;

export type GraphTopologyRouteTopologyManagement = Readonly<{
  readTopologyView(groupRef: GroupRef): Promise<unknown>;
  readConfig(groupRef: GroupRef): Promise<unknown>;
  putConfig(input: unknown): Promise<unknown>;
  deleteConfig(input: unknown): Promise<unknown>;
  readOverride(groupRef: GroupRef): Promise<unknown>;
  putOverride(input: unknown): Promise<unknown>;
  deleteOverride(input: unknown): Promise<unknown>;
  reconfigureGroupTopology(input: unknown): Promise<unknown>;
}>;

export type GraphTopologyRouteDependencies = Readonly<{
  getGroupStateService: () => GraphTopologyGroupStateService;
  graphDiagnostics: GraphTopologyRouteGraphDiagnostics;
  topologyManagement: GraphTopologyRouteTopologyManagement;
  requireApiAuthSession: (
    req: { header(name: string): string | undefined },
  ) => Promise<GraphTopologyRouteAuthSession>;
  adminClientIds: readonly string[];
  now: () => number;
}>;

export function init(
  app: Hono,
  dependencies: Partial<GraphTopologyRouteDependencies> = {},
): void {
  const deps = toDependencies(dependencies);

  app.get('/api/state/apps/:applicationId/workspaces/:workspaceId/graphs/global', (c) => {
    try {
      const result = deps.graphDiagnostics.readScopedGlobalGraphDiagnostic(
        toScope(c),
        readGraphOptions(c),
      );
      return toGraphDiagnosticResponse(c, result);
    } catch (error) {
      return toErrorResponse(c, error);
    }
  });

  app.get('/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/graphs/latest', async (c) => {
    try {
      const groupRef = toGroupRef(c);
      await assertGroupExists(groupRef, deps);
      await assertCanReadGroupRef(c.req, deps, groupRef);
      return toGraphDiagnosticResponse(
        c,
        deps.graphDiagnostics.readGroupGraphDiagnostic(groupRef, readGraphOptions(c)),
      );
    } catch (error) {
      return toErrorResponse(c, error);
    }
  });

  app.get('/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology', async (c) => {
    try {
      const groupRef = toGroupRef(c);
      await assertGroupExists(groupRef, deps);
      await assertCanReadGroupRef(c.req, deps, groupRef);
      return c.json(await deps.topologyManagement.readTopologyView(groupRef));
    } catch (error) {
      return toErrorResponse(c, error);
    }
  });

  app.get('/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/config', async (c) => {
    try {
      const groupRef = toGroupRef(c);
      await assertGroupExists(groupRef, deps);
      await assertCanReadGroupRef(c.req, deps, groupRef);
      return c.json(await deps.topologyManagement.readConfig(groupRef));
    } catch (error) {
      return toErrorResponse(c, error);
    }
  });

  app.put('/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/config', async (c) => {
    try {
      const { authSession, groupRef } = await assertCanManageGroupRef(c.req, deps, toGroupRef(c));
      const body = await readJsonBody<{
        requestId?: string;
        config: GroupTopologyConfigPatch;
        reconfigure?: boolean;
      }>(c);
      return c.json(await deps.topologyManagement.putConfig({
        groupRef,
        config: body.config,
        updatedByPrincipalId: authSession.clientId,
        requestId: readRequestId(c, body),
        reconfigure: body.reconfigure ?? true,
        publish: true,
      }));
    } catch (error) {
      return toErrorResponse(c, error);
    }
  });

  app.delete('/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/config', async (c) => {
    try {
      const { authSession, groupRef } = await assertCanManageGroupRef(c.req, deps, toGroupRef(c));
      return c.json(await deps.topologyManagement.deleteConfig({
        groupRef,
        updatedByPrincipalId: authSession.clientId,
        requestId: c.req.header('Idempotency-Key'),
        reconfigure: readReconfigureQuery(c),
        publish: true,
      }));
    } catch (error) {
      return toErrorResponse(c, error);
    }
  });

  app.get('/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/override', async (c) => {
    try {
      const groupRef = toGroupRef(c);
      await assertGroupExists(groupRef, deps);
      await assertCanReadGroupRef(c.req, deps, groupRef);
      return c.json(await deps.topologyManagement.readOverride(groupRef) ?? {});
    } catch (error) {
      return toErrorResponse(c, error);
    }
  });

  app.put('/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/override', async (c) => {
    try {
      const { authSession, groupRef } = await assertCanManageGroupRef(c.req, deps, toGroupRef(c));
      const body = await readJsonBody<{
        requestId?: string;
        config: GroupTopologyConfigPatch;
        ttlMs?: number;
        expiresAtEpochMs?: number;
        reconfigure?: boolean;
      }>(c);
      return c.json(await deps.topologyManagement.putOverride({
        groupRef,
        config: body.config,
        ttlMs: body.ttlMs,
        expiresAtEpochMs: body.expiresAtEpochMs,
        updatedByPrincipalId: authSession.clientId,
        requestId: readRequestId(c, body),
        reconfigure: body.reconfigure ?? true,
        publish: true,
      }));
    } catch (error) {
      return toErrorResponse(c, error);
    }
  });

  app.delete('/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/override', async (c) => {
    try {
      const { authSession, groupRef } = await assertCanManageGroupRef(c.req, deps, toGroupRef(c));
      return c.json(await deps.topologyManagement.deleteOverride({
        groupRef,
        updatedByPrincipalId: authSession.clientId,
        requestId: c.req.header('Idempotency-Key'),
        reconfigure: readReconfigureQuery(c),
        publish: true,
      }));
    } catch (error) {
      return toErrorResponse(c, error);
    }
  });

  app.post('/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/reconfigure', async (c) => {
    try {
      const { groupRef } = await assertCanManageGroupRef(c.req, deps, toGroupRef(c));
      const body = await readOptionalJsonBody<{
        requestId?: string;
        options?: GroupTopologyConfigPatch;
        publish?: boolean;
      }>(c, {});
      return c.json(await deps.topologyManagement.reconfigureGroupTopology({
        groupRef,
        requestOptions: body.options,
        publish: body.publish ?? true,
        requestId: readRequestId(c, body),
      }));
    } catch (error) {
      return toErrorResponse(c, error);
    }
  });
}

function toDependencies(
  dependencies: Partial<GraphTopologyRouteDependencies>,
): GraphTopologyRouteDependencies {
  return {
    getGroupStateService: dependencies.getGroupStateService ??
      (() => getGroupStateService()),
    graphDiagnostics: dependencies.graphDiagnostics ?? {
      readScopedGlobalGraphDiagnostic,
      readGroupGraphDiagnostic,
    },
    topologyManagement: dependencies.topologyManagement ??
      notConfiguredTopologyManagement(),
    requireApiAuthSession: dependencies.requireApiAuthSession ??
      defaultRequireApiAuthSession,
    adminClientIds: dependencies.adminClientIds ?? [],
    now: dependencies.now ?? (() => Date.now()),
  };
}

function notConfiguredTopologyManagement(): GraphTopologyRouteTopologyManagement {
  const fail = () => Promise.reject(new Error('Topology management is not configured'));
  return {
    readTopologyView: fail,
    readConfig: fail,
    putConfig: fail,
    deleteConfig: fail,
    readOverride: fail,
    putOverride: fail,
    deleteOverride: fail,
    reconfigureGroupTopology: fail,
  };
}

async function assertGroupExists(
  groupRef: GroupRef,
  deps: GraphTopologyRouteDependencies,
): Promise<GroupSnapshot> {
  const snapshot = await deps.getGroupStateService().readSnapshot(groupRef);
  if (!snapshot) {
    throw new Error(`Group not found: ${groupRef.groupId}`);
  }
  return snapshot;
}

async function assertCanReadGroupRef(
  req: { header(name: string): string | undefined },
  deps: GraphTopologyRouteDependencies,
  groupRef: GroupRef,
): Promise<void> {
  if (!isStrictReadAuthEnabled()) {
    return;
  }
  const authSession = await deps.requireApiAuthSession(req);
  const snapshot = await assertGroupExists(groupRef, deps);
  const result = canReadGroupSnapshot({
    snapshot,
    actor: { principalId: authSession.clientId },
  });
  if (!result.allowed) {
    throw new GroupPolicyDeniedError(result);
  }
}

async function assertCanManageGroupRef(
  req: { header(name: string): string | undefined },
  deps: GraphTopologyRouteDependencies,
  groupRef: GroupRef,
): Promise<Readonly<{
  authSession: GraphTopologyRouteAuthSession;
  groupRef: GroupRef;
  snapshot: GroupSnapshot;
}>> {
  const authSession = await deps.requireApiAuthSession(req);
  const snapshot = await assertGroupExists(groupRef, deps);
  if (deps.adminClientIds.includes(authSession.clientId)) {
    return { authSession, groupRef, snapshot };
  }

  const result = canUpdateGroupSnapshot({
    snapshot,
    actor: { principalId: authSession.clientId },
  });
  if (!result.allowed) {
    throw new GroupPolicyDeniedError(result);
  }

  return { authSession, groupRef, snapshot };
}

function toGraphDiagnosticResponse(
  c: { json(value: unknown, status?: number): Response },
  result: Either<string, GraphDiagnosticReadResponse>,
): Response {
  if (result.left !== undefined) {
    return c.json({ error: result.left }, graphDiagnosticErrorStatus(result.left));
  }
  return c.json(result.right);
}

function graphDiagnosticErrorStatus(message: string): number {
  return message.includes('No cached graph diagnostic') ||
      message.toLowerCase().includes('not found')
    ? 404
    : 400;
}

function readGraphOptions(c: {
  req: { query(name: string): string | undefined };
}): GraphDiagnosticReadOptions {
  const refresh = c.req.query('refresh') ?? 'if-missing';
  if (!['never', 'if-missing', 'always'].includes(refresh)) {
    throw new Error(`Invalid graph refresh mode: ${refresh}`);
  }

  return {
    includeMeasured: readBooleanQuery(c.req.query('includeMeasured')),
    refresh: refresh as GraphDiagnosticReadOptions['refresh'],
  };
}

function readBooleanQuery(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true' || value === '1';
}

function readReconfigureQuery(c: {
  req: { query(name: string): string | undefined };
}): boolean {
  return c.req.query('reconfigure')?.trim().toLowerCase() === 'false'
    ? false
    : true;
}

async function readJsonBody<T>(c: {
  req: { json(): Promise<unknown> };
}): Promise<T> {
  try {
    return await c.req.json() as T;
  } catch {
    const error = new Error('Malformed JSON request body') as Error & { status: number };
    error.status = 400;
    throw error;
  }
}

async function readOptionalJsonBody<T>(c: {
  req: { text(): Promise<string> };
}, fallback: T): Promise<T> {
  try {
    const raw = await c.req.text();
    if (raw.trim().length === 0) {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch {
    const error = new Error('Malformed JSON request body') as Error & { status: number };
    error.status = 400;
    throw error;
  }
}

function readRequestId(
  c: { req: { header(name: string): string | undefined } },
  body: { requestId?: string },
): string | undefined {
  return body.requestId ?? c.req.header('Idempotency-Key');
}

function toScope(c: {
  req: { param(key: 'applicationId' | 'workspaceId'): string };
}): StateScope {
  return {
    applicationId: c.req.param('applicationId'),
    workspaceId: c.req.param('workspaceId'),
  };
}

function toGroupRef(c: {
  req: { param(key: 'applicationId' | 'workspaceId' | 'groupId'): string };
}): GroupRef {
  return {
    ...toScope(c),
    groupId: c.req.param('groupId'),
  };
}

function isStrictReadAuthEnabled(): boolean {
  const value = Deno.env.get('RALLAR_STATE_STRICT_READ_AUTH');
  if (value === undefined || value.trim() === '') {
    return false;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function toErrorResponse(
  c: { json(value: unknown, status?: number): Response },
  error: unknown,
): Response {
  if (isGroupPolicyDeniedError(error)) {
    return c.json(
      {
        error: error.message,
        code: error.denial.code,
        message: error.denial.message,
        details: error.denial.details,
      },
      error.status,
    );
  }

  if (isStatusError(error)) {
    return c.json(
      {
        error: error.message,
        issues: error.issues,
      },
      error.status,
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  const status = message.includes('not found')
    ? 404
    : message.startsWith('Unauthorized:')
    ? 401
    : message.startsWith('Forbidden:')
    ? 403
    : message.includes('stale') || message.includes('conflict')
    ? 409
    : 400;

  return c.json({ error: message }, status);
}

function isStatusError(
  error: unknown,
): error is Error & { status: number; issues?: unknown } {
  return error instanceof Error &&
    typeof (error as { status?: unknown }).status === 'number';
}
