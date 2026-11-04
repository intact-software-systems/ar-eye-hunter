import { jsonEquals } from '../../repository/state-utils.ts';
import {
    requireEpoch,
    requireExactKeys,
    requireOneOf,
    requireRecord,
    requireString
} from '../exact-object-decoding.ts';
import { assertValidRallarRouteId } from '../rallar-validation.ts';
import { decodeStateScope, type StateScope } from '../state-types.ts';
import { decodeTournamentRef } from './decode-tournament-match-binding.ts';
import { decodeTournamentTitle } from './decode-tournament.ts';
import type { Tournament, TournamentRef } from './tournament-types.ts';

export type TournamentCatalogView = 'public' | 'mine';

export interface TournamentCatalogEntry {
    readonly ref: TournamentRef;
    readonly title: string;
    readonly organizerPrincipalId: string;
    readonly status: Tournament['status'];
    readonly activeEntrantCount: number;
    readonly nextScheduledAtEpochMs: number | null;
}

export interface TournamentCatalogPage {
    readonly scope: StateScope;
    readonly principalId: string;
    readonly view: TournamentCatalogView;
    readonly observedAtEpochMs: number;
    readonly entries: readonly TournamentCatalogEntry[];
    readonly nextCursor: string | null;
}

export function decodeTournamentCatalogPage(value: unknown): TournamentCatalogPage {
    const page = requireRecord(value, 'Tournament catalogue');
    requireExactKeys(
        page,
        ['scope', 'principalId', 'view', 'observedAtEpochMs', 'entries', 'nextCursor'],
        'Tournament catalogue'
    );
    const scope = decodeStateScope(page.scope);
    const view = requireOneOf(page.view, ['public', 'mine'], 'Tournament catalogue view');
    requireEpoch(page.observedAtEpochMs, 'Tournament catalogue observation');
    if (!Array.isArray(page.entries) || page.entries.length > 50) {
        throw new TypeError('Tournament catalogue entries are invalid');
    }
    const entries = page.entries.map(decodeTournamentCatalogEntry);
    const ids = entries.map((entry) => entry.ref.tournamentId);
    if (
        new Set(ids).size !== ids.length ||
        entries.some((entry) =>
            !jsonEquals(scope, { applicationId: entry.ref.applicationId, workspaceId: entry.ref.workspaceId })
        )
    ) {
        throw new TypeError('Tournament catalogue entries repeat or differ from the scope');
    }
    if (page.nextCursor !== null) {
        requireString(page.nextCursor, 'Tournament catalogue continuation');
    }
    return {
        scope,
        principalId: assertValidRallarRouteId(page.principalId),
        view,
        observedAtEpochMs: page.observedAtEpochMs,
        entries,
        nextCursor: page.nextCursor
    };
}

function decodeTournamentCatalogEntry(value: unknown): TournamentCatalogEntry {
    const entry = requireRecord(value, 'Tournament catalogue entry');
    requireExactKeys(entry, [
        'ref',
        'title',
        'organizerPrincipalId',
        'status',
        'activeEntrantCount',
        'nextScheduledAtEpochMs'
    ], 'Tournament catalogue entry');
    requireEpoch(entry.activeEntrantCount, 'Tournament active entrant count');
    if (entry.activeEntrantCount > 4) {
        throw new TypeError('Tournament active entrant count exceeds capacity');
    }
    if (entry.nextScheduledAtEpochMs !== null) {
        requireEpoch(entry.nextScheduledAtEpochMs, 'Tournament next schedule');
    }
    return {
        ref: decodeTournamentRef(entry.ref),
        title: decodeTournamentTitle(entry.title),
        organizerPrincipalId: assertValidRallarRouteId(entry.organizerPrincipalId),
        status: requireOneOf(
            entry.status,
            ['registration', 'active', 'complete', 'cancelled'],
            'Tournament catalogue status'
        ),
        activeEntrantCount: entry.activeEntrantCount,
        nextScheduledAtEpochMs: entry.nextScheduledAtEpochMs
    };
}
