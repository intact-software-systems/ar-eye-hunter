import type { RallarServerValidatedMatchResult } from '../../rallar-match/types.ts';
import type { GroupRef } from '../group-types.ts';
import type { StateScope } from '../state-types.ts';

export interface TournamentRef extends StateScope {
    readonly tournamentId: string;
}

/** Registration seeds belong to slots; each replay gets a new attempt and game instance. */
export interface TournamentMatchBinding {
    readonly tournamentRef: TournamentRef;
    readonly slot: 'semifinal-1' | 'semifinal-2' | 'final';
    readonly attemptId: string;
    readonly roomRef: GroupRef;
    readonly gameId: string;
    readonly rulesId: string;
    readonly principalIds: readonly [string, string];
}

export interface TournamentMatchResult extends RallarServerValidatedMatchResult<TournamentMatchBinding> {
    readonly startedAtEpochMs: number;
}

export interface TournamentEntrant {
    readonly principalId: string;
    readonly registeredAtEpochMs: number;
    readonly withdrawnAtEpochMs: number | null;
}

export interface TournamentAttempt {
    readonly binding: TournamentMatchBinding;
    readonly scheduledAtEpochMs: number;
    readonly startedAtEpochMs: number | null;
    readonly checkedInPrincipalIds: readonly string[];
}

export interface TournamentResolution {
    readonly reason: 'score' | 'withdrawal' | 'no-show';
    readonly winnerPrincipalId: string;
    readonly resolvedAtEpochMs: number;
    readonly resultId: string | null;
}

export interface TournamentMatch {
    readonly slot: TournamentMatchBinding['slot'];
    readonly principalIds: readonly [string, string] | null;
    readonly status: 'waiting' | 'ready' | 'scheduled' | 'playing' | 'tied' | 'unresolved' | 'complete' | 'cancelled';
    readonly attempt: TournamentAttempt | null;
    readonly resolution: TournamentResolution | null;
}

export interface Tournament {
    readonly ref: TournamentRef;
    readonly title: string;
    readonly organizerPrincipalId: string;
    readonly rulesId: string;
    readonly createdAtEpochMs: number;
    readonly noShowGraceMs: number;
    readonly status: 'registration' | 'active' | 'complete' | 'cancelled';
    readonly entrants: readonly TournamentEntrant[];
    readonly matches: readonly TournamentMatch[];
    readonly championPrincipalId: string | null;
}
