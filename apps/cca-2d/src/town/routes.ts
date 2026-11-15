import { TOWN_BUILDINGS, TOWN_FURNITURE } from './layout/map.ts';
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
    crossesTownObstacle
} from './navigation.ts';
import { TOWN_PERSONALITIES } from './personalities/state.ts';
import { TOWN_BARBECUE, TOWN_UMBRELLA } from './spectacles/state.ts';
import type { TownState } from './state.ts';

const staticObstacles = [
    ...TOWN_SHOPS,
    TOWN_GOVERNMENT,
    ...TOWN_OBJECTS,
    TOWN_BARBECUE,
    TOWN_UMBRELLA,
    ...TOWN_BUILDINGS,
    ...TOWN_FURNITURE,
    ...TOWN_PERSONALITIES.map((resident) => resident.prop),
    TOWN_FOUNTAIN
].map(expandForActor);
const staticCorners = staticObstacles.flatMap(obstacleCorners);
const staticLinks = staticCorners.map((from) =>
    staticCorners.map((to) => clearRoute(staticObstacles, from, to) ? distanceBetween(from, to) : Infinity)
);
export namespace TownRoutes {
    export interface Travel {
        readonly town: TownState;
        readonly from: TownPoint;
        readonly target: TownPoint;
        readonly speed: number;
        readonly step: number;
    }
    export interface Graph {
        readonly points: readonly TownPoint[];
        readonly obstacles: readonly TownObstacle[];
        readonly links: readonly (readonly number[])[];
        readonly distances: Map<string, readonly number[]>;
    }
}
export class TownRoutes {
    // Exact geometry/target memoization belongs to one app lifetime, never match state.
    // At most one cart layout and 128 destinations are retained.
    private cachedGraph: TownRoutes.Graph | undefined;

    clear(): void {
        this.cachedGraph = undefined;
    }

    travel(input: TownRoutes.Travel): TownPoint {
        const { town, speed, step } = input;
        const from = computeTownPosition(town, input.from, { x: 0, z: 0 });
        const graph = this.resolveGraph(town);
        const target = nearestOpenPoint(graph.obstacles, input.target);
        const next = clearRoute(graph.obstacles, from, target) ? target : this.findRouteStep({ graph, from, target });
        const distance = distanceBetween(from, next);
        const travel = Math.min(distance, speed * step) / Math.max(0.001, distance);
        return computeTownPosition(town, from, { x: (next.x - from.x) * travel, z: (next.z - from.z) * travel });
    }

    private resolveGraph(town: TownState): TownRoutes.Graph {
        const cart = expandForActor({ x: town.cart.x, z: town.cart.z, width: 1.7, depth: 1.3 });
        const previousCart = this.cachedGraph?.obstacles.at(-1);
        if (this.cachedGraph && previousCart?.x === cart.x && previousCart.z === cart.z) {
            return this.cachedGraph;
        }
        const obstacles = [...staticObstacles, cart];
        const points = [...staticCorners, ...obstacleCorners(cart)];
        const links = points.map((from, row) =>
            points.map((to, column) => {
                if (row < staticCorners.length && column < staticCorners.length) {
                    return crossesTownObstacle(from, to, cart) ? Infinity : staticLinks[row][column];
                }
                return clearRoute(obstacles, from, to) ? distanceBetween(from, to) : Infinity;
            })
        );
        this.cachedGraph = { points, obstacles, links, distances: new Map() };
        return this.cachedGraph;
    }

    private findRouteStep(input: { graph: TownRoutes.Graph; from: TownPoint; target: TownPoint; }): TownPoint {
        const { graph, from, target } = input;
        const costs = this.resolveDestinationCosts(graph, target);
        let best = Infinity;
        let next = from;
        graph.points.forEach((point, index) => {
            const distance = distanceBetween(from, point);
            if (distance < 0.08) {
                return;
            }
            const cost = distance + costs[index];
            if (cost < best && clearRoute(graph.obstacles, from, point)) {
                best = cost;
                next = point;
            }
        });
        return next;
    }

    private resolveDestinationCosts(graph: TownRoutes.Graph, target: TownPoint): readonly number[] {
        const key = `${target.x},${target.z}`;
        const saved = graph.distances.get(key);
        if (saved) {
            return saved;
        }
        const costs = graph.points.map((point) =>
            clearRoute(graph.obstacles, point, target) ? distanceBetween(point, target) : Infinity
        );
        const visited = new Set<number>();
        while (visited.size < graph.points.length) {
            let current = -1;
            let best = Infinity;
            for (let index = 0; index < costs.length; index++) {
                if (!visited.has(index) && costs[index] < best) {
                    current = index;
                    best = costs[index];
                }
            }
            if (current < 0) {
                break;
            }
            visited.add(current);
            for (let next = 0; next < costs.length; next++) {
                if (!visited.has(next)) {
                    costs[next] = Math.min(costs[next], best + graph.links[current][next]);
                }
            }
        }
        if (graph.distances.size >= 128) {
            graph.distances.clear();
        }
        graph.distances.set(key, costs);
        return costs;
    }
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
