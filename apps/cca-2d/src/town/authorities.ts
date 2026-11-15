import {
    moveTownCompanion,
    rescueTownFriend,
    type TownRescueResult
} from './companion.ts';
import { TOWN_POLICE_DOOR } from './map.ts';
import { hasTownSight } from './navigation.ts';
import { isTownSprayed } from './props.ts';
import { advanceTownRaid } from './raid.ts';
import type { TownRoutes } from './routes.ts';
import type {
    TownCompanion,
    TownGuard,
    TownState,
    TownTickInput
} from './state.ts';

export interface TownGuardTarget extends TownCompanion {
    readonly id: string;
}
export interface TownGuardInput {
    readonly routes: TownRoutes;
    readonly town: TownState;
    readonly guard: TownGuard;
    readonly targets: readonly TownGuardTarget[];
    readonly now: number;
    readonly step: number;
}
export interface TownGuardResult {
    readonly guard: TownGuard;
    readonly frozenTarget: string | undefined;
}

export function computeTownAuthorities(input: TownTickInput): TownRescueResult {
    const { now, step } = input;
    let town = advanceTownRaid(input);
    let frozenUntil = input.player.frozenUntil;
    let shieldUntil = input.player.shieldUntil;
    if (frozenUntil > 0 && frozenUntil <= now) {
        frozenUntil = 0;
        shieldUntil = now + 2.5;
    }
    const player = { ...input.player, frozenUntil, shieldUntil };
    let companion = moveTownCompanion({ ...input, town, player });
    const guards: TownGuard[] = [];
    for (const guard of town.raid.guards) {
        const result = computeTownGuard({
            routes: input.routes,
            town: { ...town, companion },
            guard,
            targets: [{ ...player, frozenUntil, id: 'player' }, { ...companion, id: 'companion' }],
            now,
            step
        });
        if (result.frozenTarget === 'player') {
            frozenUntil = now + 6;
        }
        if (result.frozenTarget === 'companion') {
            companion = { ...companion, frozenUntil: now + 6 };
        }
        if (
            town.raid.phase === 'active' && guard.mode === 'warning' && guard.until <= now && guard.stainedUntil <= now
        ) {
            const zap = { id: town.nextId, x: guard.x, z: guard.z, target: guard.aim, expires: now + 0.3 };
            town = { ...town, nextId: town.nextId + 1, zaps: [...town.zaps, zap] };
        }
        if (
            town.raid.phase !== 'returning' ||
            Math.hypot(result.guard.x - TOWN_POLICE_DOOR.x, result.guard.z - TOWN_POLICE_DOOR.z) > 0.45
        ) {
            guards.push(result.guard);
        }
    }
    town = { ...town, companion, raid: { ...town.raid, guards } };
    return rescueTownFriend({ ...input, town, player: { ...player, frozenUntil } });
}

export function computeTownGuard(input: TownGuardInput): TownGuardResult {
    const { town, targets, now, step } = input;
    let { guard } = input;
    if (town.raid.phase === 'returning') {
        const position = input.routes.travel({ town, from: guard, target: TOWN_POLICE_DOOR, speed: 5, step });
        return { guard: { ...guard, ...position, mode: 'patrol' }, frozenTarget: undefined };
    }
    if (town.raid.phase !== 'active' || (guard.mode === 'emerging' && guard.until > now)) {
        return { guard, frozenTarget: undefined };
    }
    if (guard.stainedUntil > now) {
        guard = { ...guard, mode: 'patrol', until: 0 };
    }
    if (guard.mode === 'warning') {
        return finishTownGuardZap({ ...input, guard });
    }
    if (guard.until > now) {
        return { guard, frozenTarget: undefined };
    }
    const target = targets.filter((actor) => actor.frozenUntil <= now && actor.shieldUntil <= now)
        .toSorted((left, right) =>
            Math.hypot(left.x - guard.x, left.z - guard.z) - Math.hypot(right.x - guard.x, right.z - guard.z) ||
            (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
        )[0];
    if (
        target && guard.stainedUntil <= now && Math.hypot(target.x - guard.x, target.z - guard.z) < 3.2 &&
        hasTownSight(town, guard, target)
    ) {
        guard = { ...guard, mode: 'warning', target: target.id, aim: { x: target.x, z: target.z }, until: now + 0.9 };
        return { guard, frozenTarget: undefined };
    }
    const destination = target
        ? { x: target.x + Math.sin(guard.id * 2.4) * 1.2, z: target.z + Math.cos(guard.id * 2.4) * 1.2 }
        : TOWN_POLICE_DOOR;
    const speed = guard.stainedUntil > now || isTownSprayed(town, guard, now) ? 0.8 : 2.7;
    const position = input.routes.travel({ town, from: guard, target: destination, speed, step });
    return { guard: { ...guard, ...position, mode: 'patrol' }, frozenTarget: undefined };
}

function finishTownGuardZap(input: TownGuardInput): TownGuardResult {
    const { town, guard, targets, now } = input;
    if (guard.until > now) {
        return { guard, frozenTarget: undefined };
    }
    const target = targets.find((actor) => actor.id === guard.target);
    const hit = target && target.frozenUntil <= now && target.shieldUntil <= now &&
        Math.hypot(target.x - guard.aim.x, target.z - guard.aim.z) < 1 && hasTownSight(town, guard, target);
    return {
        guard: { ...guard, mode: 'cooldown', until: now + 1.3 },
        frozenTarget: hit ? target.id : undefined
    };
}
