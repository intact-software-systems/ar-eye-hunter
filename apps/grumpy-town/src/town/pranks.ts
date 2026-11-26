import {
    TOWN_SHOPS,
    type TownPoint,
    type TownPrank
} from './map.ts';
import { hasTownSight } from './navigation.ts';
import { requestTownSpectacle } from './spectacles/rules.ts';
import { TOWN_BOMB_PICKUP } from './spectacles/state.ts';
import type {
    TownNpc,
    TownPlayer,
    TownState
} from './state.ts';

export interface TownPickupComputed {
    readonly town: TownState;
    readonly power: TownPrank;
}

export function releaseTownPrank(town: TownState, player: TownPlayer, now: number): TownState {
    if (player.power === 'poop-bomb') {
        return requestTownSpectacle(town, { kind: 'poop', origin: { x: player.x, z: player.z }, witnesses: [] });
    }
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
        return town;
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
        if (
            !hasTownSight(town, player, npc) || distance >= 7 || forward <= 0 ||
            forward / Math.max(0.1, distance) <= 0.7
        ) {
            return npc;
        }
        hits.push(npc);
        return { ...npc, miniUntil: now + 6 };
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
    if (
        Math.hypot(player.x - TOWN_BOMB_PICKUP.x, player.z - TOWN_BOMB_PICKUP.z) < 0.9 &&
        town.spectacles.bombReadyAt <= now && town.spectacles.active?.kind !== 'poop' &&
        !town.spectacles.queue.some((event) => event.kind === 'poop')
    ) {
        return { power: 'poop-bomb', town: { ...town, spectacles: { ...town.spectacles, bombReadyAt: now + 45 } } };
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
