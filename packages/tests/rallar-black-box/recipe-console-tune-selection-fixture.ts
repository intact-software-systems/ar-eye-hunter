import type { AnalyzeArtifactModel } from '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-artifact-model.ts';
import type { AnalyzeTuneArtifactFacade } from '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-worker-contract.ts';
import type { ControlQuerySnapshot } from '../../../apps/rallar-black-box/src/recipe-console/control/control-query.ts';
import type { RecipeConsoleUrlState } from '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';
import { tunePerformanceRunIds } from '../../../apps/rallar-black-box/src/recipe-console/tune/tune-performance-run-ids.ts';
import { buildTuneRunCatalog } from '../../../apps/rallar-black-box/src/recipe-console/tune/tune-run-catalog.ts';
import {
    computeTuneSelectionModel,
    type TuneSelectionModel
} from '../../../apps/rallar-black-box/src/recipe-console/tune/tune-selection-model.ts';
import type { ControlServerSnapshot } from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';

/**
 * The Tune workspace builds its catalog through the cache before it asks for a
 * selection model. A suite that has only a control query builds the same catalog
 * here instead of asking the model to build one it would never build in the app.
 */
export function toTuneSelectionModelFromQuery(
    input: Readonly<{
        urlState: RecipeConsoleUrlState;
        query: ControlQuerySnapshot<ControlServerSnapshot>;
        /** Absent unless the suite exercises a retained artifact source. */
        retainedArtifact?: AnalyzeArtifactModel;
        /** Absent unless the suite exercises a retained artifact source. */
        retainedArtifactStatus?: 'idle' | 'pending' | 'ready' | 'error';
        /** Absent unless the suite exercises the retained worker facade. */
        retainedFacade?: AnalyzeTuneArtifactFacade;
    }>
): TuneSelectionModel {
    return computeTuneSelectionModel({
        urlState: input.urlState,
        catalog: buildTuneRunCatalog({
            distributedRuns: input.query.snapshot?.distributedRuns ?? [],
            controlRuns: input.query.snapshot?.runs ?? [],
            retainedArtifact: input.retainedArtifact,
            retainedArtifactStatus: input.retainedArtifactStatus,
            retainedArtifactFocusRunId: input.urlState.compareRight ??
                input.urlState.distributedRunId,
            retainedFacade: input.retainedFacade,
            performanceRunIds: tunePerformanceRunIds(input.urlState)
        })
    });
}
