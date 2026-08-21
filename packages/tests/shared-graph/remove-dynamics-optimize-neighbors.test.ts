import { VertexState } from '@shared-graph/graph/graph-props.ts';
import { getNeighborsOptimizeSP } from '@shared-graph/remove/remove-dynamics-optimize-neighbors.ts';
import { describe, expect, it } from 'vitest';
import { createGraph } from './helpers.ts';

describe('shared-graph optimized neighbor discovery', () => {
    it('walks through steiner chains and collects members, steiners, and traversed edges', () => {
        const graph = createGraph(
            [
                ['src', VertexState.MEMBER, 4],
                ['member-a', VertexState.MEMBER, 4],
                ['member-b', VertexState.MEMBER, 4],
                ['member-c', VertexState.MEMBER, 4],
                ['sp-1', VertexState.STEINER, 8],
                ['sp-2', VertexState.STEINER, 8]
            ],
            [
                ['src', 'sp-1', 1],
                ['sp-1', 'member-a', 1],
                ['sp-1', 'sp-2', 1],
                ['sp-2', 'member-b', 1],
                ['src', 'member-c', 1]
            ]
        );

        const result = getNeighborsOptimizeSP(graph, 'src');

        expect([...result.adjacentMembers].sort()).toEqual([
            'member-a',
            'member-b',
            'member-c',
            'src'
        ]);
        expect([...result.adjacentSteiner].sort()).toEqual(['sp-1', 'sp-2']);
        expect(result.removableEdgeKeys.size).toBe(5);
    });
});
