import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { recipeConsoleControlRunSelectionPatch } from '../control/control-selection.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { safeAnalyzeArtifactIdentity, type AnalyzeImportedArtifactIdentity } from './analyze-identity-policy.ts';
export { analyzeArtifactIdentityIssues } from './analyze-identity-policy.ts';

export type AnalyzeOptionDerivationWork = {
    controlRunVisitCount: number;
    distributedRunVisitCount: number;
    compatibleRunProjectionCount: number;
    sortComparisonCount: number;
};

const EMPTY_ANALYZE_RUN_OPTIONS = Object.freeze([]) as readonly never[];

export function deriveAnalyzeControlRunOptions(
    runs: readonly ControlRunSnapshot[],
    active = true,
    work?: AnalyzeOptionDerivationWork
): readonly ControlRunSnapshot[] {
    if (!active) {
        return EMPTY_ANALYZE_RUN_OPTIONS;
    }
    const options: ControlRunSnapshot[] = [];
    for (const run of runs) {
        if (work) {
            work.controlRunVisitCount += 1;
        }
        options.push(run);
    }
    return options.sort((left, right) => {
        if (work) {
            work.sortComparisonCount += 1;
        }
        return right.updatedAtEpochMs - left.updatedAtEpochMs ||
            left.runId.localeCompare(right.runId);
    });
}

export function deriveAnalyzeDistributedRunOptions(
    input: Readonly<{
        controlRunId?: string;
        distributedRuns: readonly ControlDistributedRunSnapshot[];
    }>,
    active = true,
    work?: AnalyzeOptionDerivationWork
): readonly ControlDistributedRunSnapshot[] {
    if (!active) {
        return EMPTY_ANALYZE_RUN_OPTIONS;
    }
    if (!input.controlRunId) {
        return EMPTY_ANALYZE_RUN_OPTIONS;
    }
    const options: ControlDistributedRunSnapshot[] = [];
    for (const run of input.distributedRuns) {
        if (work) {
            work.distributedRunVisitCount += 1;
        }
        if (run.controlRunId !== input.controlRunId) {
            continue;
        }
        if (work) {
            work.compatibleRunProjectionCount += 1;
        }
        options.push(run);
    }
    return options.sort((left, right) => {
        if (work) {
            work.sortComparisonCount += 1;
        }
        return right.updatedAtEpochMs - left.updatedAtEpochMs ||
            left.distributedRunId.localeCompare(right.distributedRunId);
    });
}

export function findAnalyzeDistributedRunOption(
    options: readonly ControlDistributedRunSnapshot[],
    distributedRunId: string
): ControlDistributedRunSnapshot | undefined {
    return options.find((run) => run.distributedRunId === distributedRunId);
}

export function recipeConsoleAnalyzeControlRunSelectionPatch(
    input: Readonly<{
        state: RecipeConsoleUrlState;
        controlRunId: string;
        distributedRuns: readonly ControlDistributedRunSnapshot[];
    }>
): Partial<RecipeConsoleUrlState> {
    return {
        ...recipeConsoleControlRunSelectionPatch(input),
        agentId: undefined,
        recipeId: undefined,
        commandId: undefined
    };
}

export function recipeConsoleAnalyzeDistributedRunSelectionPatch(
    run: Pick<ControlDistributedRunSnapshot, 'controlRunId' | 'distributedRunId'>
): Partial<RecipeConsoleUrlState> {
    return {
        controlRunId: run.controlRunId,
        distributedRunId: run.distributedRunId,
        agentId: undefined,
        recipeId: undefined,
        commandId: undefined
    };
}

export function analyzeImportedIdentityPatch(
    identity: AnalyzeImportedArtifactIdentity
): Partial<RecipeConsoleUrlState> {
    const safe = safeAnalyzeArtifactIdentity(identity);
    return {
        controlRunId: safe.controlRunId,
        distributedRunId: safe.distributedRunId,
        agentId: undefined,
        recipeId: undefined,
        commandId: undefined
    };
}

export function analyzeFilterClearPatch(): Partial<RecipeConsoleUrlState> {
    return {
        agentId: undefined,
        recipeId: undefined,
        commandId: undefined,
        diagnosticSeverity: undefined,
        transport: undefined,
        historyQuery: undefined,
        status: undefined,
        from: undefined,
        to: undefined
    };
}
