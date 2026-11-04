import { requireOneOf } from '@shared/api/exact-object-decoding.ts';
import { decodeStateScope } from '@shared/api/state-types.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { Context } from 'jsr:@hono/hono@4.11.9';
import { toApiMutationFailureResponse } from '../routes/api-mutation-route-failure.ts';
import type { TournamentRouteDependencies } from './register-tournament-routes.ts';

export async function readTournamentCatalog(
    context: Context,
    dependencies: TournamentRouteDependencies
): Promise<Response> {
    try {
        const session = await dependencies.requireSession(context.req);
        const scope = decodeStateScope({
            applicationId: context.req.param('applicationId'),
            workspaceId: context.req.param('workspaceId')
        });
        const view = requireOneOf(
            context.req.query('view') ?? 'public',
            ['public', 'mine'],
            'Tournament catalogue view'
        );
        const limit = Number(context.req.query('limit') ?? 20);
        const cursor = context.req.query('cursor') ?? null;
        if (
            !Number.isSafeInteger(limit) || limit < 1 || limit > 50 ||
            cursor !== null && (cursor.length === 0 || cursor.length > 4096)
        ) {
            throw new TypeError('Tournament catalogue limit or continuation is invalid');
        }
        context.header('Cache-Control', 'private, no-store');
        return context.json(
            await dependencies.catalog.read({ scope, principalId: session.clientId, view, limit, cursor })
        );
    }
    catch (error) {
        return toApiMutationFailureResponse(context, toError(error));
    }
}
