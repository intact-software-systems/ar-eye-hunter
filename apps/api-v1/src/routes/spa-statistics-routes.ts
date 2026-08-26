import { Hono, type Context } from 'jsr:@hono/hono@4.11.9';

import { RequestAuthFailure } from '@shared-server/http/request-auth-service.ts';
import { isGroupPolicyDeniedError } from '@shared-server/rallar-system/group-state/policy/group-policy-result.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type {
    GroupSpaStatisticsResponse,
    MyRealtimeSpaStatisticsResponse,
    WorkspaceSpaStatisticsResponse
} from '@shared/api/spa-statistics-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

export interface SpaStatisticsRouteReadWorkspaceInput {
    readonly scope: StateScope;
    readonly authSession: AuthSession;
}

export interface SpaStatisticsRouteReadGroupInput extends SpaStatisticsRouteReadWorkspaceInput {
    readonly groupId: string;
}

export interface SpaStatisticsRouteService {
    readWorkspaceSummary(
        input: SpaStatisticsRouteReadWorkspaceInput
    ): Promise<WorkspaceSpaStatisticsResponse>;
    readGroupStats(
        input: SpaStatisticsRouteReadGroupInput
    ): Promise<GroupSpaStatisticsResponse>;
    readMyRealtimeStatus(
        input: SpaStatisticsRouteReadWorkspaceInput
    ): Promise<MyRealtimeSpaStatisticsResponse>;
}

export interface SpaStatisticsRouteDependencies {
    readonly statistics: SpaStatisticsRouteService;
    readonly requireApiAuthSession: (
        request: {
            header(name: string): string | undefined;
        }
    ) => Promise<AuthSession>;
}

type SpaStatisticsResponse =
    | WorkspaceSpaStatisticsResponse
    | GroupSpaStatisticsResponse
    | MyRealtimeSpaStatisticsResponse;

export function registerSpaStatisticsRoutes(
    app: Hono,
    dependencies: SpaStatisticsRouteDependencies
): void {
    app.get(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/stats/summary',
        (context) =>
            respondToSpaStatisticsRequest(
                context,
                dependencies,
                (authSession) =>
                    dependencies.statistics.readWorkspaceSummary({
                        scope: toScope(context),
                        authSession
                    })
            )
    );

    app.get(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/stats',
        (context) =>
            respondToSpaStatisticsRequest(
                context,
                dependencies,
                (authSession) =>
                    dependencies.statistics.readGroupStats({
                        scope: toScope(context),
                        groupId: context.req.param('groupId'),
                        authSession
                    })
            )
    );

    app.get(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/stats/me/realtime',
        (context) =>
            respondToSpaStatisticsRequest(
                context,
                dependencies,
                (authSession) =>
                    dependencies.statistics.readMyRealtimeStatus({
                        scope: toScope(context),
                        authSession
                    })
            )
    );
}

async function respondToSpaStatisticsRequest(
    context: Context,
    dependencies: SpaStatisticsRouteDependencies,
    readStatistics: (authSession: AuthSession) => Promise<SpaStatisticsResponse>
): Promise<Response> {
    try {
        const authSession = await dependencies.requireApiAuthSession(context.req);
        const statisticsResponse = await readStatistics(authSession);
        context.header('Cache-Control', 'no-store');
        return context.json(statisticsResponse);
    }
    catch (error) {
        return toErrorResponse(context, error);
    }
}

function toScope(context: Context): StateScope {
    return {
        applicationId: context.req.param('applicationId'),
        workspaceId: context.req.param('workspaceId')
    };
}

function toErrorResponse(
    context: Context,
    error: unknown
): Response {
    if (isGroupPolicyDeniedError(error)) {
        return context.json({
            error: `Forbidden: ${error.denial.message}`,
            code: error.denial.code,
            message: error.denial.message,
            details: error.denial.details
        }, 403);
    }

    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof RequestAuthFailure
        ? error.status
        : message.includes('not found')
        ? 404
        : message.startsWith('Unauthorized:')
        ? 401
        : message.startsWith('Forbidden:')
        ? 403
        : 400;

    return context.json({ error: message }, status);
}
