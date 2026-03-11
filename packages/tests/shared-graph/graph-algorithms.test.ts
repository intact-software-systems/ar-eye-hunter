import { describe, expect, it } from 'vitest';
import { UndirectedGraph } from 'graphology';
import { DEFAULT_GRAPH_PROP } from '@shared-graph/algo-props.ts';
import {
    canAcceptChild,
    cloneTree,
    diameterDistance,
    diffGraphs,
    dijkstraOnTreeFromSource,
    disconnectAllEdges,
    eccentricity,
    getDegreeConstraint,
    getEdgeWeight,
    isValidMesh,
    mergeGraphs,
    neighborsOf,
    pruneNonTerminalLeaves,
    worstCaseDist,
} from '@shared-graph/graph/graph-algs.ts';
import {
    dijkstraDistances,
    eccentricityDistance,
    kBestLocatedNodesFromGraphAverage,
    kBestLocatedNodesFromGraphMedian,
    kBestLocatedNodesFromVertexSubsetAverage,
    kCenterNodes,
} from '@shared-graph/graph/core-node-algorithms.ts';
import {
    type EdgeProp,
    type GraphProp,
    type VertexProp,
    VertexState,
    VertexType,
    type WeightedGraph,
} from '@shared-graph/graph/graph-props.ts';

describe('shared-graph core algorithms', () => {
    it('computes shortest paths, eccentricity, and diameter on weighted trees', () => {
        const tree = createGraph([
            ['a', VertexState.MEMBER, 3],
            ['b', VertexState.MEMBER, 2],
            ['c', VertexState.MEMBER, 2],
        ], [
            ['a', 'b', 2],
            ['b', 'c', 3],
        ]);

        expect(getEdgeWeight(tree, 'a', 'b')).toBe(2);
        expect(neighborsOf(tree, 'b').sort()).toEqual(['a', 'c']);
        expect(canAcceptChild(tree, 'b')).toBe(false);
        expect(getDegreeConstraint(tree, 'a')).toBe(3);
        expect(dijkstraOnTreeFromSource(tree, 'a')).toEqual(
            new Map([
                ['a', 0],
                ['b', 2],
                ['c', 5],
            ]),
        );
        expect(diameterDistance(tree)).toBe(5);
        expect(eccentricity(tree, 'b')).toBe(3);
        expect(worstCaseDist(tree, 'a')).toBe(5);

        const cloned = cloneTree(tree);
        disconnectAllEdges(cloned, 'b');

        expect(cloned.size).toBe(0);
        expect(tree.size).toBe(2);
    });

    it('ranks candidate nodes by average, median, center, and dijkstra distances', () => {
        const fullMesh = createGraph([
            ['a', VertexState.MEMBER, 4],
            ['b', VertexState.MEMBER, 4],
            ['c', VertexState.MEMBER, 4],
            ['d', VertexState.MEMBER, 4],
        ], [
            ['a', 'b', 4],
            ['a', 'c', 2],
            ['a', 'd', 6],
            ['b', 'c', 3],
            ['b', 'd', 5],
            ['c', 'd', 1],
        ]);

        expect(kBestLocatedNodesFromGraphAverage(fullMesh, 2)).toEqual(['c', 'a']);
        expect(kBestLocatedNodesFromGraphMedian(fullMesh, 2)).toEqual(['c', 'a']);
        expect(
            kBestLocatedNodesFromVertexSubsetAverage(
                fullMesh,
                new Set(['a', 'b', 'c']),
                2,
            ),
        ).toEqual(['c', 'a']);
        expect(kCenterNodes(fullMesh, new Set(['a', 'b', 'c', 'd']), 2)).toEqual([
            'c',
            'b',
        ]);

        const sparse = createGraph([
            ['a', VertexState.MEMBER, 4],
            ['b', VertexState.MEMBER, 4],
            ['c', VertexState.MEMBER, 4],
            ['d', VertexState.MEMBER, 4],
        ], [
            ['a', 'b', 1],
            ['b', 'c', 1],
            ['c', 'd', 2],
        ]);

        expect(dijkstraDistances(sparse, new Set(['a', 'b', 'c', 'd']), 'a')).toEqual(
            new Map([
                ['a', 0],
                ['b', 1],
                ['c', 2],
                ['d', 4],
            ]),
        );
        expect(eccentricityDistance(sparse, new Set(['a', 'b', 'c', 'd']), 'b')).toBe(3);
        expect(kCenterNodes(sparse, new Set(['a', 'b', 'c', 'd']), 2)).toEqual([
            'c',
            'b',
        ]);
    });

    it('validates connectivity and mutates graphs through diff, prune, and merge helpers', () => {
        const base = createGraph([
            ['member-a', VertexState.MEMBER, 3],
            ['steiner-1', VertexState.STEINER, 8],
            ['steiner-2', VertexState.STEINER, 8],
            ['member-b', VertexState.MEMBER, 3],
        ], [
            ['member-a', 'steiner-1', 1],
            ['steiner-1', 'steiner-2', 1],
            ['steiner-2', 'member-b', 1],
        ]);
        const removeGraph = createGraph([
            ['steiner-1', VertexState.STEINER, 8],
            ['steiner-2', VertexState.STEINER, 8],
        ], [
            ['steiner-1', 'steiner-2', 1],
        ]);

        diffGraphs(base, removeGraph);

        expect(base.hasEdge('steiner-1', 'steiner-2')).toBe(false);

        pruneNonTerminalLeaves(base);

        expect(base.hasNode('steiner-1')).toBe(false);
        expect(base.hasNode('steiner-2')).toBe(false);
        expect(isValidMesh(base)).toBe(false);

        const target = createGraph([
            ['member-a', VertexState.MEMBER, 3],
        ], []);
        const source = createGraph([
            ['member-a', VertexState.MEMBER, 3],
            ['member-b', VertexState.MEMBER, 3],
        ], [
            ['member-a', 'member-b', 7],
        ]);

        mergeGraphs(target, source);

        expect(target.hasNode('member-b')).toBe(true);
        expect(target.hasEdge('member-a', 'member-b')).toBe(true);
        expect(isValidMesh(target)).toBe(true);
    });
});

function createGraph(
    nodes: ReadonlyArray<readonly [string, VertexState, number]>,
    edges: ReadonlyArray<readonly [string, string, number]>,
): WeightedGraph {
    const graph = new UndirectedGraph<VertexProp, EdgeProp, GraphProp>();
    graph.replaceAttributes(DEFAULT_GRAPH_PROP);

    for (const [id, state, degreeLimit] of nodes) {
        graph.addNode(id, {
            id,
            type: VertexType.CLIENT,
            state,
            degreeLimit,
        });
    }

    for (const [from, to, weight] of edges) {
        graph.addEdge(from, to, {
            from,
            to,
            weight,
        });
    }

    return graph as WeightedGraph;
}
