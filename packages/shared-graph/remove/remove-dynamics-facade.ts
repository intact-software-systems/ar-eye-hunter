import type { DynamicTreeAlgo } from './remove-dynamics-types.ts';
import type { SelectSteinerCandidate } from './remove-dynamics-mddl.ts';
import { runRemoveAlgorithm } from './remove-dynamics-service.ts';
import { CoreSelectionAlgo } from '../graph/steiner-core-algorithms.ts';
import { TreeGraph, VertexId } from '../graph-props.ts';

export type RemoveFacadeInput = {
    globalGraph: TreeGraph;
    groupGraph: TreeGraph;
    actionVertexId: VertexId;
    treeAlgo: DynamicTreeAlgo;
    steinerCandidates?: ReadonlySet<VertexId>;
    selectSteinerCandidate?: SelectSteinerCandidate;
    coreSelectionAlgo?: CoreSelectionAlgo;
};

export function removeVertexFromTree(input: RemoveFacadeInput) {
    return runRemoveAlgorithm(
        {
            globalGraph: input.globalGraph,
            groupGraph: input.groupGraph,
            actionVertexId: input.actionVertexId,
            treeAlgo: input.treeAlgo,
            steinerCandidates: input.steinerCandidates ?? new Set<VertexId>(),
        },
        {
            selectSteinerCandidate: input.selectSteinerCandidate,
            coreSelectionAlgo: input.coreSelectionAlgo ?? CoreSelectionAlgo.CENTER_SELECTION,
        },
        {
            cleanupUnusedSteiner: true,
            fallbackAlgo: 'REMOVE_TRY_REPLACE_MDDL_NAIVE',
        },
    );
}