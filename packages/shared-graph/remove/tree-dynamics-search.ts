import { degreeLimitOf, degreeOf, edgeWeightOf, neighborsOf, } from './remove-dynamics-helpers.ts';
import type { DiameterCandidate, EdgeCandidate } from './tree-dynamics-connect-types.ts';
import { cloneGraph } from '../graph/graph-algs.ts';
import { compareVertexIds, TreeGraph, VertexId } from '../graph-props.ts';

export function findMCEdge(
    globalGraph: TreeGraph,
    treeGraph: TreeGraph,
    source: VertexId,
    targetRoot: VertexId,
): EdgeCandidate | undefined {
    const visited = new Set<VertexId>();
    const queue: VertexId[] = [targetRoot];
    visited.add(targetRoot);

    let best: EdgeCandidate | undefined;

    while (queue.length > 0) {
        const current = queue.shift()!;

        if (current !== source && canAcceptAnotherEdge(treeGraph, globalGraph, current)) {
            if (hasRequiredGlobalEdge(globalGraph, source, current)) {
                const weight = edgeWeightOf(globalGraph, source, current);
                if (
                    best === undefined ||
                    weight < best.weight ||
                    (weight === best.weight && compareVertexIds(current, best.to) < 0)
                ) {
                    best = {
                        from: source,
                        to: current,
                        weight,
                    };
                }
            }
        }

        for (const neighbor of neighborsOf(treeGraph, current)) {
            if (!visited.has(neighbor)) {
                visited.add(neighbor);
                queue.push(neighbor);
            }
        }
    }

    return best;
}

export function findMDEdge(
    globalGraph: TreeGraph,
    treeGraph: TreeGraph,
    source: VertexId,
    targetRoot: VertexId,
    sourceEccentricity: number,
): DiameterCandidate | undefined {
    const visited = new Set<VertexId>();
    const queue: VertexId[] = [targetRoot];
    visited.add(targetRoot);

    let best: DiameterCandidate | undefined;

    while (queue.length > 0) {
        const current = queue.shift()!;

        if (current !== source && canAcceptAnotherEdge(treeGraph, globalGraph, current)) {
            if (hasRequiredGlobalEdge(globalGraph, source, current)) {
                const linkWeight = edgeWeightOf(globalGraph, source, current);
                const targetEccentricity = worstCaseDist(treeGraph, current);
                const newDiameter = Math.max(
                    sourceEccentricity,
                    linkWeight + targetEccentricity,
                );

                if (
                    best === undefined ||
                    newDiameter < best.diameter ||
                    (newDiameter === best.diameter && compareVertexIds(current, best.to) < 0)
                ) {
                    best = {
                        from: source,
                        to: current,
                        diameter: newDiameter,
                    };
                }
            }
        }

        for (const neighbor of neighborsOf(treeGraph, current)) {
            if (!visited.has(neighbor)) {
                visited.add(neighbor);
                queue.push(neighbor);
            }
        }
    }

    return best;
}

export function worstCaseDist(
    graph: TreeGraph,
    source: VertexId,
): number {
    const distances = dijkstraDistances(graph, source);
    let maxDistance = 0;

    for (const d of distances.values()) {
        if (Number.isFinite(d) && d > maxDistance) {
            maxDistance = d;
        }
    }

    return maxDistance;
}

export function dijkstraDistances(
    graph: TreeGraph,
    source: VertexId,
): Map<VertexId, number> {
    const nodes = graph.nodes() as VertexId[];
    const distances = new Map<VertexId, number>();
    const visited = new Set<VertexId>();

    for (const node of nodes) {
        distances.set(node, Number.POSITIVE_INFINITY);
    }
    distances.set(source, 0);

    while (visited.size < nodes.length) {
        let current: VertexId | undefined;
        let best = Number.POSITIVE_INFINITY;

        for (const node of nodes) {
            if (visited.has(node)) continue;
            const d = distances.get(node) ?? Number.POSITIVE_INFINITY;
            if (d < best) {
                best = d;
                current = node;
            }
        }

        if (current === undefined || !Number.isFinite(best)) {
            break;
        }

        visited.add(current);

        for (const neighbor of neighborsOf(graph, current)) {
            if (visited.has(neighbor)) continue;

            const alt = best + edgeWeightOf(graph, current, neighbor);
            const prev = distances.get(neighbor) ?? Number.POSITIVE_INFINITY;

            if (alt < prev) {
                distances.set(neighbor, alt);
            }
        }
    }

    return distances;
}

export function withInsertedEdge(
    graph: TreeGraph,
    globalGraph: TreeGraph,
    a: VertexId,
    b: VertexId,
): TreeGraph {
    const next = cloneGraph(graph);

    if (!next.hasEdge(a, b)) {
        next.addEdge(a, b, {
            from: a,
            to: b,
            weight: edgeWeightOf(globalGraph, a, b),
        });
    }

    return next;
}

export function canAcceptAnotherEdge(
    graph: TreeGraph,
    globalGraph: TreeGraph,
    node: VertexId,
): boolean {
    return degreeOf(graph, node) < degreeLimitOf(globalGraph, node);
}

export function hasRequiredGlobalEdge(
    globalGraph: TreeGraph,
    a: VertexId,
    b: VertexId,
): boolean {
    return globalGraph.hasEdge(a, b);
}