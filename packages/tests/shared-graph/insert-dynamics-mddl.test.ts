import { VertexState } from '@shared-graph/graph/graph-props.ts';
import { insertMinimumDiameterDegreeLimitedEdge, insertTryReplaceMddlNaive } from '@shared-graph/tree/insert-dynamics-mddl.ts';
import { describe, expect, it } from 'vitest';
import { createGraph } from './helpers.ts';

describe('shared-graph dynamic mddl insertion', () => {
    it('attaches to the minimum-diameter feasible target', () => {
        const tree = createGraph(
            [
                ['b', VertexState.MEMBER, 4],
                ['c', VertexState.MEMBER, 4]
            ],
            [['b', 'c', 5]]
        );
        const globalGraph = createGraph(
            [
                ['a', VertexState.MEMBER, 4],
                ['b', VertexState.MEMBER, 4],
                ['c', VertexState.MEMBER, 4]
            ],
            [
                ['a', 'b', 1],
                ['a', 'c', 2],
                ['b', 'c', 5]
            ]
        );

        const result = insertMinimumDiameterDegreeLimitedEdge(tree, globalGraph, 'a');

        expect(result.nodes().sort()).toEqual(['a', 'b', 'c']);
        expect(result.hasEdge('a', 'b')).toBe(true);
        expect(result.hasEdge('a', 'c')).toBe(false);
        expect(tree.hasNode('a')).toBe(false);
    });

    it('prefers action-vertex intersection when it reduces the resulting diameter', () => {
        const tree = createGraph(
            [
                ['b', VertexState.MEMBER, 4],
                ['c', VertexState.MEMBER, 3],
                ['d', VertexState.MEMBER, 4]
            ],
            [
                ['b', 'c', 5],
                ['c', 'd', 5]
            ]
        );
        const globalGraph = createGraph(
            [
                ['a', VertexState.MEMBER, 4],
                ['b', VertexState.MEMBER, 4],
                ['c', VertexState.MEMBER, 3],
                ['d', VertexState.MEMBER, 4]
            ],
            [
                ['a', 'b', 1],
                ['a', 'c', 1],
                ['a', 'd', 1],
                ['b', 'c', 5],
                ['c', 'd', 5]
            ]
        );

        const result = insertTryReplaceMddlNaive(tree, globalGraph, 'a');

        expect(result.hasEdge('a', 'b')).toBe(true);
        expect(result.hasEdge('a', 'c')).toBe(true);
        expect(result.hasEdge('a', 'd')).toBe(true);
        expect(result.hasEdge('b', 'c')).toBe(false);
        expect(result.hasEdge('c', 'd')).toBe(false);
    });

    it('can choose a steiner intersection when the action vertex cannot absorb the neighbors', () => {
        const tree = createGraph(
            [
                ['b', VertexState.MEMBER, 4],
                ['c', VertexState.MEMBER, 3],
                ['d', VertexState.MEMBER, 4]
            ],
            [
                ['b', 'c', 5],
                ['c', 'd', 5]
            ]
        );
        const globalGraph = createGraph(
            [
                ['a', VertexState.MEMBER, 1],
                ['b', VertexState.MEMBER, 4],
                ['c', VertexState.MEMBER, 3],
                ['d', VertexState.MEMBER, 4],
                ['s', VertexState.STEINER, 4]
            ],
            [
                ['a', 'b', 1],
                ['a', 'c', 1],
                ['a', 'd', 1],
                ['a', 's', 1],
                ['b', 'c', 5],
                ['b', 's', 1],
                ['c', 'd', 5],
                ['c', 's', 1],
                ['d', 's', 1]
            ]
        );

        const result = insertTryReplaceMddlNaive(
            tree,
            globalGraph,
            'a',
            () => 's'
        );

        expect(result.getNodeAttribute('s', 'state')).toBe(VertexState.STEINER);
        expect(result.hasEdge('s', 'a')).toBe(true);
        expect(result.hasEdge('s', 'b')).toBe(true);
        expect(result.hasEdge('s', 'c')).toBe(true);
        expect(result.hasEdge('s', 'd')).toBe(true);
        expect(result.hasEdge('a', 'c')).toBe(false);
    });
});
