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
    TownGuard,
    TownPlayer,
    TownState,
    TownTickInput
} from './state.ts';

interface TownGuardInput {
    readonly routes: TownRoutes;
    readonly town: TownState;
    readonly guard: TownGuard;
    readonly player: TownPlayer;
    readonly now: number;
    readonly step: number;
}
interface TownGuardResult {
    readonly guard: TownGuard;
    readonly playerFrozen: boolean;
    readonly buddyFrozen: boolean;
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
            player: { ...player, frozenUntil },
            now,
            step
        });
        if (result.playerFrozen) {
            frozenUntil = now + 6;
        }
        if (result.buddyFrozen) {
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

function computeTownGuard(input: TownGuardInput): TownGuardResult {
    const { town, player, now, step } = input;
    let { guard } = input;
    if (town.raid.phase === 'returning') {
        const position = input.routes.travel({ town, from: guard, target: TOWN_POLICE_DOOR, speed: 5, step });
        return { guard: { ...guard, ...position, mode: 'patrol' }, playerFrozen: false, buddyFrozen: false };
    }
    if (guard.mode === 'emerging' && guard.until > now) {
        return { guard, playerFrozen: false, buddyFrozen: false };
    }
    if (guard.stainedUntil > now) {
        guard = { ...guard, mode: 'patrol', until: 0 };
    }
    const buddy = town.companion;
    const playerAvailable = player.frozenUntil <= now && player.shieldUntil <= now;
    const buddyAvailable = buddy.frozenUntil <= now && buddy.shieldUntil <= now;
    const playerDistance = Math.hypot(player.x - guard.x, player.z - guard.z);
    const buddyDistance = Math.hypot(buddy.x - guard.x, buddy.z - guard.z);
    if (guard.mode === 'warning') {
        return finishTownGuardZap({ ...input, guard });
    }
    if (guard.until > now) {
        return { guard, playerFrozen: false, buddyFrozen: false };
    }
    const targetName = playerAvailable && (!buddyAvailable || playerDistance < buddyDistance) ? 'player' : 'companion';
    const target = targetName === 'player' ? player : buddy;
    const available = targetName === 'player' ? playerAvailable : buddyAvailable;
    const distance = Math.hypot(target.x - guard.x, target.z - guard.z);
    if (available && guard.stainedUntil <= now && distance < 3.2 && hasTownSight(town, guard, target)) {
        guard = { ...guard, mode: 'warning', target: targetName, aim: { x: target.x, z: target.z }, until: now + 0.9 };
        return { guard, playerFrozen: false, buddyFrozen: false };
    }
    const destination = available
        ? { x: target.x + Math.sin(guard.id * 2.4) * 1.2, z: target.z + Math.cos(guard.id * 2.4) * 1.2 }
        : TOWN_POLICE_DOOR;
    const speed = guard.stainedUntil > now || isTownSprayed(town, guard, now) ? 0.8 : 2.7;
    const position = input.routes.travel({ town, from: guard, target: destination, speed, step });
    return { guard: { ...guard, ...position, mode: 'patrol' }, playerFrozen: false, buddyFrozen: false };
}

function finishTownGuardZap(input: TownGuardInput): TownGuardResult {
    const { town, guard, player, now } = input;
    if (guard.until > now) {
        return { guard, playerFrozen: false, buddyFrozen: false };
    }
    const target = guard.target === 'player' ? player : town.companion;
    const hit = target.frozenUntil <= now && target.shieldUntil <= now &&
        Math.hypot(target.x - guard.aim.x, target.z - guard.aim.z) < 1 && hasTownSight(town, guard, target);
    return {
        guard: { ...guard, mode: 'cooldown', until: now + 1.3 },
        playerFrozen: hit && guard.target === 'player',
        buddyFrozen: hit && guard.target === 'companion'
    };
}
