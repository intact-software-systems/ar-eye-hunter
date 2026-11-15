import { TOWN_SHOPS, type TownShop } from './map.ts';
import { addPuke } from './mess.ts';
import { hasTownSight } from './navigation.ts';
import {
    hasTownDuty,
    isTownSprayed,
    repairTownProp
} from './props.ts';
import type { TownRoutes } from './routes.ts';
import type {
    TownNpc,
    TownPlayer,
    TownState,
    TownTickInput
} from './state.ts';

interface TownOwnerInput {
    readonly routes: TownRoutes;
    readonly town: TownState;
    readonly npc: TownNpc;
    readonly shop: TownShop;
    readonly player: TownPlayer;
    readonly now: number;
    readonly step: number;
}
interface TownOwnerResult {
    readonly town: TownState;
    readonly npc: TownNpc;
    readonly shieldUntil: number;
}
export interface TownOwnersResult {
    readonly town: TownState;
    readonly shieldUntil: number;
}

export function computeTownOwners(input: TownTickInput): TownOwnersResult {
    const { player, now, step } = input;
    let town = input.town;
    let shieldUntil = player.shieldUntil;
    const npcs: TownNpc[] = [];
    for (const [index, npc] of town.npcs.entries()) {
        const result = computeTownOwner({
            routes: input.routes,
            town,
            npc,
            shop: TOWN_SHOPS[index],
            player: { ...player, shieldUntil },
            now,
            step
        });
        town = result.town;
        shieldUntil = result.shieldUntil;
        npcs.push(result.npc);
    }
    return { town: { ...town, npcs }, shieldUntil };
}

export function witnessTownPrank(input: TownTickInput): TownState {
    const { player, now } = input;
    const npcs = input.town.npcs.map((npc): TownNpc => {
        if (hasTownDuty(input.town, npc.shopId) || npc.stainedUntil > now || npc.dizzyUntil > now || npc.until > now) {
            return npc;
        }
        if (Math.hypot(npc.x - player.x, npc.z - player.z) > 12 || !hasTownSight(input.town, npc, player)) {
            return npc;
        }
        return { ...npc, mode: 'chasing', chaseUntil: now + 8, lastSeenAt: now, zapAt: now + 0.85 };
    });
    return { ...input.town, npcs };
}

function computeTownOwner(input: TownOwnerInput): TownOwnerResult {
    const { player, now, step } = input;
    let { town, npc } = input;
    const powdered = npc.immuneUntil <= now &&
        town.patches.some((patch) => patch.kind === 'powder' && Math.hypot(patch.x - npc.x, patch.z - npc.z) < 2.2);
    if (powdered) {
        npc = { ...npc, dizzyUntil: now + 3.2, sickAt: now + 2.2, immuneUntil: now + 9 };
    }
    if (npc.sickAt >= 0 && npc.sickAt > now - step && npc.sickAt <= now) {
        town = addPuke(town, npc, now);
    }
    if (npc.stainedUntil > now) {
        return { town, npc: { ...npc, mode: 'cleaning' }, shieldUntil: player.shieldUntil };
    }
    if (hasTownDuty(town, npc.shopId)) {
        npc = { ...npc, mode: 'cleaning' };
    }
    if (npc.dizzyUntil > now || npc.until > now) {
        return { town, npc, shieldUntil: player.shieldUntil };
    }
    if (npc.mode === 'cleaning') {
        return cleanTownShop({ ...input, town, npc });
    }
    if (npc.mode === 'chasing' || npc.mode === 'warning') {
        return chaseTownPlayer({ ...input, town, npc });
    }
    const home = { x: input.shop.x, z: input.shop.z - 2 };
    const position = input.routes.travel({ town, from: npc, target: home, speed: 2, step });
    return { town, npc: { ...npc, ...position }, shieldUntil: player.shieldUntil };
}

function chaseTownPlayer(input: TownOwnerInput): TownOwnerResult {
    const { town, player, now, step } = input;
    let { npc } = input;
    const distance = Math.hypot(player.x - npc.x, player.z - npc.z);
    const visible = distance < 12 && hasTownSight(town, npc, player);
    if (visible) {
        npc = { ...npc, lastSeenAt: now };
    }
    if (now >= npc.chaseUntil || now - npc.lastSeenAt > 1.5 || player.frozenUntil > now) {
        return { town, npc: { ...npc, mode: 'watching' }, shieldUntil: player.shieldUntil };
    }
    if (npc.mode === 'warning' && npc.until <= now) {
        const hit = visible && distance < 6 && Math.hypot(player.x - npc.aim.x, player.z - npc.aim.z) < 1.1 &&
            player.shieldUntil <= now;
        const zap = { id: town.nextId, x: npc.x, z: npc.z, target: npc.aim, expires: now + 0.3 };
        return {
            town: {
                ...town,
                score: Math.max(0, town.score - (hit ? 3 : 0)),
                nextId: town.nextId + 1,
                zaps: [...town.zaps, zap]
            },
            npc: { ...npc, mode: 'chasing', zapAt: now + 2 },
            shieldUntil: hit ? now + 2 : player.shieldUntil
        };
    }
    if (visible && distance < 5 && npc.zapAt <= now) {
        return {
            town,
            npc: { ...npc, mode: 'warning', until: now + 0.85, aim: { x: player.x, z: player.z } },
            shieldUntil: player.shieldUntil
        };
    }
    const slowed = npc.miniUntil > now || isTownSprayed(town, npc, now) ||
        town.fruit.some((fruit) => Math.hypot(npc.x - fruit.x, npc.z - fruit.z) < 0.8);
    const position = input.routes.travel({ town, from: npc, target: player, speed: slowed ? 1 : 2.7, step });
    return { town, npc: { ...npc, ...position }, shieldUntil: player.shieldUntil };
}

function cleanTownShop(input: TownOwnerInput): TownOwnerResult {
    const { now, step, player, shop } = input;
    let { town, npc } = input;
    const repair = repairTownProp({ routes: input.routes, town, npc, now, step });
    if (repair.busy) {
        return { town: repair.town, npc: repair.npc, shieldUntil: player.shieldUntil };
    }
    const fruit =
        town.fruit.filter((item) => item.shopId === shop.id).toSorted((a, b) =>
            Math.hypot(a.x - npc.x, a.z - npc.z) - Math.hypot(b.x - npc.x, b.z - npc.z)
        )[0];
    const target = fruit ?? { x: shop.x, z: shop.z - 2 };
    const distance = Math.hypot(target.x - npc.x, target.z - npc.z);
    const position = input.routes.travel({ town, from: npc, target, speed: npc.miniUntil > now ? 1 : 2.3, step });
    npc = { ...npc, ...position };
    if (fruit && distance < 0.5 && npc.cleanAt <= now) {
        town = { ...town, fruit: town.fruit.filter((item) => item.id !== fruit.id), cleaned: town.cleaned + 1 };
        npc = { ...npc, cleanAt: now + 0.6 };
    }
    if (!fruit && distance < 0.25) {
        town = {
            ...town,
            shops: town.shops.map((entry) => entry.id === shop.id ? { ...entry, tipped: false } : entry)
        };
        npc = { ...npc, mode: 'watching' };
    }
    return { town, npc, shieldUntil: player.shieldUntil };
}
