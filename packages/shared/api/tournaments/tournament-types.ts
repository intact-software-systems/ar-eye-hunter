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
