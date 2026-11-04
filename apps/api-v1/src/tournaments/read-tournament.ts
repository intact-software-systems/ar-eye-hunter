import { decodeTournamentRef } from '@shared/api/tournaments/decode-tournament-match-binding.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { Context } from 'jsr:@hono/hono@4.11.9';
import { toApiMutationFailureResponse } from '../routes/api-mutation-route-failure.ts';
import type { TournamentRouteDependencies } from './register-tournament-routes.ts';

export async function readTournament(context: Context, dependencies: TournamentRouteDependencies): Promise<Response> {
    try {
        const session = await dependencies.requireSession(context.req);
        const ref = decodeTournamentRef({
            applicationId: context.req.param('applicationId'),
            workspaceId: context.req.param('workspaceId'),
            tournamentId: context.req.param('tournamentId')
        });
        context.header('Cache-Control', 'private, no-store');
        return context.json(await dependencies.reader.read({ ref, principalId: session.clientId }));
    }
    catch (error) {
        return toApiMutationFailureResponse(context, toError(error));
    }
}
