import type { RemoveDispatcherDeps, RemoveDispatcherOptions } from './remove-dynamics-dispatcher-types.ts';
import { cleanupRemoveResult, defaultRemoveAlgorithm, removeAlgorithmRegistry } from './remove-dynamics-registry.ts';
import type { RemoveDynamicsContext, RemoveResult } from './remove-dynamics-types.ts';

export type RemoveServiceResult = RemoveResult & {
    attemptedAlgo: RemoveDynamicsContext['treeAlgo'];
    usedFallback: boolean;
};

export function runRemoveAlgorithm(
    ctx: RemoveDynamicsContext,
    deps: RemoveDispatcherDeps = {},
    options: RemoveDispatcherOptions = {}
): RemoveServiceResult {
    const cleanupUnusedSteiner = options.cleanupUnusedSteiner ?? true;
    const fallbackAlgo = options.fallbackAlgo ?? 'REMOVE_TRY_REPLACE_MDDL_NAIVE';

    const algorithm = removeAlgorithmRegistry[ctx.treeAlgo];
    let result: RemoveResult;
    let usedFallback = false;

    try {
        if (algorithm !== undefined) {
            result = algorithm(ctx, deps);
        }
        else {
            result = defaultRemoveAlgorithm(ctx);
        }
    }
    catch (_error) {
        usedFallback = true;

        if (ctx.treeAlgo === fallbackAlgo) {
            result = defaultRemoveAlgorithm({
                ...ctx,
                treeAlgo: 'NO_DYNAMIC_TREE_ALGO'
            });
        }
        else {
            const fallbackCtx: RemoveDynamicsContext = {
                ...ctx,
                treeAlgo: fallbackAlgo
            };

            const fallbackAlgorithm = removeAlgorithmRegistry[fallbackCtx.treeAlgo];
            if (fallbackAlgorithm !== undefined) {
                result = fallbackAlgorithm(fallbackCtx, deps);
            }
            else {
                result = defaultRemoveAlgorithm(fallbackCtx);
            }
        }
    }

    if (cleanupUnusedSteiner) {
        result = cleanupRemoveResult({
            ...ctx,
            groupGraph: result.graph
        });
    }

    return {
        ...result,
        attemptedAlgo: ctx.treeAlgo,
        usedFallback
    };
}
