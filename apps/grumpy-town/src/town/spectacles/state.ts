import type { TownObstacle, TownPoint } from '../map.ts';
import type { TownCoat } from '../soiling.ts';

export type TownSpectacleKind = 'fire' | 'poop' | 'vomit';
export interface TownSpectacleRequest {
    readonly kind: TownSpectacleKind;
    readonly origin: TownPoint;
    readonly witnesses: readonly string[];
}
export interface TownSpectacle extends TownSpectacleRequest {
    readonly startedAt: number;
    readonly phase: 'warning' | 'active' | 'cleanup';
    readonly until: number;
    readonly progress: number;
    readonly nextPatchAt: number;
}
export interface TownFirefighter extends TownPoint, TownCoat {
    readonly id: number;
    readonly phase: 'responding' | 'aiming' | 'spraying' | 'returning';
    readonly aim: TownPoint;
    readonly until: number;
}
export interface TownSpectacles {
    readonly active: TownSpectacle | undefined;
    readonly queue: readonly TownSpectacleRequest[];
    readonly firefighters: readonly TownFirefighter[];
    readonly fireReadyAt: number;
    readonly bombReadyAt: number;
    readonly vomitReadyAt: number;
    readonly umbrellaUntil: number;
    readonly fires: number;
    readonly bombs: number;
    readonly dinners: number;
}
export const TOWN_BARBECUE: TownObstacle = { x: -14, z: -8.5, width: 1.2, depth: 1.2 };
export const TOWN_BOMB_PICKUP: TownPoint = { x: 3, z: -12 };
export const TOWN_UMBRELLA: TownObstacle = { x: -9, z: -1, width: 0.5, depth: 0.5 };

export function createTownSpectacles(): TownSpectacles {
    return {
        active: undefined,
        queue: [],
        firefighters: [],
        fireReadyAt: 0,
        bombReadyAt: 0,
        vomitReadyAt: 0,
        umbrellaUntil: 0,
        fires: 0,
        bombs: 0,
        dinners: 0
    };
}
