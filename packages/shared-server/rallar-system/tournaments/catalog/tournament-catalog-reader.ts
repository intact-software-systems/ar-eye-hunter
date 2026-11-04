import { requireOneOf } from '@shared/api/exact-object-decoding.ts';
import { assertValidRallarRouteId } from '@shared/api/rallar-validation.ts';
import { decodeStateScope, type StateScope } from '@shared/api/state-types.ts';
import type {
    TournamentCatalogEntry,
    TournamentCatalogPage,
    TournamentCatalogView
} from '@shared/api/tournaments/tournament-catalog.ts';
import type { Tournament } from '@shared/api/tournaments/tournament-types.ts';
import type { RuntimeStateEntry, RuntimeStateRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import { groupStateScopeStorageKey } from '../../group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import {
    decodeTournamentPublicationEntry,
    TOURNAMENT_PUBLICATIONS_NAMESPACE,
    type TournamentPublication
} from '../tournament-publication.ts';
import { decodeTournamentEntry, TOURNAMENTS_NAMESPACE } from '../tournament-repository.ts';
import { decodeTournamentStorageKey } from '../tournament-storage-key.ts';
import { decodeTournamentCatalogCursor, toTournamentCatalogCursor } from './tournament-catalog-cursor.ts';

export namespace TournamentCatalogReader {
    export interface Request {
        readonly scope: StateScope;
        readonly principalId: string;
        readonly view: TournamentCatalogView;
        readonly limit: number;
        readonly cursor: string | null;
    }
}

/** Reads one bounded storage page; never fills sparse personal history through an unbounded scan. */
export class TournamentCatalogReader {
    private readonly runtime: Pick<RuntimeStateRepositoryLike, 'findEntriesByPrefixPage' | 'readRuntimeStateBatch'>;
    private readonly nowEpochMs: () => number;

    constructor(
        runtime: Pick<RuntimeStateRepositoryLike, 'findEntriesByPrefixPage' | 'readRuntimeStateBatch'>,
        nowEpochMs: () => number
    ) {
        this.runtime = runtime;
        this.nowEpochMs = nowEpochMs;
    }

    async read(request: TournamentCatalogReader.Request): Promise<TournamentCatalogPage> {
        decodeStateScope(request.scope);
        assertValidRallarRouteId(request.principalId);
        requireOneOf(request.view, ['public', 'mine'], 'Tournament catalogue view');
        if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 50) {
            throw new TypeError('Tournament catalogue limit must be between 1 and 50');
        }
        const afterKey = decodeTournamentCatalogCursor(request);
        const rows = await this.runtime.findEntriesByPrefixPage(
            TOURNAMENTS_NAMESPACE,
            `${groupStateScopeStorageKey(request.scope)}:tournament=`,
            { afterKey, limit: 200 }
        );
        const records = rows.map((entry) =>
            decodeTournamentEntry(entry, decodeTournamentStorageKey(entry.key, request.scope))
        );
        const publications = await this.readPublications(rows, request.scope);
        const entries: TournamentCatalogEntry[] = [];
        let scanned = 0;
        for (const [index, record] of records.entries()) {
            const publication = publications.get(rows[index].key);
            scanned++;
            if (isVisibleTournament(record.tournament, publication?.listing === 'listed', request)) {
                entries.push(toTournamentCatalogEntry(record.tournament));
            }
            if (entries.length === request.limit) {
                break;
            }
        }
        const nextCursor = scanned > 0 && (scanned < rows.length || rows.length === 200)
            ? toTournamentCatalogCursor(request, rows[scanned - 1].key)
            : null;
        return {
            scope: request.scope,
            principalId: request.principalId,
            view: request.view,
            observedAtEpochMs: this.nowEpochMs(),
            entries,
            nextCursor
        };
    }
    private async readPublications(
        rows: readonly RuntimeStateEntry[],
        scope: StateScope
    ): Promise<ReadonlyMap<string, TournamentPublication | null>> {
        if (rows.length === 0) {
            return new Map();
        }
        const selections = await this.runtime.readRuntimeStateBatch(rows.map((row) => ({
            selectorId: row.key,
            namespace: TOURNAMENT_PUBLICATIONS_NAMESPACE,
            kind: 'key',
            key: row.key
        })));
        const publications = new Map<string, TournamentPublication | null>();
        for (const row of rows) {
            const selection = selections.find((selection) => selection.selectorId === row.key);
            if (!selection || selection.entries.length > 1) {
                throw new TypeError('Tournament publication selection is invalid');
            }
            const entry = selection.entries[0];
            publications.set(
                row.key,
                entry === undefined
                    ? null
                    : decodeTournamentPublicationEntry(entry, decodeTournamentStorageKey(row.key, scope))
            );
        }
        return publications;
    }
}

function isVisibleTournament(
    tournament: Tournament,
    listed: boolean,
    request: TournamentCatalogReader.Request
): boolean {
    return request.view === 'mine'
        ? tournament.organizerPrincipalId === request.principalId ||
            tournament.entrants.some((entry) => entry.principalId === request.principalId)
        : listed && (tournament.status === 'registration' || tournament.status === 'active');
}

function toTournamentCatalogEntry(tournament: Tournament): TournamentCatalogEntry {
    const scheduled = tournament.matches.filter((match) => match.status === 'scheduled').map((match) =>
        match.attempt!.scheduledAtEpochMs
    );
    return {
        ref: tournament.ref,
        title: tournament.title,
        organizerPrincipalId: tournament.organizerPrincipalId,
        status: tournament.status,
        activeEntrantCount: tournament.entrants.filter((entry) => entry.withdrawnAtEpochMs === null).length,
        nextScheduledAtEpochMs: scheduled.length === 0 ? null : Math.min(...scheduled)
    };
}
