import type { RallarBlackBoxDistributedGroupRef } from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { ControlDistributedRunSnapshot } from '../../control-run-manager.ts';
import type { RecipeConsoleActiveRunContext, RecipeConsoleControlGroupContext } from './control-selection-contract.ts';

export function deriveControlSelectionContexts(
    input: Readonly<{
        activeRuns: readonly ControlDistributedRunSnapshot[];
        distributedRun?: ControlDistributedRunSnapshot;
        bootstrapGroup: RallarBlackBoxDistributedGroupRef;
    }>
): Readonly<{
    activeRunContext: RecipeConsoleActiveRunContext;
    groupContext: RecipeConsoleControlGroupContext;
}> {
    const activeRunContext: RecipeConsoleActiveRunContext = {
        kind: input.activeRuns.length === 0
            ? 'none'
            : input.activeRuns.length === 1
            ? 'sole'
            : 'ambiguous',
        runs: input.activeRuns
    };
    const groupContext: RecipeConsoleControlGroupContext = input.distributedRun
        ? {
            source: 'selected-distributed-run',
            group: input.distributedRun.manifest.group
        }
        : input.activeRuns.length === 1
        ? {
            source: 'sole-active-distributed-run',
            group: input.activeRuns[0]!.manifest.group
        }
        : { source: 'bootstrap', group: input.bootstrapGroup };
    return { activeRunContext, groupContext };
}
