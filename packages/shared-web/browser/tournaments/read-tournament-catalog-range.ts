import {
    decodeTournamentCatalogPage,
    type TournamentCatalogEntry
} from '@shared/api/tournaments/tournament-catalog.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { RallarTournamentCatalog } from './rallar-tournament-catalog.ts';

export interface TournamentCatalogRangeInput {
    readonly api: RallarTournamentCatalog.Api;
    readonly request: RallarTournamentCatalog.ReadInput;
    readonly pagesToRead: number;
    readonly entries: readonly TournamentCatalogEntry[];
}
export interface TournamentCatalogRange {
    readonly entries: readonly TournamentCatalogEntry[];
    readonly nextCursor: string | null;
    readonly pages: number;
}

/** Validates one loaded range before the lifecycle owner atomically publishes it. */
export async function readTournamentCatalogRange(
    input: TournamentCatalogRangeInput
): Promise<TournamentCatalogRange> {
    const { api, request } = input;
    const entries = new Map(input.entries.map((entry) => [entry.ref.tournamentId, entry]));
    const cursors = new Set<string>();
    let cursor = request.cursor;
    let pages = 0;
    do {
        request.signal.throwIfAborted();
        if (cursor !== null) {
            cursors.add(cursor);
        }
        const page = decodeTournamentCatalogPage(await api.read({ ...request, cursor }));
        request.signal.throwIfAborted();
        if (
            !jsonEquals(page.scope, request.scope) || page.principalId !== request.session.clientId ||
            page.view !== request.view
        ) {
            throw new TypeError('Tournament catalogue response belongs to another account, scope or view');
        }
        for (const entry of page.entries) {
            entries.set(entry.ref.tournamentId, entry);
        }
        cursor = page.nextCursor;
        if (cursor !== null && cursors.has(cursor)) {
            throw new TypeError('Tournament catalogue repeated its continuation');
        }
        pages++;
    }
    while (cursor !== null && pages < input.pagesToRead);
    return { entries: [...entries.values()], nextCursor: cursor, pages };
}
