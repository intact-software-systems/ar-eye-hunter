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

export function hasEdgeBetween(graph: WeightedGraph, a: VertexId, b: VertexId): boolean {
    return graph.hasEdge(a, b);
}

export function edgeWeightOf(graph: WeightedGraph, a: VertexId, b: VertexId): number {
    const edgeKey = graph.edge(a, b);
    if (edgeKey === undefined) {
        throw new Error(`Missing edge between ${a} and ${b}`);
    }
    return graph.getEdgeAttribute(edgeKey, 'weight') as number;
}

export function withRemovedVertex(graph: WeightedGraph, node: VertexId): WeightedGraph {
    const next = cloneGraph(graph);
    if (next.hasNode(node)) {
        next.dropNode(node);
    }
    return next;
}

export function withInsertedEdgeFromGlobal(
    graph: WeightedGraph,
    globalGraph: WeightedGraph,
    a: VertexId,
    b: VertexId
): WeightedGraph {
    const next = cloneGraph(graph);

    if (!next.hasNode(a)) {
        next.addNode(a, { ...globalGraph.getNodeAttributes(a) });
    }
    if (!next.hasNode(b)) {
        next.addNode(b, { ...globalGraph.getNodeAttributes(b) });
    }

    if (!next.hasEdge(a, b)) {
        next.addEdge(a, b, {
            from: a,
            to: b,
            weight: edgeWeightOf(globalGraph, a, b)
        });
    }

    return next;
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
