import { type Context, Hono } from 'jsr:@hono/hono@4.11.9';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import {
  type ApiAdminAuthDependencies,
  requireApiAdminSession as defaultRequireApiAdminSession,
} from '../services/admin-auth-service.ts';

export type AdminOperationReadInput = Readonly<{
  adminSession: AuthSession;
  scope?: StateScope;
}>;

export type AdminOperationWriteInput<TRequest> = Readonly<{
  adminSession: AuthSession;
  request: TRequest;
}>;

export type AdminOperationsServiceLike = Readonly<{
  readOverview(input: AdminOperationReadInput): Promise<unknown>;
  readQueues(input: AdminOperationReadInput): Promise<unknown>;
  readRealtime(input: AdminOperationReadInput): Promise<unknown>;
  readState(input: AdminOperationReadInput): Promise<unknown>;
  readCrdt(input: AdminOperationReadInput): Promise<unknown>;
  readSystem(input: AdminOperationReadInput): Promise<unknown>;
  resetMetrics(input: AdminOperationWriteInput<unknown>): Promise<unknown>;
  recomputeTopology(input: AdminOperationWriteInput<unknown>): Promise<unknown>;
  pruneExpired(input: AdminOperationWriteInput<unknown>): Promise<unknown>;
  verifyCrdtIntegrity(input: AdminOperationWriteInput<unknown>): Promise<unknown>;
  exportCrdtDebug(input: AdminOperationWriteInput<unknown>): Promise<unknown>;
  compactCrdt(input: AdminOperationWriteInput<unknown>): Promise<unknown>;
  updateCrdtLifecycle(input: AdminOperationWriteInput<unknown>): Promise<unknown>;
  eraseCrdt(input: AdminOperationWriteInput<unknown>): Promise<unknown>;
}>;

export type AdminOperationsRouteDependencies = Readonly<
  ApiAdminAuthDependencies & {
    operations: AdminOperationsServiceLike;
    requireApiAdminSession?: (
      req: { header(name: string): string | undefined },
      dependencies: ApiAdminAuthDependencies,
    ) => Promise<AuthSession>;
    now: () => number;
  }
>;

export function init(
  app: Hono,
  dependencies: AdminOperationsRouteDependencies,
): void {
  const deps = dependencies;

  app.get(
    '/api/admin/operations/overview',
    (c) => withAdmin(c, deps, (adminSession) => deps.operations.readOverview({ adminSession })),
  );

  app.get(
    '/api/admin/operations/queues',
    (c) => withAdmin(c, deps, (adminSession) => deps.operations.readQueues({ adminSession })),
  );

  app.get(
    '/api/admin/operations/realtime',
    (c) => withAdmin(c, deps, (adminSession) => deps.operations.readRealtime({ adminSession })),
  );

  app.get(
    '/api/admin/operations/state',
    (c) => withAdmin(c, deps, (adminSession) => deps.operations.readState({ adminSession })),
  );

  app.get(
    '/api/admin/operations/state/apps/:applicationId/workspaces/:workspaceId',
    (c) =>
      withAdmin(c, deps, (adminSession) =>
        deps.operations.readState({
          adminSession,
          scope: toScope(c),
        })),
  );

  app.get(
    '/api/admin/operations/crdt',
    (c) => withAdmin(c, deps, (adminSession) => deps.operations.readCrdt({ adminSession })),
  );

  app.get(
    '/api/admin/operations/crdt/apps/:applicationId/workspaces/:workspaceId',
    (c) =>
      withAdmin(c, deps, (adminSession) =>
        deps.operations.readCrdt({
          adminSession,
          scope: toScope(c),
        })),
  );

  app.get(
    '/api/admin/operations/system',
    (c) => withAdmin(c, deps, (adminSession) => deps.operations.readSystem({ adminSession })),
  );

  app.post(
    '/api/admin/operations/metrics/reset',
    (c) =>
      withAdminJson(
        c,
        deps,
        (adminSession, request) => deps.operations.resetMetrics({ adminSession, request }),
      ),
  );

  app.post(
    '/api/admin/operations/topology/recompute',
    (c) =>
      withAdminJson(
        c,
        deps,
        (adminSession, request) => deps.operations.recomputeTopology({ adminSession, request }),
      ),
  );

  app.post(
    '/api/admin/operations/maintenance/prune-expired',
    (c) =>
      withAdminJson(
        c,
        deps,
        (adminSession, request) => deps.operations.pruneExpired({ adminSession, request }),
      ),
  );

  app.post(
    '/api/admin/operations/crdt/integrity',
    (c) =>
      withAdminJson(
        c,
        deps,
        (adminSession, request) => deps.operations.verifyCrdtIntegrity({ adminSession, request }),
      ),
  );

  app.post(
    '/api/admin/operations/crdt/debug-export',
    (c) =>
      withAdminJson(
        c,
        deps,
        (adminSession, request) => deps.operations.exportCrdtDebug({ adminSession, request }),
      ),
  );

  app.post(
    '/api/admin/operations/crdt/compact',
    (c) =>
      withAdminJson(
        c,
        deps,
        (adminSession, request) => deps.operations.compactCrdt({ adminSession, request }),
      ),
  );

  app.post(
    '/api/admin/operations/crdt/lifecycle',
    (c) =>
      withAdminJson(
        c,
        deps,
        (adminSession, request) => deps.operations.updateCrdtLifecycle({ adminSession, request }),
      ),
  );

  app.post(
    '/api/admin/operations/crdt/erase',
    (c) =>
      withAdminJson(
        c,
        deps,
        (adminSession, request) => deps.operations.eraseCrdt({ adminSession, request }),
      ),
  );
}

async function withAdmin(
  c: Context,
  deps: AdminOperationsRouteDependencies,
  execute: (session: AuthSession) => Promise<unknown>,
): Promise<Response> {
  try {
    const adminSession = await requireAdminSession(c, deps);
    return c.json(await execute(adminSession));
  } catch (error) {
    return toErrorResponse(c, error);
  }
}

async function withAdminJson(
  c: Context,
  deps: AdminOperationsRouteDependencies,
  execute: (session: AuthSession, request: unknown) => Promise<unknown>,
): Promise<Response> {
  return await withAdmin(
    c,
    deps,
    async (adminSession) => await execute(adminSession, await readOptionalJsonBody(c)),
  );
}

async function requireAdminSession(
  c: Context,
  deps: AdminOperationsRouteDependencies,
): Promise<AuthSession> {
  return await (deps.requireApiAdminSession ?? defaultRequireApiAdminSession)(
    c.req,
    {
      adminClientIds: deps.adminClientIds,
      requireApiAuthSession: deps.requireApiAuthSession,
    },
  );
}

async function readOptionalJsonBody(c: Context): Promise<unknown> {
  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return {};
  }

  try {
    return await c.req.json();
  } catch {
    const error = new Error('Malformed JSON request body') as Error & { status: number };
    error.status = 400;
    throw error;
  }
}

function toScope(c: Context): StateScope {
  return {
    applicationId: c.req.param('applicationId'),
    workspaceId: c.req.param('workspaceId'),
  };
}

function toErrorResponse(
  c: { json(value: unknown, status?: number): Response },
  error: unknown,
): Response {
  const message = error instanceof Error ? error.message : String(error);
  const status = isStatusError(error)
    ? error.status
    : message.includes('not found')
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

function isStatusError(error: unknown): error is Error & { status: number } {
  return error instanceof Error &&
    typeof (error as { status?: unknown }).status === 'number';
}
