import {
    toApiMutationFailureResponse,
    toApiMutationRateLimitResponse,
    toApiMutationRouteFailure
} from '@api-v1/src/routes/api-mutation-route-failure.ts';
import { readApiRequestTraceId } from '@api-v1/src/services/read-api-request-trace-id.ts';
import {
    AR_EYE_TOURNAMENT_DATA_BINDING,
    type ArenaTournamentMutation
} from '@ar-eye-hunter/server/arena-tournament-mutation.ts';
import { decodeTournamentArenaInput } from '@ar-eye-hunter/tournament-arena.ts';
import { readRateLimiter } from '@shared-server/http/rate-limit-service.ts';
import type { RallarServerAppInbox } from '@shared-server/rallar-server/rallar-server-app-inbox.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { assertApiMutationRequestId } from '@shared/api/mutation/api-mutation-request.ts';
import { assertValidRallarRouteId } from '@shared/api/rallar-validation.ts';
import { RateLimiterPolicy } from '@shared/resilience/rate-limiter.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { Context, Hono } from 'jsr:@hono/hono@4.11.9';

export interface ArenaTournamentRouteDependencies {
    readonly mutations: Pick<ArenaTournamentMutation, 'readSnapshot'>;
    readonly operation: Pick<
        RallarServerAppInbox.Operation<ArenaTournamentMutation.Command, ArenaTournamentMutation.Result>,
        'submit'
    >;
    readonly nowEpochMs: () => number;
    readonly requireSession: (request: { header(name: string): string | undefined; }) => Promise<IssuedAuthSession>;
}

const INPUT_QUOTA = new RateLimiterPolicy(1000, 30);

export function registerArenaTournamentRoutes(app: Hono, dependencies: ArenaTournamentRouteDependencies): void {
    const path = '/api/ar-eye/rooms/:roomId/tournament';
    app.get(path, (context) => readSnapshot(context, dependencies));
    app.post(`${path}/inputs/requests/:requestId`, (context) => changeInput(context, dependencies));
}

async function readSnapshot(context: Context, dependencies: ArenaTournamentRouteDependencies): Promise<Response> {
    try {
        const session = await dependencies.requireSession(context.req);
        const snapshot = await dependencies.mutations.readSnapshot(roomRef(context), session.clientId);
        context.header('Cache-Control', 'private, no-store');
        return context.json(snapshot);
    }
    catch (error) {
        return toApiMutationFailureResponse(context, toError(error));
    }
}

async function changeInput(context: Context, dependencies: ArenaTournamentRouteDependencies): Promise<Response> {
    try {
        const session = await dependencies.requireSession(context.req);
        if (!readRateLimiter('arena-tournament-input', session.clientId, INPUT_QUOTA).allow()) {
            return toApiMutationRateLimitResponse(context, 'Too many arena inputs', INPUT_QUOTA.timebasedFilterMs);
        }
        const result = await dependencies.operation.submit({
            command: {
                kind: 'input',
                roomRef: roomRef(context),
                requestId: assertApiMutationRequestId(context.req.param('requestId')),
                actor: {
                    principalId: session.clientId,
                    sessionId: session.sessionId,
                    issuedAtEpochMs: session.issuedAtEpochMs
                },
                input: decodeTournamentArenaInput(await context.req.json()),
                capturedAtEpochMs: dependencies.nowEpochMs()
            },
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

function roomRef(context: Context) {
    return {
        applicationId: AR_EYE_TOURNAMENT_DATA_BINDING.applicationId,
        workspaceId: AR_EYE_TOURNAMENT_DATA_BINDING.workspaceId,
        groupId: assertValidRallarRouteId(context.req.param('roomId'))
    };
}
