import { TreeGraph, VertexId, VertexState } from '../graph-props.ts';

export type OptimizedNeighborSets = {
    adjacentMembers: Set<VertexId>;
    adjacentSteiner: Set<VertexId>;
    removableEdgeKeys: Set<string>;
};

/**
 * Functional approximation of getNeighborsOptimizeSP(...)
 *
 * Starting from src, traverse through Steiner vertices and collect:
 * - reachable member vertices as adjacentMembers
 * - traversed Steiner/core vertices as adjacentSteiner
 * - traversed edges as removableEdgeKeys
 *
 * This mirrors how rvTryReplace() uses the result:
 * it wants the member frontier, adjacent steiner points, and the
 * edges to temporarily remove before reconnecting.
 */
export function getNeighborsOptimizeSP(
    groupGraph: TreeGraph,
    src: VertexId,
): OptimizedNeighborSets {
    const adjacentMembers = new Set<VertexId>();
    const adjacentSteiner = new Set<VertexId>();
    const removableEdgeKeys = new Set<string>();
    const visited = new Set<VertexId>();

    if (groupGraph.hasNode(src)) {
        const attrs = groupGraph.getNodeAttributes(src);
        if (attrs.state === VertexState.MEMBER) {
            adjacentMembers.add(src);
        }
    }

    visited.add(src);

    for (const neighbor of groupGraph.neighbors(src) as VertexId[]) {
        walk(groupGraph, src, neighbor, visited, adjacentMembers, adjacentSteiner, removableEdgeKeys);
    }

    return {
        adjacentMembers,
        adjacentSteiner,
        removableEdgeKeys,
    };
}

function walk(
    graph: TreeGraph,
    prev: VertexId,
    current: VertexId,
    visited: Set<VertexId>,
    adjacentMembers: Set<VertexId>,
    adjacentSteiner: Set<VertexId>,
    removableEdgeKeys: Set<string>,
): void {
    if (visited.has(current)) {
        return;
    }

    const edgeKey = graph.edge(prev, current);
    if (edgeKey !== undefined) {
        removableEdgeKeys.add(edgeKey);
    }

    visited.add(current);

    const attrs = graph.getNodeAttributes(current);

    if (attrs.state === VertexState.STEINER) {
        adjacentSteiner.add(current);

        for (const next of graph.neighbors(current) as VertexId[]) {
            if (next === prev) continue;
            walk(graph, current, next, visited, adjacentMembers, adjacentSteiner, removableEdgeKeys);
        }

        return;
    }

    adjacentMembers.add(current);
}