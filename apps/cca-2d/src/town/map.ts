export type TownPrank = 'fart' | 'powder' | 'zapper' | 'poop-bomb';
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
export const TOWN_GOVERNMENT: TownObstacle = { x: 0, z: 18, width: 6, depth: 3 };
export const TOWN_ICE: TownObstacle = { x: 0, z: 1.9, width: 4.6, depth: 4.2 };
export const TOWN_FOUNTAIN: TownObstacle = { x: 0, z: 8, width: 2.4, depth: 2.4 };

export const TOWN_POLICE_DOOR: TownPoint = { x: 0, z: 15.9 };

export interface TownObjectDefinition extends TownObstacle {
    readonly id: string;
    readonly kind: 'bin' | 'fish' | 'toilet' | 'hydrant';
    readonly owner: string;
}
export const TOWN_OBJECTS: readonly TownObjectDefinition[] = [
    { id: 'bin-west', kind: 'bin', owner: 'pears', x: -3.5, z: -2.5, width: 0.9, depth: 0.9 },
    { id: 'bin-east', kind: 'bin', owner: 'melons', x: 6, z: 11, width: 0.9, depth: 0.9 },
    { id: 'fish', kind: 'fish', owner: 'oranges', x: -7, z: 8, width: 2, depth: 1.2 },
    { id: 'toilet', kind: 'toilet', owner: 'zapper', x: 5, z: -4.5, width: 1.4, depth: 1.4 },
    { id: 'hydrant', kind: 'hydrant', owner: 'powder', x: -5.5, z: -6, width: 0.7, depth: 0.7 }
];
