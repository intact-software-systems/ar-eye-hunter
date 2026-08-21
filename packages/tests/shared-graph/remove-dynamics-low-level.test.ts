import { VertexState } from '@shared-graph/graph/graph-props.ts';
import { removeBasic, rvLeaf, rvODTwo, rvUnusedSP } from '@shared-graph/remove/remove-dynamics-basic.ts';
import { rvMCEdge, rvSearchMCEdge } from '@shared-graph/remove/remove-dynamics-mc.ts';
import { rvMDEdge, rvSearchMDEdge } from '@shared-graph/remove/remove-dynamics-md.ts';
import { describe, expect, it } from 'vitest';
import { createGraph } from './helpers.ts';

describe('shared-graph low-level remove dynamics', () => {
    it('removes leaves, degree-two vertices, and unused steiner points', () => {
        const leafGlobal = createGraph(
            [
                ['a', VertexState.MEMBER, 4],
                ['x', VertexState.MEMBER, 4]
            ],
            [['a', 'x', 1]]
        );
        const leafCtx = createRemoveCtx(leafGlobal, leafGlobal, 'x');

        const leaf = rvLeaf(leafCtx);
        expect(leaf.changed).toBe(true);
        expect(leaf.graph.hasNode('x')).toBe(false);
        expect(removeBasic(leafCtx).graph.hasNode('x')).toBe(false);

        const degreeTwoGlobal = createGraph(
            [
                ['a', VertexState.MEMBER, 4],
                ['b', VertexState.MEMBER, 4],
                ['x', VertexState.MEMBER, 4]
            ],
            [
                ['a', 'x', 1],
                ['b', 'x', 1],
                ['a', 'b', 7]
            ]
        );
        const degreeTwoCtx = createRemoveCtx(degreeTwoGlobal, degreeTwoGlobal, 'x');

        const bridged = rvODTwo(degreeTwoCtx);
        expect(bridged.graph.hasNode('x')).toBe(false);
        expect(bridged.graph.hasEdge('a', 'b')).toBe(true);
        expect(removeBasic(degreeTwoCtx).graph.hasEdge('a', 'b')).toBe(true);

        const steinerGraph = createGraph(
            [
                ['member-a', VertexState.MEMBER, 4],
                ['steiner-1', VertexState.STEINER, 8],
                ['steiner-2', VertexState.STEINER, 8]
            ],
            [
                ['member-a', 'steiner-1', 1],
                ['steiner-1', 'steiner-2', 1]
            ]
        );
        const pruned = rvUnusedSP(createRemoveCtx(steinerGraph, steinerGraph, 'steiner-2'));
        expect(pruned.graph.nodes()).toEqual(['member-a']);
    });

    it('reconnects removed neighborhoods by minimum cost and by minimum diameter', () => {
        const globalGraph = createGraph(
            [
                ['a', VertexState.MEMBER, 3],
                ['b', VertexState.MEMBER, 3],
                ['c', VertexState.MEMBER, 3],
                ['x', VertexState.MEMBER, 4]
            ],
            [
                ['a', 'x', 1],
                ['b', 'x', 1],
                ['c', 'x', 1],
                ['a', 'b', 1],
                ['a', 'c', 5],
                ['b', 'c', 1]
            ]
        );
        const groupGraph = createGraph(
            [
                ['a', VertexState.MEMBER, 3],
                ['b', VertexState.MEMBER, 3],
                ['c', VertexState.MEMBER, 3],
                ['x', VertexState.MEMBER, 4]
            ],
            [
                ['a', 'x', 1],
                ['b', 'x', 1],
                ['c', 'x', 1]
            ]
        );
        const ctx = createRemoveCtx(globalGraph, groupGraph, 'x');

        const byCost = rvMCEdge(ctx);
        expect(byCost.graph.hasNode('x')).toBe(false);
        expect(byCost.graph.hasEdge('a', 'b')).toBe(true);
        expect(byCost.graph.hasEdge('b', 'c')).toBe(true);

        const byDiameter = rvMDEdge(ctx);
        expect(byDiameter.graph.hasNode('x')).toBe(false);
        expect(byDiameter.graph.hasEdge('a', 'b')).toBe(true);
        expect(byDiameter.graph.hasEdge('a', 'c')).toBe(true);

        const searchCost = rvSearchMCEdge(ctx);
        expect(searchCost.graph.hasNode('x')).toBe(false);
        expect(searchCost.graph.size).toBe(2);

        const searchDiameter = rvSearchMDEdge(ctx);
        expect(searchDiameter.graph.hasNode('x')).toBe(false);
        expect(searchDiameter.graph.size).toBe(2);
    });

    it('fails fast when neighbors do not have enough spare degree to reconnect', () => {
        const globalGraph = createGraph(
            [
                ['a', VertexState.MEMBER, 1],
                ['b', VertexState.MEMBER, 1],
                ['c', VertexState.MEMBER, 1],
                ['x', VertexState.MEMBER, 4]
            ],
            [
                ['a', 'x', 1],
                ['b', 'x', 1],
                ['c', 'x', 1],
                ['a', 'b', 1],
                ['b', 'c', 1]
            ]
        );
        const groupGraph = createGraph(
            [
                ['a', VertexState.MEMBER, 1],
                ['b', VertexState.MEMBER, 1],
                ['c', VertexState.MEMBER, 1],
                ['x', VertexState.MEMBER, 4]
            ],
            [
                ['a', 'x', 1],
                ['b', 'x', 1],
                ['c', 'x', 1]
            ]
        );
        const ctx = createRemoveCtx(globalGraph, groupGraph, 'x');

        expect(() => rvMCEdge(ctx)).toThrow('insufficient available out-degree');
        expect(() => rvMDEdge(ctx)).toThrow('insufficient available out-degree');
    });
});

function createRemoveCtx(
    globalGraph: ReturnType<typeof createGraph>,
    groupGraph: ReturnType<typeof createGraph>,
    actionVertexId: string
) {
    return {
        globalGraph,
        groupGraph,
        actionVertexId,
        treeAlgo: 'REMOVE_MINIMUM_COST_EDGE' as const,
        steinerCandidates: new Set<string>()
    };
}
