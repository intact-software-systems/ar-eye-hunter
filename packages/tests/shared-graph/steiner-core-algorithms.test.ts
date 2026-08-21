import { VertexState } from '@shared-graph/graph/graph-props.ts';
import {
    CoreSelectionAlgo,
    findkBestLocatedNodesNotInSetsMedian,
    findWCNodes,
    kCenterNodes,
    kMedianNodes
} from '@shared-graph/graph/steiner-core-algorithms.ts';
import { describe, expect, it } from 'vitest';
import { createGraph } from './helpers.ts';

describe('shared-graph steiner core algorithms', () => {
    it('dispatches average and median selection with exclusion sets', () => {
        const graph = createGraph(
            [
                ['a', VertexState.MEMBER, 4],
                ['b', VertexState.MEMBER, 4],
                ['c', VertexState.MEMBER, 4],
                ['d', VertexState.MEMBER, 4]
            ],
            [
                ['a', 'b', 4],
                ['a', 'c', 2],
                ['a', 'd', 6],
                ['b', 'c', 3],
                ['b', 'd', 5],
                ['c', 'd', 1]
            ]
        );
        const nodes = new Set(['a', 'b', 'c', 'd']);

        expect(
            findWCNodes(
                graph,
                nodes,
                nodes,
                new Set<string>(),
                2,
                CoreSelectionAlgo.AVERAGE_DISTANCE
            )
        ).toEqual(['c', 'a']);
        expect(
            kMedianNodes(graph, nodes, nodes, new Set(['c']), 2)
        ).toEqual(['a', 'b']);
        expect(
            findWCNodes(
                graph,
                nodes,
                nodes,
                new Set(['c']),
                2,
                CoreSelectionAlgo.MEDIAN_DISTANCE
            )
        ).toEqual(['a', 'b']);
        expect(
            findkBestLocatedNodesNotInSetsMedian(graph, nodes, nodes, new Set(['c']), 2)
        ).toEqual(['a', 'b']);
    });

    it('uses center selection on sparse graphs and handles empty requests', () => {
        const sparse = createGraph(
            [
                ['a', VertexState.MEMBER, 4],
                ['b', VertexState.MEMBER, 4],
                ['c', VertexState.MEMBER, 4],
                ['d', VertexState.MEMBER, 4]
            ],
            [
                ['a', 'b', 1],
                ['b', 'c', 1],
                ['c', 'd', 2]
            ]
        );
        const nodes = new Set(['a', 'b', 'c', 'd']);

        expect(
            kCenterNodes(sparse, nodes, nodes, new Set(['c']), 2)
        ).toEqual(['b', 'a']);
        expect(
            findWCNodes(
                sparse,
                nodes,
                nodes,
                new Set(['c']),
                2,
                CoreSelectionAlgo.CENTER_SELECTION
            )
        ).toEqual(['b', 'a']);
        expect(
            findWCNodes(
                sparse,
                nodes,
                nodes,
                new Set<string>(),
                0,
                CoreSelectionAlgo.CENTER_SELECTION
            )
        ).toEqual([]);
        expect(
            kCenterNodes(sparse, nodes, new Set<string>(), new Set<string>(), 2)
        ).toEqual([]);
    });
});
