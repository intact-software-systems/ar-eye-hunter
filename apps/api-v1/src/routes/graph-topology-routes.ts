import { Hono } from 'jsr:@hono/hono@4.11.9';
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
} from '@shared-server/rallar-system/group-policy.ts';
import { getGroupStateService } from '../services/group-state-service.ts';
import { requireApiAuthSession as defaultRequireApiAuthSession } from '../services/request-auth-service.ts';
import { getMiddleware } from '../middleware.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import {
  type TopologyAppInboxCommand,
  type TopologyAppInboxRequestPayload,
  toTopologyAppInboxCommand,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import {
  type AppInboxEnqueueInput,
    type AppInboxFailure,
  AppInboxType,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import {
    toGraphTopologyErrorResponse as toErrorResponse,
    TopologyAppInboxFailureError,
} from './graph-topology-route-errors.ts';

export type GraphTopologyRouteAuthSession = Pick<
  IssuedAuthSession,
  | 'clientId'
  | 'sessionId'
  | 'accessToken'
  | 'username'
  | 'issuedAtEpochMs'
  | 'expiresAtEpochMs'
>;

export type ProcessTopologyAppInbox = (
  authority: GraphTopologyRouteAuthSession,
  enqueue: AppInboxEnqueueInput<TopologyAppInboxCommand>,
) => Promise<unknown>;

export type GraphTopologyAppInboxService = Readonly<{
    processAuthenticatedEntryUntilCompletionResult<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
        authority: IssuedAuthSession,
    ): Promise<Either<AppInboxFailure, R>>;
}>;

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
  processTopologyAppInbox: ProcessTopologyAppInbox;
    readAppGroupInboxService: () => GraphTopologyAppInboxService;
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

  app.get('/api/state/apps/:applicationId/workspaces/:workspaceId/graphs/global', async (c) => {
    try {
      await assertCanReadScopedGlobalGraph(c.req, deps);
      const result = deps.graphDiagnostics.readScopedGlobalGraphDiagnostic(
        toScope(c),
        readGraphOptions(c),
      );
      return toGraphDiagnosticResponse(c, result);
    } catch (error) {
      return toErrorResponse(c, error);
    }
  });

  app.get(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/graphs/latest',
    async (c) => {
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
    },
  );

  app.get(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology',
    async (c) => {
      try {
        const groupRef = toGroupRef(c);
        await assertGroupExists(groupRef, deps);
        await assertCanReadGroupRef(c.req, deps, groupRef);
        return c.json(await deps.topologyManagement.readTopologyView(groupRef));
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.get(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/config',
    async (c) => {
      try {
        const groupRef = toGroupRef(c);
        await assertGroupExists(groupRef, deps);
        await assertCanReadGroupRef(c.req, deps, groupRef);
        return c.json(await deps.topologyManagement.readConfig(groupRef));
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.put(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/config',
    async (c) => {
      try {
                const { authSession, groupRef } = await assertCanManageGroupRef(
                    c.req,
                    deps,
                    toGroupRef(c),
                );
        const body = await readJsonBody<{
          requestId?: string;
          config: GroupTopologyConfigPatch;
        }>(c);
        return c.json(
          await writeTopologyAppInboxCommand(deps, authSession, groupRef, {
            requestId: requireRequestId(c, body),
            payload: { operation: 'putConfig', config: body.config },
          }),
        );
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.delete(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/config',
    async (c) => {
      try {
                const { authSession, groupRef } = await assertCanManageGroupRef(
                    c.req,
                    deps,
                    toGroupRef(c),
                );
        return c.json(
          await writeTopologyAppInboxCommand(deps, authSession, groupRef, {
            requestId: requireRequestId(c, {}),
            payload: { operation: 'deleteConfig', target: 'config' },
          }),
        );
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.get(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/override',
    async (c) => {
      try {
        const groupRef = toGroupRef(c);
        await assertGroupExists(groupRef, deps);
        await assertCanReadGroupRef(c.req, deps, groupRef);
        return c.json(await deps.topologyManagement.readOverride(groupRef) ?? {});
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.put(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/override',
    async (c) => {
      try {
                const { authSession, groupRef } = await assertCanManageGroupRef(
                    c.req,
                    deps,
                    toGroupRef(c),
                );
        const body = await readJsonBody<{
          requestId?: string;
          config: GroupTopologyConfigPatch;
          ttlMs?: number;
          expiresAtEpochMs?: number;
        }>(c);
        return c.json(
          await writeTopologyAppInboxCommand(deps, authSession, groupRef, {
            requestId: requireRequestId(c, body),
            payload: {
              operation: 'putOverride',
              config: body.config,
              ttlMs: body.expiresAtEpochMs === undefined ? body.ttlMs ?? null : null,
              expiresAtEpochMs: body.expiresAtEpochMs ?? null,
            },
          }),
        );
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.delete(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/override',
    async (c) => {
      try {
                const { authSession, groupRef } = await assertCanManageGroupRef(
                    c.req,
                    deps,
                    toGroupRef(c),
                );
        return c.json(
          await writeTopologyAppInboxCommand(deps, authSession, groupRef, {
            requestId: requireRequestId(c, {}),
            payload: { operation: 'deleteOverride', target: 'override' },
          }),
        );
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );

  app.post(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/reconfigure',
    async (c) => {
      try {
        const { authSession, groupRef } = await assertCanManageGroupRef(
          c.req,
          deps,
          toGroupRef(c),
        );
        const body = await readOptionalJsonBody<{
          requestId?: string;
          options?: GroupTopologyConfigPatch;
          publish?: boolean;
        }>(c, {});
        return c.json(
          await writeTopologyAppInboxCommand(deps, authSession, groupRef, {
            requestId: requireRequestId(c, body),
            payload: {
              operation: 'reconfigureTopology',
              requestOptions: body.options ?? {},
              publish: body.publish ?? true,
            },
          }),
        );
      } catch (error) {
        return toErrorResponse(c, error);
      }
    },
  );
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
    processTopologyAppInbox: dependencies.processTopologyAppInbox ??
            ((authority, enqueue) =>
                defaultProcessTopologyAppInbox(
                    dependencies.readAppGroupInboxService?.() ??
                        getMiddleware().appGroupInboxService,
                    authority,
                    enqueue,
                )),
        readAppGroupInboxService: dependencies.readAppGroupInboxService ??
            (() => getMiddleware().appGroupInboxService),
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

async function assertCanReadScopedGlobalGraph(
  req: { header(name: string): string | undefined },
  deps: GraphTopologyRouteDependencies,
): Promise<void> {
  if (!isStrictReadAuthEnabled()) {
    return;
  }
  await deps.requireApiAuthSession(req);
}

async function assertCanManageGroupRef(
  req: { header(name: string): string | undefined },
  deps: GraphTopologyRouteDependencies,
  groupRef: GroupRef,
): Promise<
  Readonly<{
    authSession: GraphTopologyRouteAuthSession;
    groupRef: GroupRef;
    snapshot: GroupSnapshot;
  }>
> {
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

function requireRequestId(
  c: { req: { header(name: string): string | undefined } },
  body: { requestId?: unknown },
): string {
  const requestId = c.req.header('Idempotency-Key')?.trim();
  if (!requestId) {
    const error = new Error('Topology mutation requestId is required') as Error & {
      status: number;
    };
    error.status = 400;
    throw error;
  }
  if (body.requestId !== undefined && body.requestId !== requestId) {
    const error = new Error(
      'Topology mutation body requestId must match Idempotency-Key',
    ) as Error & { status: number };
    error.status = 400;
    throw error;
  }
  return requestId;
}

async function writeTopologyAppInboxCommand(
  deps: GraphTopologyRouteDependencies,
  authSession: GraphTopologyRouteAuthSession,
  groupRef: GroupRef,
  input: Readonly<{
    requestId: string;
    payload: TopologyAppInboxRequestPayload;
  }>,
): Promise<unknown> {
  const command = await toTopologyAppInboxCommand({
    actor: {
      principalId: authSession.clientId,
      sessionId: authSession.sessionId,
    },
    groupRef,
    requestId: input.requestId,
    capturedAtEpochMs: deps.now(),
    payload: input.payload,
  });
  return await deps.processTopologyAppInbox(authSession, {
    type: toTopologyAppInboxType(command.operation),
    resourceId: command.requestId,
    contextId: toTopologyAppInboxContextId(groupRef),
    senderId: command.actor.principalId,
    data: command,
  });
}

function toTopologyAppInboxType(
  operation: TopologyAppInboxCommand['operation'],
): AppInboxType {
  switch (operation) {
    case 'putConfig':
      return AppInboxType.TOPOLOGY_CONFIG_PUT;
    case 'deleteConfig':
      return AppInboxType.TOPOLOGY_CONFIG_DELETE;
    case 'putOverride':
      return AppInboxType.TOPOLOGY_OVERRIDE_PUT;
    case 'deleteOverride':
      return AppInboxType.TOPOLOGY_OVERRIDE_DELETE;
    case 'reconfigureTopology':
      return AppInboxType.TOPOLOGY_RECONFIGURE;
  }
}

function toTopologyAppInboxContextId(groupRef: GroupRef): string {
  return [groupRef.applicationId, groupRef.workspaceId, groupRef.groupId]
    .map(encodeURIComponent)
    .join(':');
}

async function defaultProcessTopologyAppInbox(
    service: GraphTopologyAppInboxService,
  authority: GraphTopologyRouteAuthSession,
  enqueue: AppInboxEnqueueInput<TopologyAppInboxCommand>,
): Promise<unknown> {
    const result = await service.processAuthenticatedEntryUntilCompletionResult(
      enqueue,
      authority as IssuedAuthSession,
    );
  return result.fold(
    (error) => {
            throw new TopologyAppInboxFailureError(error);
    },
    (value) => value,
  );
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
