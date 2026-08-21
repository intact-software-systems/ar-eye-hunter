import type { CoreSelectionAlgo } from '../graph/steiner-core-algorithms.ts';
import type { SelectSteinerCandidate } from './remove-dynamics-mddl.ts';
import type { RemoveDynamicsContext, RemoveResult } from './remove-dynamics-types.ts';

export type RemoveDispatcherDeps = {
    selectSteinerCandidate?: SelectSteinerCandidate;
    coreSelectionAlgo?: CoreSelectionAlgo;
};

export type RemoveDispatcherOptions = {
    cleanupUnusedSteiner?: boolean;
    fallbackAlgo?: RemoveDynamicsContext['treeAlgo'];
};

export type RemoveAlgorithmFn = (
    ctx: RemoveDynamicsContext,
    deps: RemoveDispatcherDeps
) => RemoveResult;
