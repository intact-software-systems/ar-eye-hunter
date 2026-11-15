import {
    TOWN_FOUNTAIN,
    TOWN_GOVERNMENT,
    TOWN_OBJECTS,
    TOWN_SHOPS,
    type TownObstacle,
    type TownPoint
} from './map.ts';
import {
    computeTownPosition,
    crossesTownObstacle,
    getTownObstacles
} from './navigation.ts';
import type { TownState } from './state.ts';

export interface TownTravel {
    readonly town: TownState;
    readonly from: TownPoint;
    readonly target: TownPoint;
    readonly speed: number;
    readonly step: number;
}
interface TownRouteGraph {
    readonly points: readonly TownPoint[];
    readonly obstacles: readonly TownObstacle[];
}

// Visibility for the fixed stalls is reusable. Only endpoints and the rolling cart change per tick.
const staticObstacles = [...TOWN_SHOPS, TOWN_GOVERNMENT, ...TOWN_OBJECTS, TOWN_FOUNTAIN].map(expandForActor);
const staticCorners = staticObstacles.flatMap(obstacleCorners);
const staticLinks = staticCorners.map((from) => staticCorners.map((to) => clearRoute(staticObstacles, from, to)));

export function computeTownTravel(input: TownTravel): TownPoint {
    const { town, speed, step } = input;
    const from = computeTownPosition(town, input.from, { x: 0, z: 0 });
    const obstacles = getTownObstacles(town).map(expandForActor);
    const target = nearestOpenPoint(obstacles, input.target);
    const next = clearRoute(obstacles, from, target) ? target : findRouteStep({
        obstacles,
        points: [from, target, ...staticCorners, ...obstacleCorners(obstacles[obstacles.length - 1])]
    });
    const distance = Math.hypot(next.x - from.x, next.z - from.z);
    const travel = Math.min(distance, speed * step) / Math.max(0.001, distance);
    return computeTownPosition(town, from, { x: (next.x - from.x) * travel, z: (next.z - from.z) * travel });
}

function findRouteStep(graph: TownRouteGraph): TownPoint {
    const { points } = graph;
    const costs = points.map(() => Infinity);
    const previous = points.map(() => -1);
    const visited = new Set<number>();
    costs[0] = 0;
    while (visited.size < points.length) {
        let current = -1;
        let best = Infinity;
        for (let index = 0; index < points.length; index++) {
            const estimate = costs[index] + distanceBetween(points[index], points[1]);
            if (!visited.has(index) && estimate < best) {
                best = estimate;
                current = index;
            }
        }
        if (current < 0) {
            return points[0];
        }
        if (current === 1) {
            return firstRoutePoint(points, previous);
        }
        visited.add(current);
        for (let next = 0; next < points.length; next++) {
            const cost = costs[current] + distanceBetween(points[current], points[next]);
            if (visited.has(next) || cost >= costs[next] || !routeLinkClear(graph, current, next)) {
                continue;
            }
            costs[next] = cost;
            previous[next] = current;
        }
    }
    return points[0];
}

function routeLinkClear(graph: TownRouteGraph, from: number, to: number): boolean {
    if (from >= 2 && to >= 2 && from < staticCorners.length + 2 && to < staticCorners.length + 2) {
        return staticLinks[from - 2][to - 2] &&
            !crossesTownObstacle(graph.points[from], graph.points[to], graph.obstacles[graph.obstacles.length - 1]);
    }
    return clearRoute(graph.obstacles, graph.points[from], graph.points[to]);
}

function firstRoutePoint(points: readonly TownPoint[], previous: readonly number[]): TownPoint {
    let next = 1;
    while (previous[next] > 0) {
        next = previous[next];
    }
    return points[next];
}

function clearRoute(obstacles: readonly TownObstacle[], from: TownPoint, to: TownPoint): boolean {
    return !obstacles.some((obstacle) => crossesTownObstacle(from, to, obstacle));
}

function expandForActor(obstacle: TownObstacle): TownObstacle {
    // Slightly inside collision radius so an actor already touching a wall can move away.
    return { ...obstacle, width: obstacle.width + 0.74, depth: obstacle.depth + 0.74 };
}

function obstacleCorners(obstacle: TownObstacle): readonly TownPoint[] {
    return [-1, 1].flatMap((x) =>
        [-1, 1].map((z) => ({
            x: obstacle.x + x * (obstacle.width / 2 + 0.2),
            z: obstacle.z + z * (obstacle.depth / 2 + 0.2)
        }))
    );
}

function nearestOpenPoint(obstacles: readonly TownObstacle[], target: TownPoint): TownPoint {
    let point = target;
    for (const obstacle of obstacles) {
        const dx = point.x - obstacle.x;
        const dz = point.z - obstacle.z;
        const width = obstacle.width / 2 + 0.02;
        const depth = obstacle.depth / 2 + 0.02;
        if (Math.abs(dx) >= width || Math.abs(dz) >= depth) {
            continue;
        }
        point = width - Math.abs(dx) < depth - Math.abs(dz)
            ? { x: obstacle.x + (dx < 0 ? -width : width), z: point.z }
            : { x: point.x, z: obstacle.z + (dz < 0 ? -depth : depth) };
    }
    return point;
}

function distanceBetween(from: TownPoint, to: TownPoint): number {
    return Math.hypot(to.x - from.x, to.z - from.z);
}
