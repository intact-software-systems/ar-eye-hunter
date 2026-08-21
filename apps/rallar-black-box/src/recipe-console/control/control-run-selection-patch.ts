import type { ControlDistributedRunSnapshot } from '../../control-run-manager.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';

export function deriveControlRunSelectionPatch(
    input: Readonly<{
        state: RecipeConsoleUrlState;
        controlRunId: string;
        distributedRuns: readonly ControlDistributedRunSnapshot[];
    }>
): Partial<RecipeConsoleUrlState> {
    const distributedRunId = input.state.distributedRunId &&
            input.distributedRuns.some((run) =>
                run.distributedRunId === input.state.distributedRunId &&
                run.controlRunId === input.controlRunId
            )
        ? input.state.distributedRunId
        : undefined;
    return {
        controlRunId: input.controlRunId,
        distributedRunId,
        agentId: undefined
    };
}
