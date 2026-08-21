import { UndirectedGraph } from 'graphology';
import {
    compareVertexIds,
    VertexState,
    VertexType,
    type EdgeProp,
    type GraphProp,
    type VertexProp
} from '../graph-props.ts';
import { selectDegreeCappedEdges } from './select-degree-capped-edges.ts';
import {
    computePredictedRttMs,
    DEFAULT_VIVALDI_CONFIG,
    type VivaldiConfig,
    type VivaldiNodeData
} from './vivaldi-core.ts';

export {
    Coordinates,
    DEFAULT_VIVALDI_CONFIG,
    predictedRttMs,
    VivaldiNode
} from './vivaldi-core.ts';

export type { VivaldiConfig, VivaldiNodeData } from './vivaldi-core.ts';

export function upsertPredictedVertex(
    graph: UndirectedGraph<VertexProp, EdgeProp, GraphProp>,
    vertexId: string,
    graphProp: GraphProp
): void {
    if (graph.hasNode(vertexId)) {
        return;
    }

    const vertex: VertexProp = {
        id: vertexId,
        type: VertexType.CLIENT,
        state: VertexState.MEMBER,
        degreeLimit: graphProp.degreeLimitMember
    };

    graph.addNode(vertexId, vertex);
}

export function upsertPredictedEdge(
    graph: UndirectedGraph<VertexProp, EdgeProp, GraphProp>,
    fromId: string,
    toId: string,
    weight: number
): void {
    const edgeProp: EdgeProp = {
        from: fromId,
        to: toId,
        weight
    };

    if (graph.hasEdge(fromId, toId)) {
        const edgeKey = graph.edge(fromId, toId);
        if (edgeKey !== undefined) {
            graph.replaceEdgeAttributes(edgeKey, edgeProp);
        }
        return;
    }

    graph.addEdge(fromId, toId, edgeProp);
}

export function createPredictedGraph(
    nodeDataById: ReadonlyMap<string, VivaldiNodeData>,
    graphProp: GraphProp,
    cfg?: Partial<VivaldiConfig>
): UndirectedGraph<VertexProp, EdgeProp, GraphProp> {
    const graph = new UndirectedGraph<VertexProp, EdgeProp, GraphProp>();
    graph.replaceAttributes(graphProp);

    const nodes = [...nodeDataById.values()];

    for (const node of nodes) {
        upsertPredictedVertex(graph, node.id, graphProp);
    }

    const mergedCfg = { ...DEFAULT_VIVALDI_CONFIG, ...cfg };
    for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
            const source = nodes[i];
            const target = nodes[j];
            const weight = computePredictedRttMs(source, target, mergedCfg);
            upsertPredictedEdge(graph, source.id, target.id, weight);
        }
    }

    return graph;
}

export function createDegreeCappedPredictedGraph(
    nodeDataById: ReadonlyMap<string, VivaldiNodeData>,
    graphProp: GraphProp,
    options: Readonly<{ degreeLimit: number; }> & Partial<VivaldiConfig>
): UndirectedGraph<VertexProp, EdgeProp, GraphProp> {
    const graph = new UndirectedGraph<VertexProp, EdgeProp, GraphProp>();
    graph.replaceAttributes(graphProp);

    // Canonical id order, never map-insertion order: the same member set has to
    // produce the same graph on every server, and equal predicted weights are
    // common enough (co-located or collinear coordinates) that the tie-break
    // decides real edges. Sorting here also lets the selection tie-break on
    // node indices instead of comparing ids per candidate.
    //
    // compareVertexIds and not localeCompare: collation depends on the runtime's
    // default locale and ICU data, so servers configured differently could order
    // the same ids differently, which is exactly the divergence this ordering
    // exists to remove.
    const nodes = [...nodeDataById.values()].sort((left, right) => compareVertexIds(left.id, right.id));
    const degreeLimit = Number.isInteger(options.degreeLimit) && options.degreeLimit > 0
        ? options.degreeLimit
        : graphProp.degreeLimitMember;

    for (const node of nodes) {
        upsertPredictedVertex(graph, node.id, graphProp);
    }

    const mergedCfg = { ...DEFAULT_VIVALDI_CONFIG, ...options };
    const selected = selectDegreeCappedEdges({
        nodeCount: nodes.length,
        degreeLimit,
        computeWeight: (sourceIndex, targetIndex) =>
            computePredictedRttMs(nodes[sourceIndex], nodes[targetIndex], mergedCfg)
    });

    for (const edge of selected) {
        upsertPredictedEdge(graph, nodes[edge.sourceIndex].id, nodes[edge.targetIndex].id, edge.weight);
    }

    return graph;
}
