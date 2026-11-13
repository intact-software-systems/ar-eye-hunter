import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { ViewWatchCommand } from '@shared-server/rallar-system/view-watch/view-watch-command.ts';
import type { ViewWatchService } from '@shared-server/rallar-system/view-watch/view-watch-service.ts';
import { assertApiMutationRequestId } from '@shared/api/mutation/api-mutation-request.ts';
import { assertValidRallarRouteId } from '@shared/api/rallar-validation.ts';
import { decodeViewWatchFamily, decodeViewWatchRequest } from '@shared/api/views/view-watch.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { Context, Hono } from 'hono';
import { toApiMutationFailureResponse, toApiMutationRouteFailure } from '../routes/api-mutation-route-failure.ts';
import { readApiRequestTraceId } from '../services/read-api-request-trace-id.ts';

export interface ViewWatchRouteDependencies {
    readonly mutation: Pick<ViewWatchService['mutate'], 'submit'>;
    requireSession(request: { header(name: string): string | undefined; }): Promise<IssuedAuthSession>;
}

/** Uses the existing /api/state request quota; registration grants interest, never membership or My sessions intent. */
export function registerViewWatchRoutes(app: Hono, dependencies: ViewWatchRouteDependencies): void {
    app.post(
        '/api/state/apps/:applicationId/workspaces/:workspaceId/view-watches/:family/requests/:requestId',
        (context) => changeViewWatch(context, dependencies)
    );
}

async function changeViewWatch(
    context: Context,
    dependencies: ViewWatchRouteDependencies
): Promise<Response> {
    try {
        const session = await dependencies.requireSession(context.req);
        const result = await dependencies.mutation.submit({
            traceId: readApiRequestTraceId(context),
            command: await readViewWatchCommand(context, session)
        });
        context.header('Cache-Control', 'private, no-store');
        return result.left === undefined
            ? context.json(result.right!)
            : toApiMutationFailureResponse(context, toApiMutationRouteFailure(result.left));
    }
    catch (error) {
        return toApiMutationFailureResponse(context, toError(error));
    }
}

async function readViewWatchCommand(context: Context, session: IssuedAuthSession): Promise<ViewWatchCommand> {
    return {
        scope: {
            applicationId: assertValidRallarRouteId(context.req.param('applicationId')),
            workspaceId: assertValidRallarRouteId(context.req.param('workspaceId'))
        },
        family: decodeViewWatchFamily(context.req.param('family')),
        principalId: session.clientId,
        sessionId: session.sessionId,
        sessionIssuedAtEpochMs: session.issuedAtEpochMs,
        sessionExpiresAtEpochMs: session.expiresAtEpochMs,
        requestId: assertApiMutationRequestId(context.req.param('requestId')),
        request: decodeViewWatchRequest(await context.req.json())
    };
}
