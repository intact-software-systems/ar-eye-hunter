import { describe, expect, it } from 'vitest';
import { UndirectedGraph } from 'graphology';
import { serializeGraphInfoSnapshot } from '@shared-graph/graph-diagnostics-serialization.ts';
import type { GraphInfo, GraphInfoSnapshot, } from '@shared-graph/shared-graph-types.ts';
import type { EdgeProp, GraphProp, VertexProp, WeightedGraph, } from '@shared-graph/graph/graph-props.ts';
import { VertexState } from '@shared-graph/graph/graph-props.ts';
import { createGraph } from './helpers.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

type SerializedWeightedGraph = ReturnType<WeightedGraph['export']>;

type SerializedGraphInfo = Omit<GraphInfo, 'graph' | 'groupGraph'> & Readonly<{
    graph: SerializedWeightedGraph;
    groupGraph: SerializedWeightedGraph;
}>;

type SerializedGraphInfoSnapshot =
    Omit<GraphInfoSnapshot, 'predicted' | 'measured'> & Readonly<{
    predicted: SerializedGraphInfo;
    measured?: SerializedGraphInfo;
}>;

describe('graphology JSON serialization', () => {
    it('round-trips graph snapshots through JSON using graphology import/export', () => {
        const predictedGraph = createGraph([
            ['peer-a', VertexState.MEMBER, 4],
            ['peer-b', VertexState.MEMBER, 4],
            ['peer-c', VertexState.MEMBER, 4],
        ], [
            ['peer-a', 'peer-b', 2],
            ['peer-b', 'peer-c', 3],
            ['peer-a', 'peer-c', 5],
        ]);
        const predictedTree = createGraph([
            ['peer-a', VertexState.MEMBER, 4],
            ['peer-b', VertexState.MEMBER, 4],
            ['peer-c', VertexState.MEMBER, 4],
        ], [
            ['peer-a', 'peer-b', 2],
            ['peer-b', 'peer-c', 3],
        ]);
        const measuredGraph = createGraph([
            ['peer-a', VertexState.MEMBER, 4],
            ['peer-b', VertexState.MEMBER, 4],
        ], [
            ['peer-a', 'peer-b', 7],
        ]);
        const measuredTree = createGraph([
            ['peer-a', VertexState.MEMBER, 4],
            ['peer-b', VertexState.MEMBER, 4],
        ], [
            ['peer-a', 'peer-b', 7],
        ]);

        const groupRef = createGroupRef('group-1');
        const snapshot: GraphInfoSnapshot = {
            groupRef,
            predicted: {
                groupRef,
                graph: predictedGraph,
                groupGraph: predictedTree,
                coreNodes: ['peer-b'],
            },
            measured: {
                groupRef,
                graph: measuredGraph,
                groupGraph: measuredTree,
                coreNodes: ['peer-a'],
            },
            createdAtEpochMs: 123,
            version: 4,
        };

        const parsed = JSON.parse(
            JSON.stringify(snapshot),
        ) as SerializedGraphInfoSnapshot;

        expect(parsed.predicted.graph).toEqual(predictedGraph.export());
        expect(parsed.predicted.groupGraph).toEqual(predictedTree.export());
        expect(parsed.measured?.graph).toEqual(measuredGraph.export());
        expect(parsed.measured?.groupGraph).toEqual(measuredTree.export());

        const restored = restoreGraphSnapshot(parsed);

        expect(restored).toEqual(snapshot);
        expect(restored.predicted.graph.neighbors('peer-b').sort()).toEqual([
            'peer-a',
            'peer-c',
        ]);
        expect(restored.predicted.groupGraph.neighbors('peer-b').sort()).toEqual([
            'peer-a',
            'peer-c',
        ]);
        expect(restored.measured?.graph.getEdgeAttribute(
            restored.measured.graph.edge('peer-a', 'peer-b')!,
            'weight',
        )).toBe(7);
    });

    it('serializes graph snapshots through the shared diagnostic DTO helper', () => {
        const predictedGraph = createGraph([
            ['peer-a', VertexState.MEMBER, 4],
            ['peer-b', VertexState.MEMBER, 4],
        ], [
            ['peer-a', 'peer-b', 2],
        ]);
        const predictedTree = createGraph([
            ['peer-a', VertexState.MEMBER, 4],
            ['peer-b', VertexState.MEMBER, 4],
        ], [
            ['peer-a', 'peer-b', 2],
        ]);
        const measuredGraph = createGraph([
            ['peer-a', VertexState.MEMBER, 4],
            ['peer-b', VertexState.MEMBER, 4],
        ], [
            ['peer-a', 'peer-b', 7],
        ]);
        const measuredTree = createGraph([
            ['peer-a', VertexState.MEMBER, 4],
            ['peer-b', VertexState.MEMBER, 4],
        ], [
            ['peer-a', 'peer-b', 7],
        ]);
        const groupRef = createGroupRef('group-2');
        const snapshot: GraphInfoSnapshot = {
            groupRef,
            predicted: {
                groupRef,
                graph: predictedGraph,
                groupGraph: predictedTree,
                coreNodes: ['peer-a'],
            },
            measured: {
                groupRef,
                graph: measuredGraph,
                groupGraph: measuredTree,
                coreNodes: ['peer-b'],
            },
            createdAtEpochMs: 456,
            version: 8,
        };

        const serialized = serializeGraphInfoSnapshot(snapshot);

        expect(serialized.predicted.graph).toEqual(predictedGraph.export());
        expect(serialized.predicted.groupGraph).toEqual(predictedTree.export());
        expect(serialized.measured?.graph).toEqual(measuredGraph.export());
        expect(serialized.measured?.groupGraph).toEqual(measuredTree.export());
        expect('graphId' in serialized).toBe(false);
        expect(serialized.groupRef).toEqual(groupRef);
    });
});

function restoreGraphSnapshot(
    snapshot: SerializedGraphInfoSnapshot,
): GraphInfoSnapshot {
    return {
        groupRef: snapshot.groupRef,
        predicted: restoreGraphInfo(snapshot.predicted),
        measured: snapshot.measured
            ? restoreGraphInfo(snapshot.measured)
            : undefined,
        createdAtEpochMs: snapshot.createdAtEpochMs,
        version: snapshot.version,
    };
}

function restoreGraphInfo(
    info: SerializedGraphInfo,
): GraphInfo {
    return {
        groupRef: info.groupRef,
        graph: restoreGraph(info.graph),
        groupGraph: restoreGraph(info.groupGraph),
        coreNodes: [...info.coreNodes],
    };
}

function restoreGraph(
    serialized: SerializedWeightedGraph,
): WeightedGraph {
    const graph = new UndirectedGraph<VertexProp, EdgeProp, GraphProp>();
    graph.import(serialized);
    return graph as WeightedGraph;
}

function createGroupRef(groupId: string): GroupRef {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId,
    };
}
