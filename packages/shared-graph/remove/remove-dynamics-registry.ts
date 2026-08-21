import { CoreSelectionAlgo } from '../graph/steiner-core-algorithms.ts';
import { rvLeaf, rvODTwo, rvUnusedSP } from './remove-dynamics-basic.ts';
import type { RemoveAlgorithmFn } from './remove-dynamics-dispatcher-types.ts';
import { rvMCEdge, rvSearchMCEdge } from './remove-dynamics-mc.ts';
import { rvMDEdge, rvSearchMDEdge } from './remove-dynamics-md.ts';
import { rvTRMDDLN } from './remove-dynamics-mddl.ts';
import { rvTryReplace } from './remove-dynamics-try-replace.ts';
import type { RemoveDynamicsContext } from './remove-dynamics-types.ts';

export const removeAlgorithmRegistry: Partial<Record<RemoveDynamicsContext['treeAlgo'], RemoveAlgorithmFn>> = {
    REMOVE_TRY_REPLACE_MDDL_NAIVE: (ctx, deps) => rvTRMDDLN(ctx, deps.selectSteinerCandidate),

    REMOVE_TRY_REPLACE_PRUNE_MDDL: (ctx, deps) =>
        rvTryReplace(ctx, deps.coreSelectionAlgo ?? CoreSelectionAlgo.CENTER_SELECTION),

    REMOVE_TRY_REPLACE_PRUNE_MC: (ctx, deps) =>
        rvTryReplace(ctx, deps.coreSelectionAlgo ?? CoreSelectionAlgo.CENTER_SELECTION),

    REMOVE_TRY_REPLACE_PRUNE_SEARCH_MDDL: (ctx, deps) =>
        rvTryReplace(ctx, deps.coreSelectionAlgo ?? CoreSelectionAlgo.CENTER_SELECTION),

    REMOVE_TRY_REPLACE_PRUNE_SEARCH_MC: (ctx, deps) =>
        rvTryReplace(ctx, deps.coreSelectionAlgo ?? CoreSelectionAlgo.CENTER_SELECTION),

    REMOVE_MINIMUM_COST_EDGE: (ctx) => rvMCEdge(ctx),

    REMOVE_SEARCH_MINIMUM_COST_EDGE: (ctx) => rvSearchMCEdge(ctx),

    REMOVE_MINIMUM_DIAMETER_EDGE: (ctx) => rvMDEdge(ctx),

    REMOVE_SEARCH_MINIMUM_DIAMETER_EDGE: (ctx) => rvSearchMDEdge(ctx)
};

export function defaultRemoveAlgorithm(ctx: RemoveDynamicsContext): ReturnType<RemoveAlgorithmFn> {
    if (!ctx.groupGraph.hasNode(ctx.actionVertexId)) {
        return {
            graph: ctx.groupGraph,
            changed: false
        };
    }

    const degree = ctx.groupGraph.degree(ctx.actionVertexId);

    if (degree <= 1) {
        return rvLeaf(ctx);
    }

    if (degree === 2) {
        return rvODTwo(ctx);
    }

    return rvTRMDDLN(ctx);
}

export function cleanupRemoveResult(ctx: RemoveDynamicsContext) {
    return rvUnusedSP(ctx);
}
