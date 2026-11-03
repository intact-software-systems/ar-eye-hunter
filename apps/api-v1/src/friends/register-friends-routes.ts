import { assertApiMutationRequestId } from '@shared/api/mutation/api-mutation-request.ts';
import type { Context, Hono } from 'jsr:@hono/hono@4.11.9';

import { readRateLimiter } from '@shared-server/http/rate-limit-service.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { FriendsReader } from '@shared-server/rallar-system/friends/friends-reader.ts';
import type { FriendsService } from '@shared-server/rallar-system/friends/friends-service.ts';
import { decodeFriendsRequest } from '@shared/api/friends/friends-request.ts';
import { assertValidRallarRouteId } from '@shared/api/rallar-validation.ts';
import type { RateLimiterPolicy } from '@shared/resilience/rate-limiter.ts';
import { toError } from '@shared/resilience/to-error.ts';

import {
    toApiMutationFailureResponse,
    toApiMutationRateLimitResponse,
    toApiMutationRouteFailure
} from '../routes/api-mutation-route-failure.ts';
import { readApiRequestTraceId } from '../services/read-api-request-trace-id.ts';

export interface FriendsRouteDependencies {
    readonly reader: Pick<FriendsReader, 'read'>;
    readonly mutation: Pick<FriendsService['mutate'], 'submit'>;
    readonly mutationQuota: RateLimiterPolicy;
    requireSession(request: { header(name: string): string | undefined; }): Promise<IssuedAuthSession>;
}

export function registerFriendsRoutes(app: Hono, dependencies: FriendsRouteDependencies): void {
    app.get(
        '/api/friends/apps/:applicationId/workspaces/:workspaceId',
        (context) => readFriends(context, dependencies)
    );
    app.post('/api/friends/requests/:requestId', (context) => changeFriends(context, dependencies));
}

async function readFriends(context: Context, dependencies: FriendsRouteDependencies): Promise<Response> {
    try {
        const session = await dependencies.requireSession(context.req);
        const scope = {
            applicationId: assertValidRallarRouteId(context.req.param('applicationId')),
            workspaceId: assertValidRallarRouteId(context.req.param('workspaceId'))
        };
        context.header('Cache-Control', 'private, no-store');
        return context.json(await dependencies.reader.read(session.clientId, scope));
    }
    catch (error) {
        return toApiMutationFailureResponse(context, toError(error));
    }
}

async function changeFriends(context: Context, dependencies: FriendsRouteDependencies): Promise<Response> {
    try {
        const session = await dependencies.requireSession(context.req);
        const limiter = readRateLimiter('friends-mutation', session.clientId, dependencies.mutationQuota);
        if (!limiter.allow()) {
            return toApiMutationRateLimitResponse(
                context,
                'Too many friends requests',
                dependencies.mutationQuota.timebasedFilterMs
            );
        }
        const result = await dependencies.mutation.submit({
            traceId: readApiRequestTraceId(context),
            command: {
                principalId: session.clientId,
                sessionId: session.sessionId,
                sessionIssuedAtEpochMs: session.issuedAtEpochMs,
                sessionExpiresAtEpochMs: session.expiresAtEpochMs,
                requestId: assertApiMutationRequestId(context.req.param('requestId')),
                request: decodeFriendsRequest(await context.req.json()),
                capturedAtEpochMs: null
            }
        });
        return result.left === undefined
            ? context.json(result.right!)
            : toApiMutationFailureResponse(context, toApiMutationRouteFailure(result.left));
    }
    catch (error) {
        return toApiMutationFailureResponse(context, toError(error));
    }
}
