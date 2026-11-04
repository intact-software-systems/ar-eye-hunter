import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import { decodeTournamentMutationResult } from '@shared/api/tournaments/tournament-mutation-result.ts';
import { decodeTournamentSnapshot } from '@shared/api/tournaments/tournament-snapshot.ts';
import type { TournamentRef } from '@shared/api/tournaments/tournament-types.ts';
import { Command } from '@shared/cache/Command.ts';
import { readApiBaseUrl } from '../api-client-config.ts';
import { readApiView } from '../api/read-api-view.ts';
import { sendApiHttpRequest } from '../api/send-api-http-request.ts';
import type { RallarTournament } from './rallar-tournament.ts';

export const tournamentHttpApi: RallarTournament.Api = {
    async read({ ref, session, signal }) {
        return decodeTournamentSnapshot(
            await readApiView({
                baseUrl: readApiBaseUrl(),
                path: tournamentPath(ref),
                session,
                signal,
                timeoutMs: 10000
            })
        );
    },
    async change({ ref, request, requestId, session, signal }) {
        return await new Command(async (attemptSignal) => {
            const response = await sendApiHttpRequest({
                baseUrl: readApiBaseUrl(),
                path: toApiMutationRequestPath(tournamentPath(ref), requestId),
                method: 'POST',
                body: request,
                options: { authSession: session, signal: attemptSignal }
            });
            return decodeTournamentMutationResult(response, { ref, requestId });
        }, { signal, timeoutMs: 15000, maxAttempts: 2, errorOnNull: true }).run();
    }
};

function tournamentPath(ref: TournamentRef): string {
    return `/api/tournaments/apps/${encodeURIComponent(ref.applicationId)}/workspaces/${
        encodeURIComponent(ref.workspaceId)
    }/tournaments/${encodeURIComponent(ref.tournamentId)}`;
}
