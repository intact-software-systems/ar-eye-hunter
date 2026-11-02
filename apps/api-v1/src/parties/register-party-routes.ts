import { readRateLimiter } from '@shared-server/http/rate-limit-service.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { PartyReader } from '@shared-server/rallar-system/parties/party-reader.ts';
import type { PartyService } from '@shared-server/rallar-system/parties/party-service.ts';
import { decodeStateScope } from '@shared/api/decode-state-scope.ts';
import { assertApiMutationRequestId } from '@shared/api/mutation/api-mutation-request.ts';
import { decodePartyRequest } from '@shared/api/parties/party-request.ts';
import type { RateLimiterPolicy } from '@shared/resilience/rate-limiter.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { Context } from 'jsr:@hono/hono@4.11.9';
import type { Hono } from 'jsr:@hono/hono@4.11.9';
import {
    toApiMutationFailureResponse,
    toApiMutationRateLimitResponse,
    toApiMutationRouteFailure
} from '../routes/api-mutation-route-failure.ts';
import { readApiRequestTraceId } from '../services/read-api-request-trace-id.ts';

export interface PartyRouteDependencies {
    readonly reader: Pick<PartyReader, 'read'>;
    readonly mutation: Pick<PartyService['mutate'], 'submit'>;
    readonly mutationQuota: RateLimiterPolicy;
    requireSession(request: { header(name: string): string | undefined; }): Promise<IssuedAuthSession>;
}

export function registerPartyRoutes(app: Hono, dependencies: PartyRouteDependencies): void {
    app.get('/api/parties/apps/:applicationId/workspaces/:workspaceId', (context) => readParty(context, dependencies));
    app.post(
        '/api/parties/apps/:applicationId/workspaces/:workspaceId/requests/:requestId',
        (context) => changeParty(context, dependencies)
    );
}

async function readParty(context: Context, dependencies: PartyRouteDependencies): Promise<Response> {
    context.header('Cache-Control', 'private, no-store');
    try {
        const session = await dependencies.requireSession(context.req);
        const scope = decodeStateScope({
            applicationId: context.req.param('applicationId'),
            workspaceId: context.req.param('workspaceId')
        });
        return context.json(await dependencies.reader.read(scope, session.clientId));
    }
    catch (error) {
        return toApiMutationFailureResponse(context, toError(error));
    }
}

async function changeParty(context: Context, dependencies: PartyRouteDependencies): Promise<Response> {
    context.header('Cache-Control', 'private, no-store');
    try {
        const session = await dependencies.requireSession(context.req);
        if (!readRateLimiter('parties-mutation', session.clientId, dependencies.mutationQuota).allow()) {
            return toApiMutationRateLimitResponse(
                context,
                'Too many party requests',
                dependencies.mutationQuota.timebasedFilterMs
            );
        }
        const scope = decodeStateScope({
            applicationId: context.req.param('applicationId'),
            workspaceId: context.req.param('workspaceId')
        });
        const request = decodePartyRequest(await context.req.json());
        if (request.ref.applicationId !== scope.applicationId || request.ref.workspaceId !== scope.workspaceId) {
            throw new TypeError('Party request differs from its HTTP scope');
        }
        const result = await dependencies.mutation.submit({
            command: {
                principalId: session.clientId,
                sessionId: session.sessionId,
                sessionIssuedAtEpochMs: session.issuedAtEpochMs,
                sessionExpiresAtEpochMs: session.expiresAtEpochMs,
                requestId: assertApiMutationRequestId(context.req.param('requestId')),
                request,
                capturedAtEpochMs: null,
                policy: null
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
