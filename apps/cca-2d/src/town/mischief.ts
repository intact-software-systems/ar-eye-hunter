import type { TownState } from './state.ts';

export const TOWN_TROUBLE_TARGET = 6;
export const TOWN_CRACKDOWN_BONUS = 50;

export function rewardTownMischief(town: TownState, points = 10): TownState {
    return {
        ...town,
        score: town.score + points,
        mischief: town.mischief + 1,
        heat: town.raid.phase === 'quiet' ? Math.min(TOWN_TROUBLE_TARGET, town.heat + 1) : town.heat
    };
}
