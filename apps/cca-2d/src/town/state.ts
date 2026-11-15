import { TOWN_SHOPS, type TownPoint, type TownPrank } from './map.ts';

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
    readonly rewardAt: number;
}
export interface TownNpc extends TownPoint {
    readonly chaseUntil: number;
    readonly lastSeenAt: number;
    readonly zapAt: number;
    readonly shopId: string;
    readonly mode: 'watching' | 'chasing' | 'warning' | 'cleaning';
    readonly until: number;
    readonly aim: TownPoint;
    readonly cleanAt: number;
    readonly dizzyUntil: number;
    readonly miniUntil: number;
    readonly sickAt: number;
    readonly immuneUntil: number;
}
export interface TownState {
    readonly score: number;
    readonly heat: number;
    readonly raid: TownRaid;
    readonly companion: TownCompanion;
    readonly rescues: number;
    readonly rescueProgress: number;
    readonly fountain: TownFountain;
    readonly cart: TownCart;
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
    readonly frozenUntil: number;
    readonly shieldUntil: number;
    readonly facingX: number;
    readonly facingZ: number;
    readonly dashTime: number;
    readonly power: TownPrank;
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
    readonly frozenUntil: number;
    readonly shieldUntil: number;
    readonly town: TownState;
    readonly power: TownPrank;
    readonly dizzyUntil: number;
    readonly immuneUntil: number;
    readonly sickAt: number;
}
export interface TownGuard extends TownPoint {
    readonly id: number;
    readonly mode: 'patrol' | 'warning' | 'cooldown';
    readonly target: 'player' | 'companion';
    readonly aim: TownPoint;
    readonly until: number;
}
export interface TownRaid {
    readonly rewarded: boolean;
    readonly phase: 'quiet' | 'alarm' | 'active' | 'cooldown';
    readonly until: number;
    readonly callerId: string | null;
    readonly origin: TownPoint;
    readonly guards: readonly TownGuard[];
}
export interface TownCompanion extends TownPoint {
    readonly frozenUntil: number;
    readonly shieldUntil: number;
}
export interface TownFountain {
    readonly broken: boolean;
    readonly since: number;
    readonly repair: number;
    readonly rewardAt: number;
}
export interface TownCart extends TownPoint {
    readonly loose: boolean;
    readonly since: number;
    readonly repair: number;
    readonly rewardAt: number;
}

export function createTownState(): TownState {
    return {
        shops: TOWN_SHOPS.map((shop) => ({ id: shop.id, tipped: false, pickupAt: 0, rewardAt: 0 })),
        npcs: TOWN_SHOPS.map((shop) => ({
            shopId: shop.id,
            chaseUntil: 0,
            lastSeenAt: 0,
            zapAt: 0,
            x: shop.x,
            z: shop.z - 2,
            mode: 'watching',
            until: 0,
            aim: { x: shop.x, z: shop.z - 2 },
            cleanAt: 0,
            dizzyUntil: 0,
            miniUntil: 0,
            sickAt: -1,
            immuneUntil: 0
        })),
        score: 0,
        heat: 0,
        rescues: 0,
        rescueProgress: 0,
        raid: { rewarded: false, phase: 'quiet', until: 0, callerId: null, origin: { x: 0, z: 0 }, guards: [] },
        companion: { x: -2, z: -3, frozenUntil: 0, shieldUntil: 0 },
        fountain: { broken: false, since: 0, repair: 0, rewardAt: 0 },
        cart: { x: -3, z: -6.5, loose: false, since: 0, repair: 0, rewardAt: 0 },
        fruit: [],
        patches: [],
        zaps: [],
        nextId: 1,
        spills: 0,
        cleaned: 0
    };
}
