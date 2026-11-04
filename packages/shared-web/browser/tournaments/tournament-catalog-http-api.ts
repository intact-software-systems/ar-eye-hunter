import { decodeTournamentCatalogPage } from '@shared/api/tournaments/tournament-catalog.ts';
import { readApiBaseUrl } from '../api-client-config.ts';
import { readApiView } from '../api/read-api-view.ts';
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
            await readApiView({
                baseUrl: readApiBaseUrl(),
                path,
                session,
                signal,
                timeoutMs
            })
        );
    }
};
