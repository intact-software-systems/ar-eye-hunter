import { VertexState } from '@shared-graph/graph/graph-props.ts';
import { kMDDLOTTCTree } from '@shared-graph/mesh/k-mddl-ottc.ts';
import { describe, expect, it } from 'vitest';
import { createGraph } from './helpers.ts';

describe('shared-graph k-mddl-ottc mesh extraction', () => {
    it('returns an empty tree when k is zero', () => {
        const mesh = createGraph(
            [
                ['a', VertexState.MEMBER, 4],
                ['b', VertexState.MEMBER, 4]
            ],
            [['a', 'b', 1]]
        );

        const result = kMDDLOTTCTree(mesh, 0, 'a');

        expect(result.order).toBe(0);
        expect(result.size).toBe(0);
        expect(result.getAttributes()).toEqual(mesh.getAttributes());
    });

    it('extracts a tree from a dense mesh', () => {
        const mesh = createGraph(
            [
                ['a', VertexState.MEMBER, 4],
                ['b', VertexState.MEMBER, 4],
                ['c', VertexState.MEMBER, 4]
            ],
            [
                ['a', 'b', 1],
                ['a', 'c', 1],
                ['b', 'c', 2]
            ]
        );

        const result = kMDDLOTTCTree(mesh, 1, 'a');

        expect(result.nodes().sort()).toEqual(['a', 'b', 'c']);
        expect(result.size).toBe(2);
        expect(result.hasEdge('a', 'b')).toBe(true);
        expect(result.hasEdge('a', 'c')).toBe(true);
    });
});
