import { VertexState } from '@shared-graph/graph/graph-props.ts';
import { CoreSelectionAlgo } from '@shared-graph/graph/steiner-core-algorithms.ts';
import { removeVertexFromTree } from '@shared-graph/remove/remove-dynamics-facade.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGraph } from './helpers.ts';

const mockState = vi.hoisted(() => ({
    runRemoveAlgorithm: vi.fn()
}));

vi.mock('@shared-graph/remove/remove-dynamics-service.ts', () => ({
    runRemoveAlgorithm: mockState.runRemoveAlgorithm
}));

describe('shared-graph remove dynamics facade', () => {
    beforeEach(() => {
        mockState.runRemoveAlgorithm.mockReset();
    });

    it('forwards defaults to the remove service', () => {
        const graph = createGraph(
            [
                ['peer-a', VertexState.MEMBER, 4],
                ['peer-b', VertexState.MEMBER, 4]
            ],
            [['peer-a', 'peer-b', 1]]
        );

        removeVertexFromTree({
            globalGraph: graph,
            groupGraph: graph,
            actionVertexId: 'peer-b',
            treeAlgo: 'REMOVE_MINIMUM_COST_EDGE'
        });

        expect(mockState.runRemoveAlgorithm).toHaveBeenCalledWith(
            {
                globalGraph: graph,
                groupGraph: graph,
                actionVertexId: 'peer-b',
                treeAlgo: 'REMOVE_MINIMUM_COST_EDGE',
                steinerCandidates: new Set<string>()
            },
            {
                selectSteinerCandidate: undefined,
                coreSelectionAlgo: CoreSelectionAlgo.CENTER_SELECTION
            },
            {
                cleanupUnusedSteiner: true,
                fallbackAlgo: 'REMOVE_TRY_REPLACE_MDDL_NAIVE'
            }
        );
    });
});
