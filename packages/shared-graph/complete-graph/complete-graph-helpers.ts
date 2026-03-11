import { UndirectedGraph } from 'graphology';
import { EdgeProp, GraphProp, TreeGraph, VertexId, VertexProp, VertexState, VertexType } from '../graph-props.ts';

export function makeEmptyGraphLike(reference: TreeGraph): TreeGraph {
    const graph = new UndirectedGraph<VertexProp, EdgeProp, GraphProp>();
    graph.replaceAttributes(reference.getAttributes());
    return graph;
}

export function addMemberVertex(
    graph: TreeGraph,
    globalGraph: TreeGraph,
    vertexId: VertexId,
): void {
    if (graph.hasNode(vertexId)) return;

    const attrs = globalGraph.getNodeAttributes(vertexId);
    graph.addNode(vertexId, {
        ...attrs,
        type: VertexType.CLIENT,
        state: VertexState.MEMBER,
        degreeLimit: graph.getAttributes().degreeLimitMember,
    });
}

export function addSteinerVertex(
    graph: TreeGraph,
    globalGraph: TreeGraph,
    vertexId: VertexId,
): void {
    if (graph.hasNode(vertexId)) return;

    const attrs = globalGraph.getNodeAttributes(vertexId);
    graph.addNode(vertexId, {
        ...attrs,
        type: VertexType.CORE,
        state: VertexState.STEINER,
        degreeLimit: graph.getAttributes().degreeLimitSteiner,
    });
}

export function makeMember(graph: TreeGraph, vertexId: VertexId): void {
    const attrs = graph.getNodeAttributes(vertexId);
    graph.replaceNodeAttributes(vertexId, {
        ...attrs,
        type: VertexType.CLIENT,
        state: VertexState.MEMBER,
        degreeLimit: graph.getAttributes().degreeLimitMember,
    });
}

export function makeSteinerAvailable(graph: TreeGraph, vertexId: VertexId): void {
    const attrs = graph.getNodeAttributes(vertexId);
    graph.replaceNodeAttributes(vertexId, {
        ...attrs,
        type: VertexType.CORE,
        state: VertexState.STEINER,
        degreeLimit: graph.getAttributes().degreeLimitSteiner,
    });
}

export function insertEdgeFromGlobal(
    graph: TreeGraph,
    globalGraph: TreeGraph,
    a: VertexId,
    b: VertexId,
): void {
    if (a === b) return;
    if (graph.hasEdge(a, b)) return;

    const edgeKey = globalGraph.edge(a, b);
    if (edgeKey === undefined) {
        throw new Error(`Missing edge (${a}, ${b}) in global graph`);
    }

    graph.addEdge(a, b, {
        from: a,
        to: b,
        weight: globalGraph.getEdgeAttribute(edgeKey, 'weight') as number,
    });
}