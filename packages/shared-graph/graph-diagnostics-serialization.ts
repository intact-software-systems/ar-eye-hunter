import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import type {
    SerializedGraphInfo,
    SerializedGraphInfoSnapshot,
    SerializedWeightedGraph,
    SerializedWeightedGraphEdge,
    SerializedWeightedGraphNode
} from '@shared/api/graph-topology-management-types.ts';
import type { EdgeProp, VertexProp, WeightedGraph } from './graph-props.ts';
import type { GraphInfo, GraphInfoSnapshot } from './shared-graph-types.ts';

type WeightedGraphExport = ReturnType<WeightedGraph['export']>;

export function serializeGraphInfo(info: GraphInfo): SerializedGraphInfo {
    return {
        groupRef: info.groupRef,
        graph: toSerializedWeightedGraph(info.graph.export()),
        groupGraph: toSerializedWeightedGraph(info.groupGraph.export()),
        coreNodes: info.coreNodes
    };
}

export function serializeGraphInfoSnapshot(
    snapshot: GraphInfoSnapshot
): SerializedGraphInfoSnapshot {
    return {
        groupRef: snapshot.groupRef,
        measured: snapshot.measured
            ? serializeGraphInfo(snapshot.measured)
            : undefined,
        predicted: serializeGraphInfo(snapshot.predicted),
        createdAtEpochMs: snapshot.createdAtEpochMs,
        version: snapshot.version
    };
}

function toSerializedWeightedGraph(exported: WeightedGraphExport): SerializedWeightedGraph {
    return {
        options: { ...exported.options },
        attributes: { ...exported.attributes },
        nodes: exported.nodes.map(toSerializedNode),
        edges: exported.edges.map(toSerializedEdge)
    };
}

function toSerializedNode(node: WeightedGraphExport['nodes'][number]): SerializedWeightedGraphNode {
    return {
        key: node.key,
        ...toOptionalAttributes(node.attributes)
    };
}

function toSerializedEdge(edge: WeightedGraphExport['edges'][number]): SerializedWeightedGraphEdge {
    return {
        ...(edge.key === undefined ? {} : { key: edge.key }),
        source: edge.source,
        target: edge.target,
        ...toOptionalAttributes(edge.attributes),
        ...(edge.undirected === undefined ? {} : { undirected: edge.undirected })
    };
}

function toOptionalAttributes(
    attributes: VertexProp | EdgeProp | undefined
): Readonly<{ attributes?: ApiJsonObject; }> {
    return attributes === undefined ? {} : { attributes: { ...attributes } };
}
