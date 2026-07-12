import type { ControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';

export type MonitorSelectionIssue = Readonly<{
    code: 'unavailable' | 'incompatible' | 'ambiguous';
    message: string;
}>;

export type MonitorDistributedRunSelection = Readonly<{
    distributedRunId?: string;
    run?: ControlDistributedRunSnapshot;
    source: 'explicit' | 'sole-compatible' | 'none';
    issue?: MonitorSelectionIssue;
    urlReplacePatch?: Partial<RecipeConsoleUrlState>;
}>;

export type MonitorEvidenceSelection = Readonly<{
    kind:
        | 'failure'
        | 'agent'
        | 'recipe'
        | 'command'
        | 'diagnostic'
        | 'timeline'
        | 'artifact';
    id: string;
}>;

export function deriveMonitorDistributedRunSelection(input: Readonly<{
    controlRunId?: string;
    requestedDistributedRunId?: string;
    distributedRuns: readonly ControlDistributedRunSnapshot[];
    distributedRunsAuthoritative: boolean;
}>): MonitorDistributedRunSelection {
    const compatible = input.controlRunId
        ? input.distributedRuns.filter(run =>
            run.controlRunId === input.controlRunId
        )
        : [];

    if (input.requestedDistributedRunId) {
        const candidate = input.distributedRuns.find(run =>
            run.distributedRunId === input.requestedDistributedRunId
        );
        const run = candidate?.controlRunId === input.controlRunId
            ? candidate
            : undefined;
        if (run) {
            return {
                distributedRunId: input.requestedDistributedRunId,
                run,
                source: 'explicit',
            };
        }
        return {
            distributedRunId: input.requestedDistributedRunId,
            run: undefined,
            source: 'explicit',
            issue: !input.distributedRunsAuthoritative
                ? undefined
                : candidate
                ? {
                    code: 'incompatible',
                    message: `Distributed run ${input.requestedDistributedRunId} belongs to another control run.`,
                }
                : {
                    code: 'unavailable',
                    message: `Distributed run ${input.requestedDistributedRunId} is not available in the selected control run.`,
                },
        };
    }

    if (input.distributedRunsAuthoritative && compatible.length === 1) {
        const run = compatible[0];
        return {
            distributedRunId: run.distributedRunId,
            run,
            source: 'sole-compatible',
            urlReplacePatch: { distributedRunId: run.distributedRunId },
        };
    }
    if (compatible.length > 1) {
        return {
            distributedRunId: undefined,
            run: undefined,
            source: 'none',
            issue: {
                code: 'ambiguous',
                message: 'Multiple compatible distributed runs are available; select one explicitly.',
            },
        };
    }
    return { distributedRunId: undefined, run: undefined, source: 'none' };
}

export function recipeConsoleMonitorDistributedRunSelectionPatch(
    distributedRunId: string,
): Partial<RecipeConsoleUrlState> {
    return {
        distributedRunId,
        agentId: undefined,
        recipeId: undefined,
        commandId: undefined,
    };
}
