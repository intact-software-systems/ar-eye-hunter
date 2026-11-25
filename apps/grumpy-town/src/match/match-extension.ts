import { TOWN_MATCH_RATE, type TownMatchState } from './town-match.ts';

export const TOWN_MATCH_EXTENSION_TICKS = 60 * TOWN_MATCH_RATE;
export const TOWN_MATCH_MAX_TICKS = 3600 * TOWN_MATCH_RATE;

/** The total stays constant while playing or paused and travels in every checkpoint. */
export function computeTownMatchExtension(state: TownMatchState, expectedDurationTicks: number): TownMatchState {
    if (state.phase !== 'playing' || state.tick + state.remainingTicks !== expectedDurationTicks ||
        expectedDurationTicks + TOWN_MATCH_EXTENSION_TICKS > TOWN_MATCH_MAX_TICKS) {
        return state;
    }
    return { ...state, remainingTicks: state.remainingTicks + TOWN_MATCH_EXTENSION_TICKS };
}
