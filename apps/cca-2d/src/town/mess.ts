import { TOWN_LIMIT, TOWN_SHOPS, type TownPoint } from './map.ts';
import type { TownFruit, TownPlayer, TownState } from './state.ts';

export function advanceTownDebris(town: TownState, now: number, step: number): TownState {
    return {
        ...town,
        fruit: town.fruit.filter((fruit) => now - fruit.born < 30).map((fruit) => ({
            ...fruit,
            x: Math.max(-TOWN_LIMIT, Math.min(TOWN_LIMIT, fruit.x + fruit.vx * step)),
            z: Math.max(-TOWN_LIMIT, Math.min(TOWN_LIMIT, fruit.z + fruit.vz * step)),
            vx: fruit.vx * Math.exp(-3 * step),
            vz: fruit.vz * Math.exp(-3 * step)
        })),
        patches: town.patches.filter((patch) => patch.expires > now),
        zaps: town.zaps.filter((zap) => zap.expires > now)
    };
}

export function tipTownShops(town: TownState, player: TownPlayer, now: number): TownState {
    if (player.dashTime <= 0) {
        return town;
    }
    let result = town;
    for (const shop of TOWN_SHOPS) {
        const state = result.shops.find((entry) => entry.id === shop.id);
        const nearX = Math.max(Math.abs(player.x - shop.x) - shop.width / 2, 0);
        const nearZ = Math.max(Math.abs(player.z - shop.z) - shop.depth / 2, 0);
        const toward = (shop.x - player.x) * player.facingX + (shop.z - player.z) * player.facingZ;
        if (!state || state.tipped || Math.hypot(nearX, nearZ) > 0.57 || toward <= 0) {
            continue;
        }
        const fruit = Array.from({ length: 6 }, (_, index): TownFruit => ({
            id: result.nextId + index,
            shopId: shop.id,
            x: shop.x + (index - 2.5) * 0.43,
            z: shop.z - 1.85 - (index % 2) * 0.65,
            vx: (index - 2.5) * 1.3,
            vz: -1.5 - index % 3,
            born: now
        }));
        result = {
            ...result,
            nextId: result.nextId + 6,
            fruit: [...result.fruit, ...fruit],
            spills: result.spills + 1,
            score: result.score + (state.rewardAt <= now ? 10 : 0),
            shops: result.shops.map((entry) =>
                entry.id === shop.id ? { ...entry, tipped: true, rewardAt: now + 30 } : entry
            ),
            npcs: result.npcs.map((npc) =>
                npc.shopId === shop.id
                    ? { ...npc, x: shop.x + 1.05, z: shop.z - 2.7, mode: 'cleaning', until: now + 0.4 }
                    : npc
            )
        };
    }
    return result;
}

export function addPuke(town: TownState, position: TownPoint, now: number): TownState {
    return {
        ...town,
        nextId: town.nextId + 1,
        patches: [...town.patches, {
            id: town.nextId,
            x: position.x,
            z: position.z - 0.45,
            kind: 'puke',
            born: now,
            expires: now + 12
        }]
    };
}
