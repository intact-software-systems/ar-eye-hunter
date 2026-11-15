import { moveTownCompanion, rescueTownFriend, type TownRescueResult } from './companion.ts';
import { TOWN_LIMIT } from './map.ts';
import { hasTownSight } from './navigation.ts';
import { hasTownDuty, isTownSprayed } from './props.ts';
import { computeTownTravel } from './routes.ts';
import type { TownGuard, TownPlayer, TownRaid, TownState, TownTickInput } from './state.ts';

interface TownGuardInput {
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
        if (guard.mode === 'warning' && guard.until <= now) {
            const zap = { id: town.nextId, x: guard.x, z: guard.z, target: guard.aim, expires: now + 0.3 };
            town = { ...town, nextId: town.nextId + 1, zaps: [...town.zaps, zap] };
        }
        guards.push(result.guard);
    }
    town = { ...town, companion, raid: { ...town.raid, guards } };
    return rescueTownFriend({ ...input, town, player: { ...player, frozenUntil } });
}

function advanceTownRaid(input: TownTickInput): TownState {
    const { now, player } = input;
    const { town } = input;
    const raid = town.raid;
    if (raid.phase === 'quiet' && town.heat >= 3) {
        const caller = town.npcs.find((npc) => npc.mode === 'chasing' || npc.mode === 'warning');
        if (!caller) {
            return { ...town, heat: 0 };
        }
        return {
            ...town,
            raid: {
                phase: 'alarm',
                until: now + 4,
                callerId: caller.shopId,
                origin: { x: caller.x, z: caller.z },
                guards: [],
                rewarded: false
            }
        };
    }
    if (raid.phase === 'alarm') {
        const caller = town.npcs.find((npc) => npc.shopId === raid.callerId);
        const interrupted = !caller || hasTownDuty(town, caller.shopId) || caller.dizzyUntil > now ||
            (input.dash && Math.hypot(player.x - caller.x, player.z - caller.z) < 2.6);
        if (interrupted) {
            return { ...town, heat: 0, raid: { ...raid, phase: 'cooldown', until: now + 6 } };
        }
        if (raid.until <= now) {
            return { ...town, raid: { ...raid, phase: 'active', until: now + 20, guards: createTownGuards(raid) } };
        }
    }
    if (raid.phase === 'active' && raid.until <= now) {
        return { ...town, heat: 0, raid: { ...raid, phase: 'cooldown', until: now + 12, guards: [] } };
    }
    if (raid.phase === 'cooldown' && raid.until <= now) {
        return { ...town, heat: 0, raid: { ...raid, phase: 'quiet', callerId: null } };
    }
    return town;
}

function createTownGuards(raid: TownRaid): readonly TownGuard[] {
    return [-1, 0, 1].map((offset, index) => ({
        id: index,
        x: Math.max(-TOWN_LIMIT, Math.min(TOWN_LIMIT, raid.origin.x + offset * 2)),
        z: Math.max(-TOWN_LIMIT, raid.origin.z - 9),
        mode: 'patrol',
        target: 'player',
        aim: { ...raid.origin },
        until: 0
    }));
}

function computeTownGuard(input: TownGuardInput): TownGuardResult {
    const { town, player, now, step } = input;
    let { guard } = input;
    const buddy = town.companion;
    const playerAvailable = player.frozenUntil <= now && player.shieldUntil <= now;
    const buddyAvailable = buddy.frozenUntil <= now && buddy.shieldUntil <= now;
    const playerDistance = Math.hypot(player.x - guard.x, player.z - guard.z);
    const buddyDistance = Math.hypot(buddy.x - guard.x, buddy.z - guard.z);
    if (guard.mode === 'warning') {
        return finishTownGuardZap(input);
    }
    if (guard.until > now) {
        return { guard, playerFrozen: false, buddyFrozen: false };
    }
    const targetName = playerAvailable && (!buddyAvailable || playerDistance < buddyDistance) ? 'player' : 'companion';
    const target = targetName === 'player' ? player : buddy;
    const available = targetName === 'player' ? playerAvailable : buddyAvailable;
    const inDistrict = Math.hypot(target.x - town.raid.origin.x, target.z - town.raid.origin.z) < 12;
    const distance = Math.hypot(target.x - guard.x, target.z - guard.z);
    if (available && inDistrict && distance < 3.2 && hasTownSight(town, guard, target)) {
        guard = { ...guard, mode: 'warning', target: targetName, aim: { x: target.x, z: target.z }, until: now + 0.7 };
        return { guard, playerFrozen: false, buddyFrozen: false };
    }
    const destination = available && inDistrict
        ? target
        : { x: town.raid.origin.x + (guard.id - 1) * 3, z: town.raid.origin.z - 6 };
    const speed = isTownSprayed(town, guard, now) ? 0.8 : 2.8;
    const position = computeTownTravel({ town, from: guard, target: destination, speed, step });
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
