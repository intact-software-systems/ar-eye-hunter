import { MessageType, ReconfigAlgo } from '@shared-graph/algo-props.ts';
import { VertexState, type WeightedGraph } from '@shared-graph/graph/graph-props.ts';
import { updateGroupTree } from '@shared-graph/graphs-tree-service.ts';
import type { DynamicTreeAlgo } from '@shared-graph/remove/remove-dynamics-types.ts';
import { describe, expect, it } from 'vitest';
import { createGraph, createGroupSnapshot } from './helpers.ts';

describe('a tree leave through updateGroupTree', () => {
    it('a leave under the cheapest-links remove drops the leaver and links its neighbours', () => {
        const tree = computeLeaveOfX('REMOVE_MINIMUM_COST_EDGE');

        expect(tree.nodes().sort()).toEqual(['a', 'b', 'c']);
        expect(tree.size).toBe(2);
        expect(tree.hasEdge('a', 'b')).toBe(true);
        expect(tree.hasEdge('a', 'c')).toBe(true);
    });

    it('a leave under try-replace keeps a leaver whose takeover would lengthen the tree', () => {
        // A neighbour taking over links the others at weight 10: diameter 20 against the leaver's star of 2.
        const tree = computeLeaveOfX('REMOVE_TRY_REPLACE_MDDL_NAIVE');

        expect(tree.hasNode('x')).toBe(true);
        expect(tree.getNodeAttribute('x', 'state')).toBe(VertexState.STEINER);
        expect(tree.size).toBe(3);
    });
});

function computeLeaveOfX(removeAlgo: DynamicTreeAlgo): WeightedGraph {
    const globalGraph = createGraph(
        [
            ['a', VertexState.MEMBER, 4],
            ['b', VertexState.MEMBER, 4],
            ['c', VertexState.MEMBER, 4]
        ],
        [
            ['a', 'b', 10],
            ['a', 'c', 10],
            ['b', 'c', 10]
        ]
    );
    const groupGraph = createGraph(
        [
            ['a', VertexState.MEMBER, 4],
            ['b', VertexState.MEMBER, 4],
            ['c', VertexState.MEMBER, 4],
            ['x', VertexState.MEMBER, 4]
        ],
        [
            ['x', 'a', 1],
            ['x', 'b', 1],
            ['x', 'c', 1]
        ]
    );

    return updateGroupTree({
        type: MessageType.TO_SERVER_LEAVE,
        fromNode: 'x',
        group: createGroupSnapshot('group-1', ['a', 'b', 'c']),
        groupGraph,
        globalGraph,
        globalArgs: {
            diameterBound: Number.POSITIVE_INFINITY,
            reconfigAlgo: ReconfigAlgo.NO_RECONFIG_ALGO,
            removeAlgo
        }
    }).tree;
}
