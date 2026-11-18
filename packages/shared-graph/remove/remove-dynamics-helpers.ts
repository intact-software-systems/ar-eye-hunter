import { VertexId, VertexState, WeightedGraph } from '../graph-props.ts';
import { cloneGraph } from '../graph/graph-algs.ts';

export function neighborsOf(graph: WeightedGraph, node: VertexId): VertexId[] {
    return graph.neighbors(node) as VertexId[];
}

export function degreeOf(graph: WeightedGraph, node: VertexId): number {
    return graph.degree(node);
}

export function degreeLimitOf(graph: WeightedGraph, node: VertexId): number {
    return graph.getNodeAttributes(node).degreeLimit;
}

export function edgeWeightOf(graph: WeightedGraph, a: VertexId, b: VertexId): number {
    const edgeKey = graph.edge(a, b);
    if (edgeKey === undefined) {
        throw new Error(`Missing edge between ${a} and ${b}`);
    }
    return graph.getEdgeAttribute(edgeKey, 'weight') as number;
}

export function withUnusedSteinerRemoved(graph: WeightedGraph): WeightedGraph {
    const next = cloneGraph(graph);

    let changed = true;
    while (changed) {
        changed = false;

        for (const node of [...next.nodes()] as VertexId[]) {
            const attrs = next.getNodeAttributes(node);
            if (attrs.state !== VertexState.STEINER) {
                continue;
            }

            if (next.degree(node) <= 1) {
                next.dropNode(node);
                changed = true;
            }
        }
    }

    return next;
}
