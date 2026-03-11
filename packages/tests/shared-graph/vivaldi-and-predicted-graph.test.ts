import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_GRAPH_PROP } from '@shared-graph/algo-props.ts';
import {
    createPredictedGraph,
    predictedRttMs,
    upsertPredictedEdge,
    VivaldiNode,
    type VivaldiNodeData,
} from '@shared-graph/graph/vivaldi.ts';
import {
    clearAllNodes,
    getAllNodeData,
    getAllNodeIds,
    getNodeDataById,
    getOrCreateNode,
    hasNode,
} from '@shared-graph/repository/vivaldi-repository.ts';
import {
    observeRtt,
    readablePredictedNodeData,
    toPredictedGraphFromIds,
    toPredictedGraphSnapshot,
} from '@shared-graph/vivaldi-service.ts';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';

describe('shared-graph vivaldi and predicted graph behavior', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
        clearAllNodes();
        vi.restoreAllMocks();
    });

    it('stores vivaldi nodes once and exposes filtered node data', () => {
        const first = getOrCreateNode('peer-a', 3, 0.4);
        const second = getOrCreateNode('peer-a', 5, 0.9);
        const other = getOrCreateNode('peer-b', 3, 0.2);

        expect(first).toBe(second);
        expect(first).not.toBe(other);
        expect(hasNode('peer-a')).toBe(true);
        expect(getAllNodeIds().sort()).toEqual(['peer-a', 'peer-b']);

        const selected = getNodeDataById(['peer-b', 'missing']);
        expect([...selected.keys()]).toEqual(['peer-b']);
        expect(getAllNodeData().size).toBe(2);
    });

    it('builds predicted graphs from explicit node data and replaces edge weights on upsert', () => {
        const nodeDataById = new Map<string, VivaldiNodeData>([
            [
                'peer-a',
                { id: 'peer-a', coords: [0, 0], err: 0.1, rttMs: 0 },
            ],
            [
                'peer-b',
                { id: 'peer-b', coords: [3, 4], err: 0.1, rttMs: 0 },
            ],
            [
                'peer-c',
                { id: 'peer-c', coords: [6, 8], err: 0.1, rttMs: 0 },
            ],
        ]);

        const graph = createPredictedGraph(nodeDataById, DEFAULT_GRAPH_PROP);

        expect(predictedRttMs(nodeDataById.get('peer-a')!, nodeDataById.get('peer-b')!)).toBe(5);
        expect(graph.order).toBe(3);
        expect(graph.size).toBe(3);
        expect(graph.getAttributes()).toEqual(DEFAULT_GRAPH_PROP);

        upsertPredictedEdge(graph, 'peer-a', 'peer-b', 9);

        const edgeKey = graph.edge('peer-a', 'peer-b');
        expect(edgeKey).toBeDefined();
        expect(graph.getEdgeAttributes(edgeKey!)).toEqual({
            from: 'peer-a',
            to: 'peer-b',
            weight: 9,
        });
    });

    it('observes RTT measurements into the repository and ignores invalid inputs', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.75);

        expect(
            observeRtt({
                sessionIdFrom: 'peer-a',
                sessionIdTo: 'peer-b',
                rttMs: 25,
                createdAtEpochMs: 1,
                version: 1,
            }),
        ).toBe(true);
        expect(
            observeRtt({
                sessionIdFrom: 'peer-a',
                sessionIdTo: 'peer-c',
                rttMs: 0,
                createdAtEpochMs: 2,
                version: 2,
            }),
        ).toBe(false);

        const readable = readablePredictedNodeData();
        expect([...readable.keys()].sort()).toEqual(['peer-a', 'peer-b']);

        const graphFromIds = toPredictedGraphFromIds(
            ['peer-a', 'peer-b', 'missing'],
            DEFAULT_GRAPH_PROP,
        );
        const fullGraph = toPredictedGraphSnapshot(DEFAULT_GRAPH_PROP);

        expect(graphFromIds.order).toBe(2);
        expect(graphFromIds.size).toBe(1);
        expect(fullGraph.order).toBe(2);
        expect(fullGraph.size).toBe(1);

        const edgeKey = graphFromIds.edge('peer-a', 'peer-b');
        expect(edgeKey).toBeDefined();
        expect(graphFromIds.getEdgeAttribute(edgeKey!, 'weight')).toSatisfy(
            (weight: number) => Number.isFinite(weight) && weight > 0,
        );
    });

    it('ignores invalid remote data during direct Vivaldi node updates', () => {
        const node = new VivaldiNode(2, 0.5);
        const before = node.toNodeData('peer-a');

        node.update({
            id: 'peer-b',
            coords: [Number.NaN, 1],
            err: 0.4,
            rttMs: 20,
        });
        node.update({
            id: 'peer-b',
            coords: [1, 1],
            err: 0.4,
            rttMs: -1,
        });

        expect(node.toNodeData('peer-a')).toEqual(before);
    });
});
