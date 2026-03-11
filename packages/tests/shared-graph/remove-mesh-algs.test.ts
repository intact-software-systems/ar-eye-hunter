import { describe, expect, it, type Mock, vi } from 'vitest';
import { DynamicMeshAlgo } from '@shared-graph/mesh/group-dynamics-mesh-types.ts';
import { type RemoveDynamicsLike, removeFromMesh, removeMeshAlgorithm, } from '@shared-graph/mesh/remove-mesh-algs.ts';
import { VertexState } from '@shared-graph/graph/graph-props.ts';
import { createGraph } from './helpers.ts';

describe('shared-graph remove mesh algorithms', () => {
    it('removes the last remaining member and cleans up steiner nodes', () => {
        const groupGraph = createGraph(
            [
                ['member-a', VertexState.MEMBER, 4],
                ['steiner-1', VertexState.STEINER, 8],
            ],
            [['member-a', 'steiner-1', 1]],
        );
        const rd = createRemoveDynamicsMock();
        const groupInfo = createGroupInfo(groupGraph, ['member-a']);

        const result = removeFromMesh(
            groupGraph,
            groupInfo,
            new Set<string>(),
            'member-a',
            1,
            DynamicMeshAlgo.K_REMOVE_MC,
            () => rd.rd,
        );

        expect(result.validMesh).toBe(true);
        expect(groupGraph.nodes()).toEqual([]);
        expect(groupGraph.edges()).toEqual([]);
        expect(rd.rvUnusedSP).toHaveBeenCalledOnce();
    });

    it('uses leaf removal when the action vertex has degree one', () => {
        const groupGraph = createGraph(
            [
                ['member-a', VertexState.MEMBER, 4],
                ['member-b', VertexState.MEMBER, 4],
            ],
            [['member-a', 'member-b', 1]],
        );
        const rd = createRemoveDynamicsMock();
        const groupInfo = createGroupInfo(groupGraph, ['member-a', 'member-b']);

        removeMeshAlgorithm(
            groupGraph,
            groupInfo,
            new Set<string>(),
            'member-a',
            1,
            DynamicMeshAlgo.K_REMOVE_MC,
            () => rd.rd,
        );

        expect(rd.rvLeaf).toHaveBeenCalledOnce();
        expect(rd.removeVertex).not.toHaveBeenCalled();
        expect(rd.rvUnusedSP).toHaveBeenCalledOnce();
    });

    it('falls back to minimum-cost removal when a prune algorithm throws', () => {
        const groupGraph = createGraph(
            [
                ['member-a', VertexState.MEMBER, 4],
                ['member-b', VertexState.MEMBER, 4],
                ['member-c', VertexState.MEMBER, 4],
            ],
            [
                ['member-a', 'member-b', 1],
                ['member-a', 'member-c', 1],
            ],
        );
        const rd = createRemoveDynamicsMock({
            rvTryReplace: vi.fn(() => {
                throw new Error('boom');
            }),
        });
        const groupInfo = createGroupInfo(groupGraph, ['member-a', 'member-b', 'member-c']);

        removeMeshAlgorithm(
            groupGraph,
            groupInfo,
            new Set<string>(),
            'member-a',
            1,
            DynamicMeshAlgo.K_REMOVE_TRY_REPLACE_PRUNE_MDDL,
            () => rd.rd,
        );

        expect(rd.treeAlgo).toHaveBeenCalledWith('REMOVE_TRY_REPLACE_PRUNE_MDDL');
        expect(rd.rvTryReplace).toHaveBeenCalledOnce();
        expect(rd.removeVertex).toHaveBeenCalledWith('REMOVE_MINIMUM_COST_EDGE');
        expect(rd.rvUnusedSP).toHaveBeenCalledOnce();
    });
});

function createGroupInfo(graph: ReturnType<typeof createGraph>, members: readonly string[]) {
    return {
        getMembers: () => new Set(members),
        getTreeStructure: () => graph,
    };
}

type RemoveDynamicsMock = {
    rvLeaf: Mock<() => void>;
    rvTryReplaceNaive: Mock<() => void>;
    rvTRMDDLN: Mock<() => void>;
    rvTryReplace: Mock<() => void>;
    rvUnusedSP: Mock<() => void>;
    removeVertex: Mock<(algo: string) => void>;
    treeAlgo: Mock<(algo: string) => void>;
};

function createRemoveDynamicsMock(
    overrides?: Partial<RemoveDynamicsMock>,
): RemoveDynamicsMock & { rd: RemoveDynamicsLike } {
    const calls: RemoveDynamicsMock = {
        rvLeaf: vi.fn(),
        rvTryReplaceNaive: vi.fn(),
        rvTRMDDLN: vi.fn(),
        rvTryReplace: vi.fn(),
        rvUnusedSP: vi.fn(),
        removeVertex: vi.fn(),
        treeAlgo: vi.fn(),
        ...overrides,
    };

    return {
        ...calls,
        rd: {
            rvLeaf: () => calls.rvLeaf(),
            rvTryReplaceNaive: () => calls.rvTryReplaceNaive(),
            rvTRMDDLN: () => calls.rvTRMDDLN(),
            rvTryReplace: () => calls.rvTryReplace(),
            rvUnusedSP: () => calls.rvUnusedSP(),
            removeVertex: (algo: string) => calls.removeVertex(algo),
            treeAlgo: (algo: string) => calls.treeAlgo(algo),
        },
    };
}
