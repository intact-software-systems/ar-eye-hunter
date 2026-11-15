import { TOWN_SHOPS, type TownPoint, type TownPrank } from './town-map.ts';
import type { TownNpc, TownPlayer, TownState } from './town-rules.ts';

export interface TownPickupComputed {
    readonly town: TownState;
    readonly power: TownPrank;
}

export function releaseTownPrank(town: TownState, player: TownPlayer, now: number): TownState {
    if (player.power === 'powder') {
        return {
            ...town,
            nextId: town.nextId + 1,
            patches: [...town.patches, {
                id: town.nextId,
                x: player.x,
                z: player.z,
                kind: 'powder',
                born: now,
                expires: now + 3.5
            }]
        };
    }
    if (player.power === 'fart') {
        return {
            ...town,
            npcs: town.npcs.map((npc) =>
                Math.hypot(npc.x - player.x, npc.z - player.z) < 3
                    ? { ...npc, mode: 'angry', until: now + 0.7 }
                    : npc
            )
        };
    }
    return zapTownOwners(town, player, now);
}

function zapTownOwners(town: TownState, player: TownPlayer, now: number): TownState {
    const hits: TownNpc[] = [];
    const npcs = town.npcs.map((npc) => {
        const dx = npc.x - player.x;
        const dz = npc.z - player.z;
        const distance = Math.hypot(dx, dz);
        const forward = dx * player.facingX + dz * player.facingZ;
        if (distance >= 7 || forward <= 0 || forward / Math.max(0.1, distance) <= 0.7) {
            return npc;
        }
        hits.push(npc);
        return { ...npc, miniUntil: now + 6, mode: 'angry' as const, until: now + 0.7 };
    });
    const targets: readonly TownPoint[] = hits.length > 0
        ? hits
        : [{ x: player.x + player.facingX * 7, z: player.z + player.facingZ * 7 }];
    const zaps = targets.map((target, index) => ({
        id: town.nextId + index,
        x: player.x,
        z: player.z,
        target: { x: target.x, z: target.z },
        expires: now + 0.35
    }));
    return { ...town, npcs, nextId: town.nextId + zaps.length, zaps: [...town.zaps, ...zaps] };
}

export function collectTownPickup(town: TownState, player: TownPlayer, now: number): TownPickupComputed {
    if (player.power !== 'fart') {
        return { town, power: player.power };
    }
    const shop = TOWN_SHOPS.find((entry) =>
        entry.kind !== 'fruit' &&
        Math.hypot(player.x - entry.x, player.z - (entry.z - 2.5)) < 0.9 &&
        town.shops.some((state) => state.id === entry.id && !state.tipped && state.pickupAt <= now)
    );
    if (!shop || shop.kind === 'fruit') {
        return { town, power: 'fart' };
    }
    return {
        power: shop.kind,
        town: {
            ...town,
            shops: town.shops.map((entry) => entry.id === shop.id ? { ...entry, pickupAt: now + 10 } : entry)
        }
    };
}
