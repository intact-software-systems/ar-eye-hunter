import type { TownObstacle, TownPoint } from '../map.ts';
import type { TownCoat } from '../soiling.ts';

export type TownPersonalityKind =
    | 'silence'
    | 'gardener'
    | 'queue'
    | 'cleaner'
    | 'mayor'
    | 'washer'
    | 'watcher'
    | 'inspector';
export interface TownPersonalityDefinition {
    readonly id: string;
    readonly kind: TownPersonalityKind;
    readonly home: TownPoint;
    readonly prop: TownObstacle;
    readonly color: string;
}
export interface TownPersonality extends TownPersonalityDefinition, TownPoint, TownCoat {
    readonly phase: 'idle' | 'reacting' | 'returning' | 'rivalry' | 'chasing';
    readonly startedAt: number;
    readonly until: number;
    readonly rewardAt: number;
    readonly rivalAt: number;
    readonly rivalCreature: number;
    readonly target: TownPoint;
    readonly collected: number;
    readonly released: boolean;
}

export const TOWN_PERSONALITIES: readonly TownPersonalityDefinition[] = [
    {
        id: 'silence',
        kind: 'silence',
        home: { x: -12, z: 0 },
        prop: { x: -11, z: 1, width: 1, depth: 0.7 },
        color: '#6e7184'
    },
    {
        id: 'gardener',
        kind: 'gardener',
        home: { x: 12, z: -13 },
        prop: { x: 13, z: -12, width: 2, depth: 1 },
        color: '#718064'
    },
    {
        id: 'queue',
        kind: 'queue',
        home: { x: 6, z: 15 },
        prop: { x: 6, z: 17, width: 2.4, depth: 0.5 },
        color: '#9c7658'
    },
    {
        id: 'cleaner',
        kind: 'cleaner',
        home: { x: -10, z: -5 },
        prop: { x: -9, z: -4, width: 1.1, depth: 1 },
        color: '#8b7f58'
    },
    {
        id: 'mayor',
        kind: 'mayor',
        home: { x: -5, z: 9.5 },
        prop: { x: -5, z: 11, width: 1.2, depth: 1.2 },
        color: '#675b75'
    },
    {
        id: 'washer',
        kind: 'washer',
        home: { x: 12, z: 5.5 },
        prop: { x: 12, z: 7, width: 2.4, depth: 0.6 },
        color: '#7d91a2'
    },
    {
        id: 'watcher',
        kind: 'watcher',
        home: { x: -16.4, z: 3.4 },
        prop: { x: -15, z: 2, width: 0.5, depth: 0.5 },
        color: '#9e7a75'
    },
    {
        id: 'inspector',
        kind: 'inspector',
        home: { x: -12, z: -3.5 },
        prop: { x: -12, z: -2, width: 1.2, depth: 0.8 },
        color: '#ac9f86'
    }
];

export function createTownPersonalities(): readonly TownPersonality[] {
    return TOWN_PERSONALITIES.map((resident, index) => ({
        stain: 'clean',
        stainedUntil: 0,
        messImmuneUntil: 0,
        ...resident,
        ...resident.home,
        phase: 'idle',
        startedAt: 0,
        until: 0,
        rewardAt: 0,
        rivalAt: 18 + index * 3,
        rivalCreature: -1,
        target: { ...resident.home },
        collected: 0,
        released: false
    }));
}
