import type { TownPoint } from './map.ts';
import { hasTownSight } from './navigation.ts';
import { isTownSprayed } from './props.ts';
import type {
    TownGuard,
    TownPlayer,
    TownState,
    TownTickInput
} from './state.ts';

export type TownStain = 'clean' | 'poop' | 'pee' | 'puke';
export interface TownCoat {
    readonly stain: TownStain;
    readonly stainedUntil: number;
    readonly messImmuneUntil: number;
}
export interface TownSoilingComputed {
    readonly town: TownState;
    readonly player: TownPlayer;
    readonly hitResident: boolean;
}
export interface TownSplash {
    readonly town: TownState;
    readonly player: TownPlayer;
    readonly source: TownPoint;
    readonly target: TownPoint;
    readonly radius: number;
    readonly kind: 'poop' | 'pee' | 'puke';
    readonly now: number;
}

export function createCleanCoat(): TownCoat {
    return { stain: 'clean', stainedUntil: 0, messImmuneUntil: 0 };
}

export function splashTown(input: TownSplash): TownSoilingComputed {
    const { town, player, now, kind, source, target } = input;
    const hits = (point: TownPoint & TownCoat) =>
        point.messImmuneUntil <= now &&
        Math.hypot(point.x - target.x, point.z - target.z) < input.radius && hasTownSight(town, source, point);
    const hitsGuard = (guard: TownGuard) => (guard.mode !== 'emerging' || guard.until <= now) && hits(guard);
    const hitResident = town.npcs.some(hits) || town.personalities.some(hits) || town.raid.guards.some(hitsGuard);
    return {
        player: hits(player) ? { ...player, ...soilTownCoat(kind, now) } : player,
        hitResident,
        town: {
            ...town,
            personalities: town.personalities.map((resident) =>
                hits(resident) ? { ...resident, ...soilTownCoat(kind, now) } : resident
            ),
            spectacles: {
                ...town.spectacles,
                firefighters: town.spectacles.firefighters.map((actor) =>
                    hits(actor) ? { ...actor, ...soilTownCoat(kind, now) } : actor
                )
            },
            npcs: town.npcs.map((npc) => hits(npc) ? { ...npc, ...soilTownCoat(kind, now), mode: 'cleaning' } : npc),
            companion: hits(town.companion) ? { ...town.companion, ...soilTownCoat(kind, now) } : town.companion,
            raid: {
                ...town.raid,
                guards: town.raid.guards.map((guard) =>
                    hitsGuard(guard)
                        ? { ...guard, ...soilTownCoat(kind, now), mode: 'patrol', until: now + 1 }
                        : guard
                )
            }
        }
    };
}

export function computeTownSoiling(input: TownTickInput): TownSoilingComputed {
    const { town, now } = input;
    return {
        player: { ...input.player, ...computeTownCoat(input, input.player) },
        hitResident: false,
        town: {
            ...town,
            personalities: town.personalities.map((actor) => ({ ...actor, ...computeTownCoat(input, actor) })),
            spectacles: {
                ...town.spectacles,
                firefighters: town.spectacles.firefighters.map((actor) => ({
                    ...actor,
                    ...computeTownCoat(input, actor)
                }))
            },
            npcs: town.npcs.map((npc) => ({ ...npc, ...computeTownCoat(input, npc) })),
            companion: { ...town.companion, ...computeTownCoat(input, town.companion) },
            raid: {
                ...town.raid,
                guards: town.raid.guards.map((guard) =>
                    guard.mode === 'emerging' && guard.until > now
                        ? guard
                        : { ...guard, ...computeTownCoat(input, guard) }
                )
            },
            patches: town.patches.filter((patch) => patch.expires > now)
        }
    };
}

function computeTownCoat(input: TownTickInput, actor: TownPoint & TownCoat): TownCoat {
    const { town, now } = input;
    const water = isTownSprayed(town, actor, now) ||
        town.patches.some((patch) =>
            patch.expires > now && patch.kind === 'water' && Math.hypot(patch.x - actor.x, patch.z - actor.z) < 1.6
        );
    if (water) {
        return { stain: 'clean', stainedUntil: 0, messImmuneUntil: now + 2 };
    }
    const coat = actor.stainedUntil <= now ? { ...actor, stain: 'clean' as const, stainedUntil: 0 } : actor;
    if (coat.messImmuneUntil > now) {
        return coat;
    }
    const patch = town.patches.find((patch) =>
        patch.expires > now && (patch.kind === 'poop' || patch.kind === 'pee' || patch.kind === 'puke') &&
        Math.hypot(patch.x - actor.x, patch.z - actor.z) < 0.8
    );
    if (patch?.kind === 'poop' || patch?.kind === 'pee' || patch?.kind === 'puke') {
        return soilTownCoat(patch.kind, now);
    }
    return coat;
}

function soilTownCoat(stain: 'poop' | 'pee' | 'puke', now: number): TownCoat {
    return { stain, stainedUntil: now + 6, messImmuneUntil: now + 7 };
}
