import { TOWN_POLICE_DOOR } from './map.ts';
import { TOWN_CRACKDOWN_BONUS, TOWN_TROUBLE_TARGET } from './mischief.ts';
import { createCleanCoat } from './soiling.ts';
import type {
    TownGuard,
    TownState,
    TownTickInput
} from './state.ts';

export const TOWN_POLICE_COUNT = 10;

export function advanceTownRaid(input: TownTickInput): TownState {
    const { town, now } = input;
    const raid = town.raid;
    if (raid.phase === 'quiet' && town.heat >= TOWN_TROUBLE_TARGET) {
        return {
            ...town,
            score: town.score + TOWN_CRACKDOWN_BONUS,
            raid: { ...raid, phase: 'alarm', until: now + 5, bonuses: raid.bonuses + 1, rewarded: false }
        };
    }
    if (raid.until > now) {
        return town;
    }
    if (raid.phase === 'alarm') {
        return { ...town, raid: { ...raid, phase: 'active', until: now + 25, guards: createTownPolice(now) } };
    }
    if (raid.phase === 'active') {
        return {
            ...town,
            heat: 0,
            raid: {
                ...raid,
                phase: 'returning',
                until: now + 16,
                guards: raid.guards.map((guard) => ({ ...guard, mode: 'patrol', until: 0 }))
            }
        };
    }
    if (raid.phase === 'returning') {
        return { ...town, raid: { ...raid, phase: 'cooldown', until: now + 12, guards: [] } };
    }
    if (raid.phase === 'cooldown') {
        return { ...town, heat: 0, raid: { ...raid, phase: 'quiet' } };
    }
    return town;
}

function createTownPolice(now: number): readonly TownGuard[] {
    return Array.from({ length: TOWN_POLICE_COUNT }, (_, id) => ({
        ...createCleanCoat(),
        id,
        x: TOWN_POLICE_DOOR.x + (id % 2 === 0 ? -0.2 : 0.2),
        z: TOWN_POLICE_DOOR.z,
        mode: 'emerging',
        target: 'player',
        aim: { ...TOWN_POLICE_DOOR },
        until: now + id * 0.25
    }));
}
