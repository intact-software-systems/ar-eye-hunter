import { TOWN_FIRE_BAY } from '../layout/map.ts';
import { createCleanCoat } from '../soiling.ts';
import type { TownState, TownTickInput } from '../state.ts';
import type { TownFirefighter, TownSpectacle } from './state.ts';

export function advanceTownFire(input: TownTickInput): TownState {
    const { now, step } = input;
    let town = input.town;
    let event = town.spectacles.active!;
    let crew = town.spectacles.firefighters;
    if (crew.length === 0 && event.phase === 'warning') {
        crew = [0, 1].map((id) => ({
            ...createCleanCoat(),
            ...TOWN_FIRE_BAY,
            id,
            phase: 'responding' as const,
            until: 0,
            aim: event.origin
        }));
        town = { ...town, spectacles: { ...town.spectacles, fires: town.spectacles.fires + 1 } };
    }
    if (event.phase === 'warning' && now >= event.until + 2) {
        event = { ...event, phase: 'active', until: now + 25 };
    }
    if (event.phase === 'active' && (event.progress >= 5 || now >= event.until)) {
        event = { ...event, phase: 'cleanup', until: now + 18 };
    }
    crew = crew.map((firefighter) => moveFirefighter({ ...input, town, event, firefighter }));
    if (event.phase === 'active' && crew.some((firefighter) => firefighter.phase === 'spraying')) {
        event = { ...event, progress: event.progress + step };
    }
    const returned = crew.every((firefighter) =>
        Math.hypot(firefighter.x - TOWN_FIRE_BAY.x, firefighter.z - TOWN_FIRE_BAY.z) < 0.5
    );
    const done = event.phase === 'cleanup' && (returned || now >= event.until);
    return {
        ...town,
        spectacles: { ...town.spectacles, active: done ? undefined : event, firefighters: done ? [] : crew }
    };
}

function moveFirefighter(
    input: TownTickInput & { event: TownSpectacle; firefighter: TownFirefighter; }
): TownFirefighter {
    const { event, firefighter, town, step } = input;
    if (event.phase === 'warning') {
        return firefighter;
    }
    const target = event.phase === 'cleanup'
        ? TOWN_FIRE_BAY
        : { x: event.origin.x + (firefighter.id ? 2.3 : -2.3), z: event.origin.z - 2 };
    const position = input.routes.travel({ town, from: firefighter, target, speed: 4.2, step });
    const near = Math.hypot(position.x - target.x, position.z - target.z) < 0.5;
    return {
        ...firefighter,
        ...position,
        phase: event.phase === 'cleanup'
            ? 'returning'
            : !near
            ? 'responding'
            : firefighter.phase === 'responding' || firefighter.until > input.now
            ? 'aiming'
            : 'spraying',
        until: near && firefighter.phase === 'responding' ? input.now + 1 : firefighter.until,
        aim: event.origin
    };
}
