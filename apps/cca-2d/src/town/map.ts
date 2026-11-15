export type TownPrank = 'fart' | 'powder' | 'zapper';
export interface TownPoint {
    readonly x: number;
    readonly z: number;
}
export interface TownObstacle extends TownPoint {
    readonly width: number;
    readonly depth: number;
}
export interface TownShop extends TownObstacle {
    readonly id: string;
    readonly kind: 'fruit' | 'powder' | 'zapper';
    readonly sign: string;
    readonly color: string;
}
export const TOWN_LIMIT = 24;
export const TOWN_SHOPS: readonly TownShop[] = [
    { id: 'apples', kind: 'fruit', sign: 'BAD APPLES', x: 5, z: 3, width: 3, depth: 2.4, color: '#a75038' },
    { id: 'pears', kind: 'fruit', sign: 'SOUR PEARS', x: -5, z: 3, width: 3, depth: 2.4, color: '#367876' },
    { id: 'powder', kind: 'powder', sign: 'SNEEZE & SONS', x: -9, z: -9, width: 3, depth: 2.4, color: '#896985' },
    { id: 'zapper', kind: 'zapper', sign: 'SMALL BUSINESS', x: 9, z: -9, width: 3, depth: 2.4, color: '#a89c48' },
    { id: 'oranges', kind: 'fruit', sign: 'BITTER ORANGES', x: -11, z: 14, width: 3, depth: 2.4, color: '#b37a43' },
    { id: 'melons', kind: 'fruit', sign: 'MELON DRAMA', x: 11, z: 14, width: 3, depth: 2.4, color: '#66845e' }
];
export const TOWN_BANK: TownObstacle = { x: 0, z: 18, width: 3.8, depth: 2.4 };
export const TOWN_ICE: TownObstacle = { x: 0, z: 1.9, width: 4.6, depth: 4.2 };
export const TOWN_FOUNTAIN: TownObstacle = { x: 0, z: 8, width: 2.4, depth: 2.4 };
