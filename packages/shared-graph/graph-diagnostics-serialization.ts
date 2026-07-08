import type {
    SerializedGraphInfo,
    SerializedGraphInfoSnapshot,
    SerializedWeightedGraph,
} from '@shared/api/graph-topology-management-types.ts';
import type { GraphInfo, GraphInfoSnapshot } from './shared-graph-types.ts';

export function serializeGraphInfo(info: GraphInfo): SerializedGraphInfo {
    return {
        groupRef: info.groupRef,
        graph: info.graph.export() as SerializedWeightedGraph,
        groupGraph: info.groupGraph.export() as SerializedWeightedGraph,
        coreNodes: info.coreNodes,
    };
}

export function serializeGraphInfoSnapshot(
    snapshot: GraphInfoSnapshot,
): SerializedGraphInfoSnapshot {
    return {
        groupRef: snapshot.groupRef,
        measured: snapshot.measured
            ? serializeGraphInfo(snapshot.measured)
            : undefined,
        predicted: serializeGraphInfo(snapshot.predicted),
        createdAtEpochMs: snapshot.createdAtEpochMs,
        version: snapshot.version,
    };
}
