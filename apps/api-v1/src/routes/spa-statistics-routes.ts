import { type Context, Hono } from 'jsr:@hono/hono@4.11.9';
import type { AuthSession } from '@shared/api/api-config.ts';
import type {
  GroupSpaStatisticsResponse,
  MyRealtimeSpaStatisticsResponse,
  WorkspaceSpaStatisticsResponse,
} from '@shared/api/spa-statistics-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { isGroupPolicyDeniedError } from '@shared-server/rallar-system/group-policy.ts';

export type SpaStatisticsRouteReadWorkspaceInput = Readonly<{
  scope: StateScope;
  authSession: AuthSession;
}>;

export type SpaStatisticsRouteReadGroupInput =
  & SpaStatisticsRouteReadWorkspaceInput
  & Readonly<{
    groupId: string;
  }>;

export type SpaStatisticsRouteService = Readonly<{
  readWorkspaceSummary(
    input: SpaStatisticsRouteReadWorkspaceInput,
  ): Promise<WorkspaceSpaStatisticsResponse>;
  readGroupStats(
    input: SpaStatisticsRouteReadGroupInput,
  ): Promise<GroupSpaStatisticsResponse>;
  readMyRealtimeStatus(
    input: SpaStatisticsRouteReadWorkspaceInput,
  ): Promise<MyRealtimeSpaStatisticsResponse>;
}>;

export type SpaStatisticsRouteDependencies = Readonly<{
  statistics: SpaStatisticsRouteService;
  requireApiAuthSession: (
    req: {
      header(name: string): string | undefined;
    },
  ) => Promise<AuthSession>;
}>;

export function registerSpaStatisticsRoutes(
  app: Hono,
  dependencies: SpaStatisticsRouteDependencies,
): void {
  app.get(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/stats/summary',
    (c) =>
      withStats(c, dependencies, (authSession) =>
        dependencies.statistics.readWorkspaceSummary({
          scope: toScope(c),
          authSession,
        })),
  );

  app.get(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/stats',
    (c) =>
      withStats(c, dependencies, (authSession) =>
        dependencies.statistics.readGroupStats({
          scope: toScope(c),
          groupId: c.req.param('groupId'),
          authSession,
        })),
  );

  app.get(
    '/api/state/apps/:applicationId/workspaces/:workspaceId/stats/me/realtime',
    (c) =>
      withStats(c, dependencies, (authSession) =>
        dependencies.statistics.readMyRealtimeStatus({
          scope: toScope(c),
          authSession,
        })),
  );
}

async function withStats(
  c: Context,
  deps: SpaStatisticsRouteDependencies,
  execute: (authSession: AuthSession) => Promise<unknown>,
): Promise<Response> {
  try {
    const authSession = await deps.requireApiAuthSession(c.req);
    const response = await execute(authSession);
    c.header('Cache-Control', 'no-store');
    return c.json(response);
  } catch (error) {
    return toErrorResponse(c, error);
  }
}

function toScope(c: {
  req: {
    param(key: 'applicationId' | 'workspaceId'): string;
  };
}): StateScope {
  return {
    applicationId: c.req.param('applicationId'),
    workspaceId: c.req.param('workspaceId'),
  };
}

function toErrorResponse(
  c: {
    json(value: unknown, status?: number): Response;
  },
  error: unknown,
): Response {
  if (isGroupPolicyDeniedError(error)) {
    return c.json({
      error: `Forbidden: ${error.denial.message}`,
      code: error.denial.code,
      message: error.denial.message,
      details: error.denial.details,
    }, 403);
  }

  const message = error instanceof Error ? error.message : String(error);
  const status = isStatusError(error)
    ? error.status
    : message.includes('not found')
    ? 404
    : message.startsWith('Unauthorized:')
    ? 401
    : message.startsWith('Forbidden:')
    ? 403
    : 400;

  return c.json({ error: message }, status);
}

function isStatusError(error: unknown): error is Error & { status: number } {
  return error instanceof Error &&
    typeof (error as { status?: unknown }).status === 'number';
}
