import { TOWN_LIMIT, TOWN_SHOPS, type TownPoint, type TownPrank, type TownShop } from './town-map.ts';
import { collectTownPickup, releaseTownPrank } from './town-pranks.ts';

export interface TownFruit extends TownPoint {
    readonly id: number;
    readonly shopId: string;
    readonly vx: number;
    readonly vz: number;
    readonly born: number;
}
export interface TownPatch extends TownPoint {
    readonly id: number;
    readonly kind: 'powder' | 'puke';
    readonly born: number;
    readonly expires: number;
}
export interface TownZap extends TownPoint {
    readonly id: number;
    readonly target: TownPoint;
    readonly expires: number;
}
export interface TownShopState {
    readonly id: string;
    readonly tipped: boolean;
    readonly pickupAt: number;
}
export interface TownNpc extends TownPoint {
    readonly shopId: string;
    readonly mode: 'grumpy' | 'angry' | 'warning' | 'cleaning';
    readonly until: number;
    readonly aim: TownPoint;
    readonly cleanAt: number;
    readonly dizzyUntil: number;
    readonly miniUntil: number;
    readonly sickAt: number;
    readonly immuneUntil: number;
}
export interface TownState {
    readonly shops: readonly TownShopState[];
    readonly npcs: readonly TownNpc[];
    readonly fruit: readonly TownFruit[];
    readonly patches: readonly TownPatch[];
    readonly zaps: readonly TownZap[];
    readonly nextId: number;
    readonly spills: number;
    readonly cleaned: number;
}
export interface TownPlayer extends TownPoint {
    readonly facingX: number;
    readonly facingZ: number;
    readonly dashTime: number;
    readonly power: TownPrank;
    readonly miniUntil: number;
    readonly dizzyUntil: number;
    readonly immuneUntil: number;
    readonly sickAt: number;
}
export interface TownTickInput {
    readonly town: TownState;
    readonly player: TownPlayer;
    readonly dash: boolean;
    readonly now: number;
    readonly step: number;
}
export interface TownComputed {
    readonly town: TownState;
    readonly power: TownPrank;
    readonly miniUntil: number;
    readonly dizzyUntil: number;
    readonly immuneUntil: number;
    readonly sickAt: number;
}
interface TownOwnerInput {
    readonly town: TownState;
    readonly npc: TownNpc;
    readonly shop: TownShop;
    readonly player: TownPlayer;
    readonly now: number;
    readonly step: number;
}
interface TownOwnerComputed {
    readonly town: TownState;
    readonly npc: TownNpc;
    readonly miniUntil: number;
}

export function createTownState(): TownState {
    return {
        shops: TOWN_SHOPS.map((shop) => ({ id: shop.id, tipped: false, pickupAt: 0 })),
        npcs: TOWN_SHOPS.map((shop) => ({
            shopId: shop.id,
            x: shop.x,
            z: shop.z - 2,
            mode: 'grumpy',
            until: 0,
            aim: { x: shop.x, z: shop.z - 2 },
            cleanAt: 0,
            dizzyUntil: 0,
            miniUntil: 0,
            sickAt: -1,
            immuneUntil: 0
        })),
        fruit: [],
        patches: [],
        zaps: [],
        nextId: 1,
        spills: 0,
        cleaned: 0
    };
}

export function computeTownTick(input: TownTickInput): TownComputed {
    const { player, now, step } = input;
    let town = advanceTownDebris(input.town, now, step);
    if (input.dash) {
        town = releaseTownPrank(town, player, now);
    }
    town = tipTownShops(town, player, now);
    let miniUntil = player.miniUntil;
    const npcs: TownNpc[] = [];
    for (let index = 0; index < town.npcs.length; index++) {
        const result = computeTownOwner({ town, npc: town.npcs[index], shop: TOWN_SHOPS[index], player, now, step });
        town = result.town;
        miniUntil = Math.max(miniUntil, result.miniUntil);
        npcs.push(result.npc);
    }
    town = { ...town, npcs };
    const exposed = player.immuneUntil <= now &&
        town.patches.some((patch) =>
            patch.kind === 'powder' && now - patch.born > 0.4 &&
            Math.hypot(player.x - patch.x, player.z - patch.z) < 1.8
        );
    const sickAt = exposed ? now + 2.2 : player.sickAt;
    if (sickAt >= 0 && sickAt > now - step && sickAt <= now) {
        town = addPuke(town, player, now);
    }
    const pickup = collectTownPickup(town, { ...player, power: input.dash ? 'fart' : player.power }, now);
    return {
        ...pickup,
        miniUntil,
        sickAt,
        dizzyUntil: exposed ? now + 3.2 : player.dizzyUntil,
        immuneUntil: exposed ? now + 9 : player.immuneUntil
    };
}

function advanceTownDebris(town: TownState, now: number, step: number): TownState {
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

function tipTownShops(town: TownState, player: TownPlayer, now: number): TownState {
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
            shops: result.shops.map((entry) => entry.id === shop.id ? { ...entry, tipped: true } : entry),
            npcs: result.npcs.map((npc) =>
                npc.shopId === shop.id
                    ? { ...npc, x: shop.x + 1.05, z: shop.z - 2.7, mode: 'angry', until: now + 0.7 }
                    : npc
            )
        };
    }
    return result;
}

function computeTownOwner(input: TownOwnerInput): TownOwnerComputed {
    const { player, now, step } = input;
    let { town, npc } = input;
    const powdered = npc.immuneUntil <= now &&
        town.patches.some((patch) => patch.kind === 'powder' && Math.hypot(patch.x - npc.x, patch.z - npc.z) < 2.2);
    if (powdered) {
        npc = {
            ...npc,
            dizzyUntil: now + 3.2,
            sickAt: now + 2.2,
            immuneUntil: now + 9,
            mode: 'angry',
            until: now + 3.8
        };
    }
    if (npc.sickAt >= 0 && npc.sickAt > now - step && npc.sickAt <= now) {
        town = addPuke(town, npc, now);
    }
    if (npc.dizzyUntil > now || npc.until > now) {
        return { town, npc, miniUntil: player.miniUntil };
    }
    if (npc.mode === 'angry') {
        return {
            town,
            npc: { ...npc, mode: 'warning', until: now + 0.85, aim: { x: player.x, z: player.z } },
            miniUntil: player.miniUntil
        };
    }
    if (npc.mode === 'warning') {
        const inRange = Math.hypot(player.x - npc.x, player.z - npc.z) < 9;
        const hit = inRange && Math.hypot(player.x - npc.aim.x, player.z - npc.aim.z) < 1.25;
        const zaps = [...town.zaps, { id: town.nextId, x: npc.x, z: npc.z, target: npc.aim, expires: now + 0.35 }];
        return {
            town: { ...town, nextId: town.nextId + 1, zaps },
            npc: { ...npc, mode: 'cleaning', until: now + 0.3 },
            miniUntil: hit ? now + 6 : player.miniUntil
        };
    }
    if (npc.mode === 'cleaning') {
        return cleanTownShop({ ...input, town, npc });
    }
    return { town, npc, miniUntil: player.miniUntil };
}

function cleanTownShop(input: TownOwnerInput): TownOwnerComputed {
    const { now, step, player, shop } = input;
    let { town, npc } = input;
    const fruit =
        town.fruit.filter((item) => item.shopId === shop.id).toSorted((a, b) =>
            Math.hypot(a.x - npc.x, a.z - npc.z) - Math.hypot(b.x - npc.x, b.z - npc.z)
        )[0];
    const target = fruit ?? { x: shop.x, z: shop.z - 2 };
    const distance = Math.hypot(target.x - npc.x, target.z - npc.z);
    const speed = npc.miniUntil > now ? 1 : 2;
    const travel = Math.min(distance, speed * step);
    npc = {
        ...npc,
        x: npc.x + (target.x - npc.x) / Math.max(0.01, distance) * travel,
        z: npc.z + (target.z - npc.z) / Math.max(0.01, distance) * travel
    };
    if (fruit && distance < 0.45 && npc.cleanAt <= now) {
        town = { ...town, fruit: town.fruit.filter((item) => item.id !== fruit.id), cleaned: town.cleaned + 1 };
        npc = { ...npc, cleanAt: now + 0.6 };
    }
    if (!fruit && distance < 0.2) {
        town = {
            ...town,
            shops: town.shops.map((entry) => entry.id === shop.id ? { ...entry, tipped: false } : entry)
        };
        npc = { ...npc, mode: 'grumpy' };
    }
    return { town, npc, miniUntil: player.miniUntil };
}

function addPuke(town: TownState, position: TownPoint, now: number): TownState {
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
