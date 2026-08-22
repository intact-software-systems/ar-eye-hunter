import { CoreSelectionAlgo } from '../graph/steiner-core-algorithms.ts';
import { rvLeaf, rvODTwo, rvUnusedSP } from './remove-dynamics-basic.ts';
import { rvMCEdge, rvSearchMCEdge } from './remove-dynamics-mc.ts';
import { rvMDEdge, rvSearchMDEdge } from './remove-dynamics-md.ts';
import { rvTRMDDLN, type SelectSteinerCandidate } from './remove-dynamics-mddl.ts';
import { rvTryReplace } from './remove-dynamics-try-replace.ts';
import { RemoveDynamicsContext, RemoveResult } from './remove-dynamics-types.ts';

export type RemoveDynamicsDeps = {
    selectSteinerCandidate?: SelectSteinerCandidate;
    coreSelectionAlgo?: CoreSelectionAlgo;
};

export function removeVertex(
    ctx: RemoveDynamicsContext,
    deps: RemoveDynamicsDeps = {}
): RemoveResult {
    switch (ctx.treeAlgo) {
        case 'REMOVE_TRY_REPLACE_MDDL_NAIVE':
            return rvTRMDDLN(ctx, deps.selectSteinerCandidate);

        case 'REMOVE_TRY_REPLACE_PRUNE_MDDL':
        case 'REMOVE_TRY_REPLACE_PRUNE_MC':
        case 'REMOVE_TRY_REPLACE_PRUNE_SEARCH_MDDL':
        case 'REMOVE_TRY_REPLACE_PRUNE_SEARCH_MC':
            return rvTryReplace(ctx, deps.coreSelectionAlgo ?? CoreSelectionAlgo.CENTER_SELECTION);

        case 'REMOVE_MINIMUM_COST_EDGE':
            return rvMCEdge(ctx);

        case 'REMOVE_SEARCH_MINIMUM_COST_EDGE':
            return rvSearchMCEdge(ctx);

        case 'REMOVE_MINIMUM_DIAMETER_EDGE':
            return rvMDEdge(ctx);

        case 'REMOVE_SEARCH_MINIMUM_DIAMETER_EDGE':
            return rvSearchMDEdge(ctx);

        case 'NO_DYNAMIC_TREE_ALGO':
        default: {
            const degree = ctx.groupGraph.hasNode(ctx.actionVertexId)
                ? ctx.groupGraph.degree(ctx.actionVertexId)
                : 0;

            if (degree <= 1) {
                return rvLeaf(ctx);
            }

            if (degree === 2) {
                return rvODTwo(ctx);
            }

            return rvTRMDDLN(ctx, deps.selectSteinerCandidate);
        }
    }
}

export function cleanupAfterRemove(ctx: RemoveDynamicsContext): RemoveResult {
    return rvUnusedSP(ctx);
}
