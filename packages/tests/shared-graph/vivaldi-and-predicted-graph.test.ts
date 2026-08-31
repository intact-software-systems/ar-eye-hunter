import { DEFAULT_GRAPH_PROP } from '@shared-graph/algo-props.ts';
import {
    createDegreeCappedPredictedGraph,
    createPredictedGraph,
    predictedRttMs,
    upsertPredictedEdge,
    VivaldiNode,
    type VivaldiNodeData
} from '@shared-graph/graph/vivaldi.ts';
import {
    clearAllNodes,
    getAllNodeData,
    getAllNodeIds,
    getNodeDataById,
    getOrCreateNode,
    hasNode
} from '@shared-graph/repository/vivaldi-repository.ts';
import {
    observeRtt,
    readablePredictedNodeData,
    toPredictedGraphFromIds,
    toPredictedGraphSnapshot
} from '@shared-graph/vivaldi-service.ts';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import { configureTestCacheRepositories } from '../configure-test-cache-repositories.ts';

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
                { id: 'peer-a', coords: [0, 0], err: 0.1, rttMs: 0 }
            ],
            [
                'peer-b',
                { id: 'peer-b', coords: [3, 4], err: 0.1, rttMs: 0 }
            ],
            [
                'peer-c',
                { id: 'peer-c', coords: [6, 8], err: 0.1, rttMs: 0 }
            ]
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
            weight: 9
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
                version: 1
            })
        ).toBe(true);
        expect(
            observeRtt({
                sessionIdFrom: 'peer-a',
                sessionIdTo: 'peer-c',
                rttMs: 0,
                createdAtEpochMs: 2,
                version: 2
            })
        ).toBe(false);

        const readable = readablePredictedNodeData();
        expect([...readable.keys()].sort()).toEqual(['peer-a', 'peer-b']);

        const graphFromIds = toPredictedGraphFromIds(
            ['peer-a', 'peer-b', 'missing'],
            DEFAULT_GRAPH_PROP
        );
        const fullGraph = toPredictedGraphSnapshot(DEFAULT_GRAPH_PROP);

        expect(graphFromIds.order).toBe(2);
        expect(graphFromIds.size).toBe(1);
        expect(fullGraph.order).toBe(2);
        expect(fullGraph.size).toBe(1);

        const edgeKey = graphFromIds.edge('peer-a', 'peer-b');
        expect(edgeKey).toBeDefined();
        expect(graphFromIds.getEdgeAttribute(edgeKey!, 'weight')).toSatisfy(
            (weight: number) => Number.isFinite(weight) && weight > 0
        );
    });

    it('builds a complete predicted graph among Vivaldi-known nodes after sparse observations', () => {
        observeRtt({
            sessionIdFrom: 'peer-a',
            sessionIdTo: 'peer-b',
            rttMs: 10,
            createdAtEpochMs: 1,
            version: 1
        });
        observeRtt({
            sessionIdFrom: 'peer-b',
            sessionIdTo: 'peer-c',
            rttMs: 20,
            createdAtEpochMs: 2,
            version: 2
        });

        const graph = toPredictedGraphFromIds(
            ['peer-a', 'peer-b', 'peer-c'],
            DEFAULT_GRAPH_PROP
        );

        expect(graph.order).toBe(3);
        expect(graph.size).toBe(3);
        expect(graph.hasEdge('peer-a', 'peer-c')).toBe(true);
    });

    it('can build a degree-capped predicted graph for Vivaldi-known nodes', () => {
        const nodeDataById = new Map<string, VivaldiNodeData>(
            Array.from({ length: 10 }, (_value, index) => {
                const id = `peer-${index + 1}`;
                return [id, { id, coords: [index, 0], err: 0.1, rttMs: 0 }];
            })
        );

        const graph = createDegreeCappedPredictedGraph(
            nodeDataById,
            DEFAULT_GRAPH_PROP,
            {
                degreeLimit: 3
            }
        );

        expect(graph.order).toBe(10);
        for (const node of graph.nodes()) {
            expect(graph.degree(node)).toBeLessThanOrEqual(3);
        }
    });

    // A grid makes most predicted weights tie exactly, so the tie-break decides
    // real edges. Before the planning input was canonicalized the tie-break read
    // whichever node the map happened to yield first, and the same member set
    // produced different graphs on servers that learned the members in a
    // different order. The permutation is a shuffle rather than a reversal:
    // reversing an evenly spaced set is a mirror symmetry that can hide the
    // difference.
    it('builds the same degree-capped graph regardless of node insertion order', () => {
        const ids = Array.from({ length: 16 }, (_value, index) => `peer-${index + 1}`);
        const shuffled = [4, 12, 0, 7, 15, 2, 9, 1, 13, 5, 10, 3, 14, 6, 11, 8].map(
            (index) => ids[index]
        );
        expect(toDegreeCappedEdgeKeys(shuffled)).toEqual(toDegreeCappedEdgeKeys(ids));
    });

    it('ignores invalid remote data during direct Vivaldi node updates', () => {
        const node = new VivaldiNode({ dimensions: 2, initialError: 0.5 });
        const before = node.toNodeData('peer-a');

        node.update({
            id: 'peer-b',
            coords: [Number.NaN, 1],
            err: 0.4,
            rttMs: 20
        });
        node.update({
            id: 'peer-b',
            coords: [1, 1],
            err: 0.4,
            rttMs: -1
        });

        expect(node.toNodeData('peer-a')).toEqual(before);
    });
});

function toDegreeCappedEdgeKeys(order: readonly string[]): string[] {
    const nodeDataById = new Map<string, VivaldiNodeData>(
        order.map((id) => {
            const index = Number(id.split('-')[1]) - 1;
            return [id, { id, coords: [index % 4, Math.floor(index / 4)], err: 0.1, rttMs: 0 }];
        })
    );
    const graph = createDegreeCappedPredictedGraph(nodeDataById, DEFAULT_GRAPH_PROP, {
        degreeLimit: 3
    });
    const edges: string[] = [];
    graph.forEachEdge((_edge, _attributes, source, target) => {
        edges.push(source < target ? `${source}|${target}` : `${target}|${source}`);
    });
    return edges.sort();
}
