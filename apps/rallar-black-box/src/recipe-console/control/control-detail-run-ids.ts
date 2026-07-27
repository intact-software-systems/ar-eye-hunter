import type {
    ControlRunSnapshot,
    ControlServerSnapshot,
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { isDistributedRunTerminalState } from
    '@shared-test/rallar-bb-test/distributed-run.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';

export function recipeConsoleDetailRunIds(input: Readonly<{
    snapshot: ControlServerSnapshot;
    bootstrapRunId?: string;
    urlState: RecipeConsoleUrlState;
}>): readonly string[] {
    const available = new Set(input.snapshot.runs.map(run => run.runId));
    const distributedById = new Map(
        (input.snapshot.distributedRuns ?? []).map(run => [
            run.distributedRunId,
            run,
        ]),
    );
    const runIds: string[] = [];
    const add = (runId: string | undefined): void => {
        if (runId && available.has(runId) && !runIds.includes(runId)) {
            runIds.push(runId);
        }
    };

    add(input.urlState.controlRunId);
    add(input.bootstrapRunId);
    for (const distributedRunId of [
        input.urlState.distributedRunId,
        input.urlState.compareLeft,
        input.urlState.compareRight,
    ]) {
        add(distributedRunId
            ? distributedById.get(distributedRunId)?.controlRunId
            : undefined);
    }
    for (const run of input.snapshot.distributedRuns ?? []) {
        if (!isDistributedRunTerminalState(run.state)) {
            add(run.controlRunId);
        }
    }

    return runIds;
}

export function mergeControlRunDetails(
    index: ControlServerSnapshot,
    details: readonly ControlRunSnapshot[],
): ControlServerSnapshot {
    const detailsById = new Map(details.map(run => [run.runId, run]));
    return {
        ...index,
        runs: index.runs.map(run => detailsById.get(run.runId) ?? run),
    };
}
