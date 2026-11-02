import { readRateLimiter } from '@shared-server/http/rate-limit-service.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { MatchmakingCommand } from '@shared-server/rallar-system/matchmaking/matchmaking-command.ts';
import { decodeMatchmakingRequest, decodeMatchmakingScope } from '@shared/api/matchmaking/matchmaking-request.ts';
import { assertApiMutationRequestId } from '@shared/api/mutation/api-mutation-request.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { Context } from 'jsr:@hono/hono@4.11.9';
import {
    toApiMutationFailureResponse,
    toApiMutationRateLimitResponse,
    toApiMutationRouteFailure
} from '../routes/api-mutation-route-failure.ts';
import { readApiRequestTraceId } from '../services/read-api-request-trace-id.ts';
import type { MatchmakingRouteDependencies } from './register-matchmaking-routes.ts';

export async function changeMatchmaking(
    context: Context,
    dependencies: MatchmakingRouteDependencies
): Promise<Response> {
    try {
        const session = await dependencies.requireSession(context.req);
        if (!readRateLimiter('matchmaking-mutation', session.clientId, dependencies.mutationQuota).allow()) {
            return toApiMutationRateLimitResponse(
                context,
                'Too many matchmaking requests',
                dependencies.mutationQuota.timebasedFilterMs
            );
        }
        const result = await dependencies.mutation.submit({
            command: await readMatchmakingCommand(context, session),
            traceId: readApiRequestTraceId(context)
        });
        return result.left === undefined
            ? context.json(result.right!)
            : toApiMutationFailureResponse(context, toApiMutationRouteFailure(result.left));
    }
    catch (error) {
        return toApiMutationFailureResponse(context, toError(error));
    }
}

async function readMatchmakingCommand(context: Context, session: IssuedAuthSession): Promise<MatchmakingCommand> {
    return {
        scope: decodeMatchmakingScope({
            applicationId: context.req.param('applicationId'),
            workspaceId: context.req.param('workspaceId')
        }),
        principalId: session.clientId,
        sessionId: session.sessionId,
        sessionIssuedAtEpochMs: session.issuedAtEpochMs,
        sessionExpiresAtEpochMs: session.expiresAtEpochMs,
        requestId: assertApiMutationRequestId(context.req.param('requestId')),
        request: decodeMatchmakingRequest(await context.req.json()),
        capturedAtEpochMs: null,
        policy: null,
        serviceId: null
    };
}
