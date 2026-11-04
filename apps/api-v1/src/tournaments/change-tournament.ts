import { readRateLimiter } from '@shared-server/http/rate-limit-service.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { TournamentService } from '@shared-server/rallar-system/tournaments/tournament-service.ts';
import { assertApiMutationRequestId } from '@shared/api/mutation/api-mutation-request.ts';
import { decodeTournamentRef } from '@shared/api/tournaments/decode-tournament-match-binding.ts';
import { decodeTournamentRequest } from '@shared/api/tournaments/tournament-request.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { Context } from 'jsr:@hono/hono@4.11.9';
import {
    toApiMutationFailureResponse,
    toApiMutationRateLimitResponse,
    toApiMutationRouteFailure
} from '../routes/api-mutation-route-failure.ts';
import { readApiRequestTraceId } from '../services/read-api-request-trace-id.ts';
import type { TournamentRouteDependencies } from './register-tournament-routes.ts';

export async function changeTournament(context: Context, dependencies: TournamentRouteDependencies): Promise<Response> {
    try {
        const session = await dependencies.requireSession(context.req);
        if (!readRateLimiter('tournament-mutation', session.clientId, dependencies.mutationQuota).allow()) {
            return toApiMutationRateLimitResponse(
                context,
                'Too many tournament requests',
                dependencies.mutationQuota.timebasedFilterMs
            );
        }
        const result = await dependencies.mutation.submit({
            command: await readCommand(context, session),
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

async function readCommand(context: Context, session: IssuedAuthSession): Promise<TournamentService.Command> {
    return {
        ref: decodeTournamentRef({
            applicationId: context.req.param('applicationId'),
            workspaceId: context.req.param('workspaceId'),
            tournamentId: context.req.param('tournamentId')
        }),
        requestId: assertApiMutationRequestId(context.req.param('requestId')),
        actor: {
            principalId: session.clientId,
            sessionId: session.sessionId,
            issuedAtEpochMs: session.issuedAtEpochMs
        },
        request: decodeTournamentRequest(await context.req.json()),
        materialized: null
    };
}
