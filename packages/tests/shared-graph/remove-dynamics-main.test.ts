import { VertexState } from '@shared-graph/graph/graph-props.ts';
import { CoreSelectionAlgo } from '@shared-graph/graph/steiner-core-algorithms.ts';
import { cleanupAfterRemove, removeVertex } from '@shared-graph/remove/remove-dynamics-main.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGraph } from './helpers.ts';

const mockState = vi.hoisted(() => ({
    rvLeaf: vi.fn(),
    rvODTwo: vi.fn(),
    rvUnusedSP: vi.fn(),
    rvTRMDDLN: vi.fn(),
    rvTryReplace: vi.fn(),
    rvMCEdge: vi.fn(),
    rvSearchMCEdge: vi.fn(),
    rvMDEdge: vi.fn(),
    rvSearchMDEdge: vi.fn()
}));

vi.mock('@shared-graph/remove/remove-dynamics-basic.ts', () => ({
    rvLeaf: mockState.rvLeaf,
    rvODTwo: mockState.rvODTwo,
    rvUnusedSP: mockState.rvUnusedSP
}));

vi.mock('@shared-graph/remove/remove-dynamics-mddl.ts', () => ({
    rvTRMDDLN: mockState.rvTRMDDLN
}));

vi.mock('@shared-graph/remove/remove-dynamics-try-replace.ts', () => ({
    rvTryReplace: mockState.rvTryReplace
}));

vi.mock('@shared-graph/remove/remove-dynamics-mc.ts', () => ({
    rvMCEdge: mockState.rvMCEdge,
    rvSearchMCEdge: mockState.rvSearchMCEdge
}));

vi.mock('@shared-graph/remove/remove-dynamics-md.ts', () => ({
    rvMDEdge: mockState.rvMDEdge,
    rvSearchMDEdge: mockState.rvSearchMDEdge
}));

describe('shared-graph remove-dynamics-main dispatch', () => {
    beforeEach(() => {
        mockState.rvLeaf.mockReset();
        mockState.rvODTwo.mockReset();
        mockState.rvUnusedSP.mockReset();
        mockState.rvTRMDDLN.mockReset();
        mockState.rvTryReplace.mockReset();
        mockState.rvMCEdge.mockReset();
        mockState.rvSearchMCEdge.mockReset();
        mockState.rvMDEdge.mockReset();
        mockState.rvSearchMDEdge.mockReset();
    });

    it('routes prune algorithms through rvTryReplace like the registry/service path', () => {
        const graph = createGraph(
            [
                ['peer-a', VertexState.MEMBER, 4],
                ['peer-b', VertexState.MEMBER, 4],
                ['peer-c', VertexState.MEMBER, 4]
            ],
            [
                ['peer-a', 'peer-b', 1],
                ['peer-b', 'peer-c', 1]
            ]
        );
        const expected = { graph, changed: true };
        mockState.rvTryReplace.mockReturnValue(expected);

        const result = removeVertex(
            {
                globalGraph: graph,
                groupGraph: graph,
                actionVertexId: 'peer-b',
                treeAlgo: 'REMOVE_TRY_REPLACE_PRUNE_MC',
                steinerCandidates: new Set<string>()
            },
            {
                coreSelectionAlgo: CoreSelectionAlgo.MEDIAN_DISTANCE
            }
        );

        expect(mockState.rvTryReplace).toHaveBeenCalledWith(
            expect.objectContaining({
                treeAlgo: 'REMOVE_TRY_REPLACE_PRUNE_MC'
            }),
            CoreSelectionAlgo.MEDIAN_DISTANCE
        );
        expect(mockState.rvTRMDDLN).not.toHaveBeenCalled();
        expect(result).toBe(expected);
    });

    it('delegates cleanup to rvUnusedSP', () => {
        const graph = createGraph(
            [['peer-a', VertexState.MEMBER, 4]],
            []
        );
        const cleaned = { graph, changed: true };
        mockState.rvUnusedSP.mockReturnValue(cleaned);

        const result = cleanupAfterRemove({
            globalGraph: graph,
            groupGraph: graph,
            actionVertexId: 'peer-a',
            treeAlgo: 'REMOVE_MINIMUM_COST_EDGE',
            steinerCandidates: new Set<string>()
        });

        expect(mockState.rvUnusedSP).toHaveBeenCalledOnce();
        expect(result).toBe(cleaned);
    });
});
