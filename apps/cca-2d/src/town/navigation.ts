import { TOWN_BUILDINGS, TOWN_FURNITURE } from './layout/map.ts';
import {
    TOWN_FOUNTAIN,
    TOWN_GOVERNMENT,
    TOWN_LIMIT,
    TOWN_OBJECTS,
    TOWN_SHOPS,
    type TownObstacle,
    type TownPoint
} from './map.ts';
import { TOWN_PERSONALITIES } from './personalities/state.ts';
import { TOWN_BARBECUE, TOWN_UMBRELLA } from './spectacles/state.ts';
import type { TownState } from './state.ts';

export function getTownObstacles(town: TownState): readonly TownObstacle[] {
    return [
        ...TOWN_SHOPS,
        TOWN_GOVERNMENT,
        ...TOWN_OBJECTS,
        TOWN_BARBECUE,
        TOWN_UMBRELLA,
        ...TOWN_BUILDINGS,
        ...TOWN_FURNITURE,
        ...TOWN_PERSONALITIES.map((resident) => resident.prop),
        TOWN_FOUNTAIN,
        {
            x: town.cart.x,
            z: town.cart.z,
            width: 1.7,
            depth: 1.3
        }
    ];
}

export function computeTownPosition(town: TownState, from: TownPoint, delta: TownPoint): TownPoint {
    let x = Math.max(-TOWN_LIMIT, Math.min(TOWN_LIMIT, from.x + delta.x));
    let z = Math.max(-TOWN_LIMIT, Math.min(TOWN_LIMIT, from.z + delta.z));
    for (const obstacle of getTownObstacles(town)) {
        const width = obstacle.width / 2 + 0.38;
        const depth = obstacle.depth / 2 + 0.38;
        const inside = Math.abs(from.x - obstacle.x) < width && Math.abs(from.z - obstacle.z) < depth;
        if (inside) {
            const overlapX = width - Math.abs(x - obstacle.x);
            const overlapZ = depth - Math.abs(z - obstacle.z);
            if (overlapX > 0 && overlapZ > 0) {
                if (overlapX < overlapZ) {
                    x = obstacle.x + (x < obstacle.x ? -width : width);
                }
                else {
                    z = obstacle.z + (z < obstacle.z ? -depth : depth);
                }
            }
            continue;
        }
        if (Math.abs(x - obstacle.x) < width && Math.abs(from.z - obstacle.z) < depth) {
            x = from.x;
        }
        if (Math.abs(x - obstacle.x) < width && Math.abs(z - obstacle.z) < depth) {
            z = from.z;
        }
    }
    return { x, z };
}

export function hasTownSight(town: TownState, from: TownPoint, target: TownPoint): boolean {
    return !getTownObstacles(town).some((obstacle) => crossesTownObstacle(from, target, obstacle));
}

export function crossesTownObstacle(from: TownPoint, target: TownPoint, obstacle: TownObstacle): boolean {
    let enter = 0;
    let leave = 1;
    for (const axis of ['x', 'z'] as const) {
        const half = (axis === 'x' ? obstacle.width : obstacle.depth) / 2;
        const low = obstacle[axis] - half;
        const high = obstacle[axis] + half;
        const delta = target[axis] - from[axis];
        if (Math.abs(delta) < 0.001) {
            if (from[axis] < low || from[axis] > high) {
                return false;
            }
            continue;
        }
        const first = (low - from[axis]) / delta;
        const second = (high - from[axis]) / delta;
        enter = Math.max(enter, Math.min(first, second));
        leave = Math.min(leave, Math.max(first, second));
        if (enter > leave) {
            return false;
        }
    }
    return leave > 0.01 && enter < 0.99;
}
