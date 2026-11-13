import { decodeStateScope } from '@shared/api/state-types.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { Context } from 'hono';
import { toApiMutationFailureResponse } from '../routes/api-mutation-route-failure.ts';
import type { MatchmakingRouteDependencies } from './register-matchmaking-routes.ts';

export async function readMatchmaking(context: Context, dependencies: MatchmakingRouteDependencies): Promise<Response> {
    try {
        const session = await dependencies.requireSession(context.req);
        const scope = decodeStateScope({
            applicationId: context.req.param('applicationId'),
            workspaceId: context.req.param('workspaceId')
        });
        context.header('Cache-Control', 'private, no-store');
        return context.json(await dependencies.reader.read({ scope, principalId: session.clientId }));
    }
    catch (error) {
        return toApiMutationFailureResponse(context, toError(error));
    }
}
