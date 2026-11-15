import { TOWN_FOUNTAIN, type TownPoint } from './map.ts';
import { rewardTownMischief } from './mischief.ts';
import { repairTownObject } from './objects.ts';
import { computeTownTravel } from './routes.ts';
import type {
    TownNpc,
    TownState,
    TownTickInput
} from './state.ts';

export interface TownRepair {
    readonly town: TownState;
    readonly npc: TownNpc;
    readonly now: number;
    readonly step: number;
}
export interface TownRepairResult {
    readonly town: TownState;
    readonly npc: TownNpc;
    readonly busy: boolean;
}

export function computeTownProps(input: TownTickInput): TownState {
    const { player, now } = input;
    let town = input.town;
    const hitFountain = player.dashTime > 0 && Math.hypot(player.x, player.z - TOWN_FOUNTAIN.z) < 1.9;
    if (hitFountain && !town.fountain.broken) {
        if (town.fountain.rewardAt <= now) {
            town = rewardTownMischief(town);
        }
        town = {
            ...town,
            fountain: { broken: true, since: now, repair: 0, rewardAt: now + 30 }
        };
    }
    const hitCart = player.dashTime > 0 && Math.hypot(player.x - town.cart.x, player.z - town.cart.z) < 1.6;
    if (hitCart && !town.cart.loose) {
        if (town.cart.rewardAt <= now) {
            town = rewardTownMischief(town);
        }
        town = {
            ...town,
            cart: { ...town.cart, loose: true, since: now, repair: 0, rewardAt: now + 30 }
        };
    }
    if (town.cart.loose) {
        town = { ...town, cart: { ...town.cart, x: -3 + Math.min(7.5, (now - town.cart.since) * 1.5) } };
    }
    if (town.fountain.broken && now - town.fountain.since > 22) {
        town = { ...town, fountain: { ...town.fountain, broken: false, repair: 0 } };
    }
    if (town.cart.loose && now - town.cart.since > 28) {
        town = { ...town, cart: { ...town.cart, loose: false, x: -3, repair: 0 } };
    }
    return town;
}

export function hasTownDuty(town: TownState, shopId: string): boolean {
    return town.objects.some((object) => object.owner === shopId && object.damagedUntil > 0) ||
        town.shops.some((shop) => shop.id === shopId && shop.tipped) ||
        (shopId === 'apples' && town.fountain.broken) || (shopId === 'pears' && town.cart.loose);
}

export function repairTownProp(input: TownRepair): TownRepairResult {
    const { npc, now, step } = input;
    let { town } = input;
    const fountain = npc.shopId === 'apples' && town.fountain.broken;
    const cart = npc.shopId === 'pears' && town.cart.loose;
    if (!fountain && !cart) {
        return repairTownObject(input);
    }
    const object = fountain ? TOWN_FOUNTAIN : town.cart;
    const target = { x: object.x, z: object.z - 2 };
    const position = computeTownTravel({ town, from: npc, target, speed: 2.3, step });
    const near = Math.hypot(position.x - target.x, position.z - target.z) < 0.5;
    if (fountain) {
        const repair = near ? town.fountain.repair + step : 0;
        town = { ...town, fountain: { ...town.fountain, repair, broken: repair < 4 } };
    }
    if (cart && now - town.cart.since >= 5) {
        const repair = near ? town.cart.repair + step : 0;
        town = { ...town, cart: { ...town.cart, repair, loose: repair < 3, x: repair >= 3 ? -3 : town.cart.x } };
    }
    return { town, npc: { ...npc, ...position, mode: 'cleaning' }, busy: true };
}

export function getTownJet(town: TownState, now: number): TownPoint {
    const angle = Math.PI + Math.sin((now - town.fountain.since) * 1.3) * 1.1;
    return { x: Math.sin(angle), z: Math.cos(angle) };
}

export function isTownSprayed(town: TownState, point: TownPoint, now: number): boolean {
    if (!town.fountain.broken) {
        return false;
    }
    const direction = getTownJet(town, now);
    const x = point.x - TOWN_FOUNTAIN.x;
    const z = point.z - TOWN_FOUNTAIN.z;
    const along = x * direction.x + z * direction.z;
    return along > 1 && along < 5.5 && Math.abs(x * direction.z - z * direction.x) < 0.8;
}
