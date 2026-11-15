import { hasTownSight } from './navigation.ts';
import { computeTownTravel } from './routes.ts';
import type { TownCompanion, TownState, TownTickInput } from './state.ts';

export interface TownRescueResult {
    readonly town: TownState;
    readonly frozenUntil: number;
    readonly shieldUntil: number;
}
export function moveTownCompanion(input: TownTickInput): TownCompanion {
    const { town, player, now, step } = input;
    let companion = town.companion;
    if (companion.frozenUntil > now) {
        return companion;
    }
    if (companion.frozenUntil > 0) {
        companion = { ...companion, frozenUntil: 0, shieldUntil: now + 2.5 };
    }
    const target = player.frozenUntil > now
        ? { x: player.x - 0.8, z: player.z }
        : { x: player.x - 2.5, z: player.z - 1.5 };
    const distance = Math.hypot(target.x - companion.x, target.z - companion.z);
    if (distance < 0.3) {
        return companion;
    }
    const position = computeTownTravel({
        town,
        from: companion,
        target,
        speed: player.frozenUntil > now ? 3.3 : 2.5,
        step
    });
    return { ...companion, ...position };
}

export function rescueTownFriend(input: TownTickInput): TownRescueResult {
    const { player, now, step } = input;
    let { town } = input;
    let frozenUntil = player.frozenUntil;
    let shieldUntil = player.shieldUntil;
    const buddy = town.companion;
    const playerFrozen = frozenUntil > now;
    const buddyFrozen = buddy.frozenUntil > now;
    const close = Math.hypot(player.x - buddy.x, player.z - buddy.z) < 1.6 && hasTownSight(town, player, buddy);
    const progress = close && playerFrozen !== buddyFrozen && player.dashTime <= 0 ? town.rescueProgress + step : 0;
    town = { ...town, rescueProgress: progress };
    if (progress < 1) {
        return { town, frozenUntil, shieldUntil };
    }
    if (playerFrozen) {
        frozenUntil = 0;
        shieldUntil = now + 2.5;
    }
    if (buddyFrozen) {
        town = {
            ...town,
            companion: { ...buddy, frozenUntil: 0, shieldUntil: now + 2.5 },
            rescues: town.rescues + 1,
            score: town.score + (town.raid.rewarded ? 0 : 3),
            raid: { ...town.raid, rewarded: true }
        };
    }
    return { town: { ...town, rescueProgress: 0 }, frozenUntil, shieldUntil };
}
