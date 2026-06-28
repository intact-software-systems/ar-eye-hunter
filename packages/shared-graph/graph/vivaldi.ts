import { UndirectedGraph } from 'graphology';
import { type EdgeProp, type GraphProp, type VertexProp, VertexState, VertexType } from '../graph-props.ts';
import { predictedRttMs, type VivaldiConfig, type VivaldiNodeData } from './vivaldi-core.ts';

export {
    Coordinates,
    DEFAULT_VIVALDI_CONFIG,
    predictedRttMs,
    VivaldiNode,
} from './vivaldi-core.ts';

export type {
    VivaldiConfig,
    VivaldiNodeData,
} from './vivaldi-core.ts';

export function upsertPredictedVertex(
    graph: UndirectedGraph<VertexProp, EdgeProp, GraphProp>,
    vertexId: string,
    graphProp: GraphProp,
): void {
    if (graph.hasNode(vertexId)) {
        return;
    }

    const vertex: VertexProp = {
        id: vertexId,
        type: VertexType.CLIENT,
        state: VertexState.MEMBER,
        degreeLimit: graphProp.degreeLimitMember,
    };

    graph.addNode(vertexId, vertex);
}

export function upsertPredictedEdge(
    graph: UndirectedGraph<VertexProp, EdgeProp, GraphProp>,
    fromId: string,
    toId: string,
    weight: number,
): void {
    const edgeProp: EdgeProp = {
        from: fromId,
        to: toId,
        weight,
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
    cfg?: Partial<VivaldiConfig>,
): UndirectedGraph<VertexProp, EdgeProp, GraphProp> {
    const graph = new UndirectedGraph<VertexProp, EdgeProp, GraphProp>();
    graph.replaceAttributes(graphProp);

    const nodes = [...nodeDataById.values()];

    for (const node of nodes) {
        upsertPredictedVertex(graph, node.id, graphProp);
    }

    for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
            const source = nodes[i];
            const target = nodes[j];
            const weight = predictedRttMs(source, target, cfg);
            upsertPredictedEdge(graph, source.id, target.id, weight);
        }
    }

    return graph;
}
