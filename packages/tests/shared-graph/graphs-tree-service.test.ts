import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageType, ReconfigAlgo } from '@shared-graph/algo-props.ts';
import { VertexState } from '@shared-graph/graph/graph-props.ts';
import {
    computeReconfig,
    pickSourceForCreate,
    pickSourceForRebuild,
    updateGroupTree,
} from '@shared-graph/graphs-tree-service.ts';
import { createGraph, createGroupSnapshot } from './helpers.ts';

const mockState = vi.hoisted(() => ({
    insert: vi.fn(),
    remove: vi.fn(),
    mddl: vi.fn(),
    diameter: vi.fn(),
}));

vi.mock('@shared-graph/tree/insert-dynamics-mddl.ts', () => ({
    insertMinimumDiameterDegreeLimitedEdge: mockState.insert,
}));

vi.mock('@shared-graph/tree/remove-dynamics-mddl.ts', () => ({
    removeTryReplaceMDDL: mockState.remove,
}));

vi.mock('@shared-graph/tree/mddl-ottc.ts', () => ({
    mddlOTTC: mockState.mddl,
    relaxDegreeByOne: vi.fn(),
}));

vi.mock('@shared-graph/graph/graph-algs.ts', () => ({
    diameterDistance: mockState.diameter,
}));

describe('shared-graph tree service orchestration', () => {
    beforeEach(() => {
        mockState.insert.mockReset();
        mockState.remove.mockReset();
        mockState.mddl.mockReset();
        mockState.diameter.mockReset();
    });

    it('uses the insert branch for join events and returns the updated tree when no reconfig runs', () => {
        const groupGraph = createGraph(
            [
                ['peer-a', VertexState.MEMBER, 4],
                ['peer-b', VertexState.MEMBER, 4],
            ],
            [['peer-a', 'peer-b', 5]],
        );
        const globalGraph = createGraph(
            [
                ['peer-a', VertexState.MEMBER, 4],
                ['peer-b', VertexState.MEMBER, 4],
                ['peer-c', VertexState.MEMBER, 4],
            ],
            [
                ['peer-a', 'peer-b', 5],
                ['peer-a', 'peer-c', 2],
                ['peer-b', 'peer-c', 3],
            ],
        );
        const insertedTree = createGraph(
            [
                ['peer-a', VertexState.MEMBER, 4],
                ['peer-b', VertexState.MEMBER, 4],
                ['peer-c', VertexState.MEMBER, 4],
            ],
            [
                ['peer-a', 'peer-b', 5],
                ['peer-b', 'peer-c', 3],
            ],
        );

        mockState.insert.mockReturnValue(insertedTree);

        const result = updateGroupTree({
            type: MessageType.TO_SERVER_ENTER,
            fromNode: 'peer-c',
            group: createGroupSnapshot('group-1', ['peer-a', 'peer-b', 'peer-c']),
            groupGraph,
            globalGraph,
            globalArgs: {
                diameterBound: 2,
                reconfigAlgo: ReconfigAlgo.NO_RECONFIG_ALGO,
            },
        });

        expect(mockState.insert).toHaveBeenCalledWith(
            groupGraph,
            globalGraph,
            'peer-c',
            expect.any(Function),
        );
        expect(mockState.remove).not.toHaveBeenCalled();
        expect(result.reconfigured).toBe(false);
        expect(result.tree).toBe(insertedTree);
    });

    it('uses the remove branch and replaces the tree when pairwise reconfig succeeds', () => {
        const globalGraph = createGraph(
            [
                ['peer-a', VertexState.MEMBER, 4],
                ['peer-b', VertexState.MEMBER, 4],
                ['peer-c', VertexState.MEMBER, 4],
                ['peer-d', VertexState.MEMBER, 4],
                ['peer-e', VertexState.MEMBER, 4],
            ],
            [
                ['peer-a', 'peer-b', 1],
                ['peer-b', 'peer-c', 1],
                ['peer-c', 'peer-d', 1],
                ['peer-d', 'peer-e', 1],
                ['peer-a', 'peer-e', 1],
            ],
        );
        const removedTree = createGraph(
            [
                ['peer-a', VertexState.MEMBER, 4],
                ['peer-b', VertexState.MEMBER, 4],
                ['peer-c', VertexState.MEMBER, 4],
                ['peer-d', VertexState.MEMBER, 4],
                ['peer-e', VertexState.MEMBER, 4],
            ],
            [
                ['peer-a', 'peer-b', 8],
                ['peer-b', 'peer-c', 8],
                ['peer-c', 'peer-d', 8],
                ['peer-d', 'peer-e', 8],
            ],
        );
        const rebuiltTree = createGraph(
            [
                ['peer-a', VertexState.MEMBER, 4],
                ['peer-b', VertexState.MEMBER, 4],
                ['peer-c', VertexState.MEMBER, 4],
                ['peer-d', VertexState.MEMBER, 4],
                ['peer-e', VertexState.MEMBER, 4],
            ],
            [
                ['peer-a', 'peer-e', 1],
                ['peer-a', 'peer-b', 1],
                ['peer-b', 'peer-c', 1],
                ['peer-c', 'peer-d', 1],
            ],
        );

        mockState.remove.mockReturnValue(removedTree);
        mockState.diameter.mockReturnValue(99);
        mockState.mddl.mockReturnValue({
            success: true,
            tree: rebuiltTree,
        });

        const result = updateGroupTree({
            type: MessageType.TO_SERVER_LEAVE,
            fromNode: 'peer-c',
            group: createGroupSnapshot('group-1', [
                'peer-a',
                'peer-b',
                'peer-c',
                'peer-d',
                'peer-e',
            ]),
            groupGraph: removedTree,
            globalGraph,
            globalArgs: {
                diameterBound: 2,
                reconfigAlgo: ReconfigAlgo.TEST_OPTIMAL_PAIR_WISE,
            },
        });

        expect(mockState.remove).toHaveBeenCalledWith(
            removedTree,
            globalGraph,
            'peer-c',
            expect.any(Function),
        );
        expect(mockState.mddl).toHaveBeenCalledWith(
            globalGraph,
            'peer-a',
            new Set(['peer-a', 'peer-b', 'peer-c', 'peer-d', 'peer-e']),
            expect.any(Function),
        );
        expect(result.reconfigured).toBe(true);
        expect(result.tree).toBe(rebuiltTree);
    });

    it('skips reconfig when the group is small and picks the first member as a rebuild source', () => {
        const tree = createGraph(
            [
                ['peer-z', VertexState.MEMBER, 4],
                ['peer-a', VertexState.MEMBER, 4],
                ['peer-b', VertexState.MEMBER, 4],
            ],
            [
                ['peer-z', 'peer-a', 1],
                ['peer-a', 'peer-b', 1],
            ],
        );

        const result = computeReconfig(
            tree,
            new Set(['peer-a', 'peer-b', 'peer-z']),
            tree,
            {
                diameterBound: 1,
                reconfigAlgo: ReconfigAlgo.TEST_OPTIMAL_PAIR_WISE,
            },
        );

        expect(result.left).toBe(false);
        expect(result.right).toBeUndefined();
        expect(pickSourceForRebuild(tree, new Set(['peer-a', 'peer-b']))).toBe('peer-a');
        expect(pickSourceForRebuild(tree, new Set(['missing']))).toBeUndefined();
    });

    it('picks the best average-located source for sparse create graphs', () => {
        const graph = createGraph(
            [
                ['peer-a', VertexState.MEMBER, 5],
                ['peer-b', VertexState.MEMBER, 5],
                ['peer-c', VertexState.MEMBER, 5],
                ['peer-d', VertexState.MEMBER, 5],
                ['peer-e', VertexState.MEMBER, 5],
            ],
            [
                ['peer-a', 'peer-b', 1],
                ['peer-b', 'peer-c', 10],
                ['peer-c', 'peer-d', 10],
                ['peer-d', 'peer-e', 10],
            ],
        );

        expect(
            pickSourceForCreate(
                graph,
                new Set(['peer-a', 'peer-b', 'peer-c', 'peer-d', 'peer-e']),
            ),
        ).toBe('peer-a');
    });
});
