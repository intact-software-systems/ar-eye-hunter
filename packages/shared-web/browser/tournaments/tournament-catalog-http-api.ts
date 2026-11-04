import { decodeTournamentCatalogPage } from '@shared/api/tournaments/tournament-catalog.ts';
import { readApiBaseUrl } from '../api-client-config.ts';
import { sendApiHttpRequest } from '../api/send-api-http-request.ts';
import type { RallarTournamentCatalog } from './rallar-tournament-catalog.ts';

export const tournamentCatalogHttpApi: RallarTournamentCatalog.Api = {
    async read({ scope, session, view, limit, cursor, signal, timeoutMs }) {
        const query = new URLSearchParams({ view, limit: String(limit) });
        if (cursor !== null) {
            query.set('cursor', cursor);
        }
        const path = `/api/tournaments/apps/${encodeURIComponent(scope.applicationId)}/workspaces/${
            encodeURIComponent(scope.workspaceId)
        }/catalog?${query}`;
        return decodeTournamentCatalogPage(
            await sendApiHttpRequest({
                baseUrl: readApiBaseUrl(),
                path,
                method: 'GET',
                body: undefined,
                options: { authSession: session, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) }
            })
        );
    }
};
