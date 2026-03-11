import { describe, expect, it } from 'vitest';
import { VertexState } from '@shared-graph/graph/graph-props.ts';
import { createEmptyTreeLike, mddlOTTC, relaxDegreeByOne, } from '@shared-graph/tree/mddl-ottc.ts';
import { createGraph } from './helpers.ts';

describe('shared-graph mddl ottc', () => {
    it('relaxes degree bounds and clones graph attributes into empty trees', () => {
        const graph = createGraph(
            [['a', VertexState.MEMBER, 2]],
            [],
        );
        const degreeBound = new Map<string, number>([['a', 1]]);

        expect(relaxDegreeByOne(new Set<string>(), degreeBound)).toBe(false);
        expect(relaxDegreeByOne(new Set(['a', 'b']), degreeBound)).toBe(true);
        expect(degreeBound).toEqual(
            new Map([
                ['a', 2],
                ['b', 1],
            ]),
        );

        const empty = createEmptyTreeLike(graph);
        expect(empty.order).toBe(0);
        expect(empty.size).toBe(0);
        expect(empty.getAttributes()).toEqual(graph.getAttributes());
    });

    it('builds a tree across reachable vertices', () => {
        const graph = createGraph(
            [
                ['a', VertexState.MEMBER, 4],
                ['b', VertexState.MEMBER, 4],
                ['c', VertexState.MEMBER, 4],
            ],
            [
                ['a', 'b', 1],
                ['a', 'c', 1],
                ['b', 'c', 10],
            ],
        );

        const result = mddlOTTC(graph, 'a', new Set(['a', 'b', 'c']), () => false);

        expect(result.success).toBe(true);
        expect(result.tree.nodes().sort()).toEqual(['a', 'b', 'c']);
        expect(result.tree.size).toBe(2);
        expect(result.tree.hasEdge('a', 'b')).toBe(true);
        expect(result.tree.hasEdge('a', 'c')).toBe(true);
    });

    it('fails when the requested vertices are not all reachable from the source', () => {
        const graph = createGraph(
            [
                ['a', VertexState.MEMBER, 4],
                ['b', VertexState.MEMBER, 4],
                ['c', VertexState.MEMBER, 4],
            ],
            [['a', 'b', 1]],
        );

        const result = mddlOTTC(graph, 'a', new Set(['a', 'b', 'c']), () => false);

        expect(result.success).toBe(false);
        expect(result.tree.nodes().sort()).toEqual(['a', 'b']);
        expect(result.tree.size).toBe(1);
        expect(result.tree.hasNode('c')).toBe(false);
    });
});
