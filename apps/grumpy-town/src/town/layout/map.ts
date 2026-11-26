import type { TownObstacle, TownPoint } from '../map.ts';

export interface TownBuilding extends TownObstacle {
    readonly id: string;
    readonly kind: 'civic' | 'shop' | 'house' | 'booth' | 'fire-station';
    readonly height: number;
    readonly color: string;
    readonly roof: string;
    readonly sign: string;
}
export interface TownFurniture extends TownObstacle {
    readonly id: string;
    readonly kind: 'bench' | 'mailbox' | 'bus-stop' | 'bikes' | 'planter' | 'table' | 'notice' | 'lamp';
}

export const TOWN_FIRE_DOOR: TownPoint = { x: -19, z: 11.9 };
export const TOWN_FIRE_BAY: TownPoint = { x: -15, z: 9 };

export const TOWN_BUILDINGS: readonly TownBuilding[] = [
    {
        id: 'fire-station',
        kind: 'fire-station',
        x: -19,
        z: 15,
        width: 6,
        depth: 5,
        height: 3.7,
        color: '#a35f49',
        roof: '#5e5e59',
        sign: 'GRUMPY FIRE BRIGADE'
    },
    {
        id: 'bakery',
        kind: 'shop',
        x: -19,
        z: 6,
        width: 5,
        depth: 4,
        height: 4.5,
        color: '#bca77b',
        roof: '#7d4b3a',
        sign: 'STALE & SONS'
    },
    {
        id: 'cafe',
        kind: 'shop',
        x: -19,
        z: -4,
        width: 5,
        depth: 5,
        height: 3.5,
        color: '#8a9d91',
        roof: '#566f6b',
        sign: 'CAFE NO REFILLS'
    },
    {
        id: 'post-office',
        kind: 'civic',
        x: -18,
        z: -16,
        width: 7,
        depth: 4,
        height: 4,
        color: '#b18572',
        roof: '#625758',
        sign: 'DEPARTMENT OF DELAYS'
    },
    {
        id: 'terrace-west',
        kind: 'house',
        x: -8,
        z: -20,
        width: 5,
        depth: 3,
        height: 4.8,
        color: '#8e9882',
        roof: '#7b5847',
        sign: 'NO BALL GAMES'
    },
    {
        id: 'terrace-center',
        kind: 'house',
        x: 0,
        z: -20,
        width: 5,
        depth: 3,
        height: 5.4,
        color: '#a68d7f',
        roof: '#555f67',
        sign: 'NO DOORBELL'
    },
    {
        id: 'terrace-east',
        kind: 'house',
        x: 9,
        z: -20,
        width: 5,
        depth: 3,
        height: 4,
        color: '#a6a176',
        roof: '#8a5d4c',
        sign: 'CURTAINS CLOSED'
    },
    {
        id: 'florist',
        kind: 'shop',
        x: 19,
        z: -16,
        width: 5,
        depth: 4,
        height: 3.8,
        color: '#9b8294',
        roof: '#626d5c',
        sign: 'DO NOT SNIFF'
    },
    {
        id: 'newsstand',
        kind: 'booth',
        x: 19,
        z: -6,
        width: 3.5,
        depth: 2.6,
        height: 2.6,
        color: '#887b5a',
        roof: '#9e634b',
        sign: 'BAD NEWS ONLY'
    },
    {
        id: 'clockmaker',
        kind: 'shop',
        x: 19,
        z: 5,
        width: 4,
        depth: 4,
        height: 4.8,
        color: '#8d9d9d',
        roof: '#72565b',
        sign: 'YOU ARE LATE'
    },
    {
        id: 'balcony-house',
        kind: 'house',
        x: 19,
        z: 16,
        width: 5,
        depth: 4,
        height: 5,
        color: '#b29d87',
        roof: '#596763',
        sign: 'KEEP IT DOWN'
    },
    {
        id: 'library',
        kind: 'civic',
        x: -9,
        z: 21,
        width: 5,
        depth: 3,
        height: 4.6,
        color: '#a2a28b',
        roof: '#655d67',
        sign: 'EXTREME SILENCE'
    },
    {
        id: 'council-annex',
        kind: 'civic',
        x: 9,
        z: 21,
        width: 5,
        depth: 3,
        height: 3.5,
        color: '#b1a18a',
        roof: '#716c5d',
        sign: 'COMPLAINTS HERE'
    }
];

export const TOWN_FURNITURE: readonly TownFurniture[] = [
    { id: 'bench-west', kind: 'bench', x: -11, z: -15, width: 2, depth: 0.6 },
    { id: 'bench-east', kind: 'bench', x: 12, z: 0, width: 2, depth: 0.6 },
    { id: 'mailbox', kind: 'mailbox', x: -13, z: -12, width: 0.7, depth: 0.7 },
    { id: 'bus-stop', kind: 'bus-stop', x: 16, z: -1, width: 2.5, depth: 0.7 },
    { id: 'bikes', kind: 'bikes', x: 13, z: -17, width: 2, depth: 0.7 },
    { id: 'planter', kind: 'planter', x: -12, z: 6, width: 1.2, depth: 1.2 },
    { id: 'cafe-table-north', kind: 'table', x: -14, z: -2, width: 1.6, depth: 1.6 },
    { id: 'cafe-table-south', kind: 'table', x: -14, z: -5, width: 1.6, depth: 1.6 },
    { id: 'notice', kind: 'notice', x: -4, z: 16, width: 1.6, depth: 0.5 },
    { id: 'lamp-west', kind: 'lamp', x: -15, z: -10, width: 0.3, depth: 0.3 },
    { id: 'lamp-east', kind: 'lamp', x: 15, z: 10, width: 0.3, depth: 0.3 }
];
