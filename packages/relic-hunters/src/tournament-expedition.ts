import { createRelicGame } from './create-relic-game.ts';
import { admitRelicHunter, startRelicExpedition } from './expedition-preparation.ts';
import type { RelicGameState } from './model.ts';
import { continueRelicRoundReview, resolveExpiredRelicRound } from './rules.ts';

export const RELIC_TOURNAMENT_REVIEW_MS = 10000;

export interface RelicTournamentClock {
    readonly phase: 'start' | 'planning' | 'review';
    readonly round: number;
    readonly dueAtEpochMs: number;
}

/** A committed bracket start authorizes native admission of exactly its two checked-in accounts. */
export function startRelicTournament(
    gameId: string,
    principalIds: readonly [string, string],
    now: number
): RelicGameState {
    let state = createRelicGame(gameId, gameId, now);
    for (const principalId of principalIds) {
        state = admitRelicHunter({ state, playerId: principalId, username: principalId, characterId: undefined, now })
            .state;
    }
    return startRelicExpedition(state, state.players[0], now);
}

/** The persisted phase/round deadline cannot advance a newer phase or skip a review. */
export function advanceRelicTournamentClock(
    state: RelicGameState,
    clock: RelicTournamentClock,
    now: number
): RelicGameState {
    if (state.phase !== clock.phase || state.round !== clock.round || now < clock.dueAtEpochMs) {
        return state;
    }
    if (clock.phase === 'planning') {
        return resolveExpiredRelicRound(state, now);
    }
    return clock.phase === 'review' ? continueRelicRoundReview(state, now) : state;
}
