import { jsonEquals } from '../../repository/state-utils.ts';
import { requireEpoch, requireExactKeys, requireOneOf, requireRecord } from '../exact-object-decoding.ts';
import { assertValidRallarRouteId } from '../rallar-validation.ts';
import { decodeTournamentRef } from './decode-tournament-match-binding.ts';
import { decodeTournament } from './decode-tournament.ts';
import type { Tournament, TournamentRef } from './tournament-types.ts';

export interface TournamentSnapshot {
    readonly ref: TournamentRef;
    readonly principalId: string;
    readonly observedAtEpochMs: number;
    readonly tournament: Tournament | null;
    readonly listing: 'listed' | 'unlisted';
}

export function decodeTournamentSnapshot(value: unknown): TournamentSnapshot {
    const snapshot = requireRecord(value, 'Tournament snapshot');
    requireExactKeys(
        snapshot,
        ['ref', 'principalId', 'observedAtEpochMs', 'tournament', 'listing'],
        'Tournament snapshot'
    );
    const ref = decodeTournamentRef(snapshot.ref);
    requireEpoch(snapshot.observedAtEpochMs, 'Tournament observation');
    const tournament = snapshot.tournament === null ? null : decodeTournament(snapshot.tournament);
    if (tournament !== null && !jsonEquals(tournament.ref, ref)) {
        throw new TypeError('Tournament snapshot scope differs');
    }
    return {
        ref,
        principalId: assertValidRallarRouteId(snapshot.principalId),
        observedAtEpochMs: snapshot.observedAtEpochMs,
        tournament,
        listing: requireOneOf(snapshot.listing, ['listed', 'unlisted'], 'Tournament listing')
    };
}
