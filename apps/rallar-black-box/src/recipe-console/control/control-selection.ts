import {
    isDistributedRunTerminalState,
    type RallarBlackBoxDistributedGroupRef,
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import {
    deriveControlAgentBoardRows,
    summarizeControlAgentBoardRows,
    type ControlAgentBoardRow,
} from '../../control-agent-board.ts';
import type {
    ControlAgentSnapshot,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot,
} from '../../control-run-manager.ts';
import type { ControlQueryStatus } from './control-query.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';

export type RecipeConsoleControlSelectionIssue = Readonly<{
    field: 'controlRunId' | 'distributedRunId' | 'agentId' | 'distributedRuns';
    code: 'unavailable' | 'ambiguous' | 'incompatible';
    message: string;
    value?: string;
}>;

export type RecipeConsoleActiveRunContext = Readonly<{
    kind: 'none' | 'sole' | 'ambiguous';
    runs: readonly ControlDistributedRunSnapshot[];
}>;

export type RecipeConsoleControlGroupContext = Readonly<{
    source: 'selected-distributed-run' | 'sole-active-distributed-run' | 'bootstrap';
    group: RallarBlackBoxDistributedGroupRef;
}>;

export type RecipeConsoleControlSelection = Readonly<{
    controlRunId?: string;
    controlRun?: ControlRunSnapshot;
    controlRunSource?: 'url' | 'bootstrap' | 'sole-run';
    distributedRunId?: string;
    distributedRun?: ControlDistributedRunSnapshot;
    agentId?: string;
    agent?: ControlAgentSnapshot;
    issues: readonly RecipeConsoleControlSelectionIssue[];
    urlReplacePatch?: Partial<RecipeConsoleUrlState>;
    activeRunContext: RecipeConsoleActiveRunContext;
    groupContext: RecipeConsoleControlGroupContext;
    boardRows: readonly ControlAgentBoardRow[];
    safeTargetableCount: number;
    lastKnownTargetableCount: number;
}>;

export function deriveRecipeConsoleControlSelection(input: Readonly<{
    urlState: RecipeConsoleUrlState;
    snapshot?: ControlServerSnapshot;
    bootstrapRunId?: string;
    bootstrapGroup: RallarBlackBoxDistributedGroupRef;
    queryStatus: ControlQueryStatus;
    nowEpochMs?: number;
}>): RecipeConsoleControlSelection {
    const runs = input.snapshot?.runs ?? [];
    const distributedRuns = input.snapshot?.distributedRuns ?? [];
    const hasSnapshot = input.snapshot !== undefined;
    const hasDistributedRunCollection = input.snapshot?.distributedRuns !== undefined;
    const issues: RecipeConsoleControlSelectionIssue[] = [];
    const explicitControlRunId = input.urlState.controlRunId;
    let controlRunId = explicitControlRunId;
    let controlRun = explicitControlRunId
        ? runs.find(run => run.runId === explicitControlRunId)
        : undefined;
    let controlRunSource: RecipeConsoleControlSelection['controlRunSource'];
    let urlReplacePatch: Partial<RecipeConsoleUrlState> | undefined;

    if (explicitControlRunId) {
        controlRunSource = 'url';
        if (hasSnapshot && !controlRun) {
            issues.push(issue(
                'controlRunId',
                'unavailable',
                `Control run ${explicitControlRunId} is not present in the latest snapshot.`,
                explicitControlRunId,
            ));
        }
    } else {
        const bootstrapRun = input.bootstrapRunId
            ? runs.find(run => run.runId === input.bootstrapRunId)
            : undefined;
        if (bootstrapRun) {
            controlRun = bootstrapRun;
            controlRunId = bootstrapRun.runId;
            controlRunSource = 'bootstrap';
            urlReplacePatch = { controlRunId };
        } else if (runs.length === 1) {
            controlRun = runs[0];
            controlRunId = controlRun.runId;
            controlRunSource = 'sole-run';
            urlReplacePatch = { controlRunId };
        } else if (runs.length > 1) {
            issues.push(issue(
                'controlRunId',
                'ambiguous',
                'Multiple control runs are available; select one explicitly.',
            ));
        }
    }

    const distributedRunId = input.urlState.distributedRunId;
    const distributedCandidate = distributedRunId
        ? distributedRuns.find(run => run.distributedRunId === distributedRunId)
        : undefined;
    const distributedRun = distributedCandidate && controlRun &&
            distributedCandidate.controlRunId === controlRun.runId
        ? distributedCandidate
        : undefined;
    if (
        distributedRunId &&
        controlRun &&
        hasDistributedRunCollection &&
        !distributedRun
    ) {
        issues.push(distributedCandidate && controlRun
            ? issue(
                'distributedRunId',
                'incompatible',
                `Distributed run ${distributedRunId} belongs to another control run.`,
                distributedRunId,
            )
            : issue(
                'distributedRunId',
                'unavailable',
                `Distributed run ${distributedRunId} is not available in the selected context.`,
                distributedRunId,
            ));
    }
    if (hasSnapshot && !hasDistributedRunCollection) {
        issues.push(issue(
            'distributedRuns',
            'unavailable',
            'The control snapshot does not include distributed-run context.',
        ));
    }

    const agentId = input.urlState.agentId;
    const agent = agentId
        ? controlRun?.agents.find(candidate => candidate.agentId === agentId)
        : undefined;
    if (agentId && controlRun && !agent) {
        issues.push(issue(
            'agentId',
            'unavailable',
            `Agent ${agentId} is not present in the selected control run.`,
            agentId,
        ));
    }

    const activeRuns = controlRun
        ? distributedRuns
            .filter(run => run.controlRunId === controlRun.runId)
            .filter(run => !isDistributedRunTerminalState(run.state))
            .sort((left, right) =>
                right.updatedAtEpochMs - left.updatedAtEpochMs ||
                left.distributedRunId.localeCompare(right.distributedRunId)
            )
        : [];
    const activeRunContext: RecipeConsoleActiveRunContext = {
        kind: activeRuns.length === 0 ? 'none' : activeRuns.length === 1 ? 'sole' : 'ambiguous',
        runs: activeRuns,
    };
    const groupContext: RecipeConsoleControlGroupContext = distributedRun
        ? {
            source: 'selected-distributed-run',
            group: distributedRun.manifest.group,
        }
        : activeRuns.length === 1
        ? {
            source: 'sole-active-distributed-run',
            group: activeRuns[0].manifest.group,
        }
        : {
            source: 'bootstrap',
            group: input.bootstrapGroup,
        };
    const boardRows = deriveControlAgentBoardRows({
        run: controlRun,
        group: groupContext.group,
        distributedRuns,
        selectedDistributedRun: distributedRun,
        nowEpochMs: input.nowEpochMs,
    });
    const boardSummary = summarizeControlAgentBoardRows(boardRows);
    const safe = input.queryStatus === 'live' || input.queryStatus === 'partial';

    return {
        controlRunId,
        controlRun,
        controlRunSource,
        distributedRunId,
        distributedRun,
        agentId,
        agent,
        issues,
        urlReplacePatch,
        activeRunContext,
        groupContext,
        boardRows,
        safeTargetableCount: safe ? boardSummary.targetable : 0,
        lastKnownTargetableCount: boardSummary.targetable,
    };
}

export function recipeConsoleControlRunSelectionPatch(input: Readonly<{
    state: RecipeConsoleUrlState;
    controlRunId: string;
    distributedRuns: readonly ControlDistributedRunSnapshot[];
}>): Partial<RecipeConsoleUrlState> {
    const distributedRunId = input.state.distributedRunId &&
            input.distributedRuns.some(run =>
                run.distributedRunId === input.state.distributedRunId &&
                run.controlRunId === input.controlRunId
            )
        ? input.state.distributedRunId
        : undefined;
    return {
        controlRunId: input.controlRunId,
        distributedRunId,
        agentId: undefined,
    };
}

function issue(
    field: RecipeConsoleControlSelectionIssue['field'],
    code: RecipeConsoleControlSelectionIssue['code'],
    message: string,
    value?: string,
): RecipeConsoleControlSelectionIssue {
    return { field, code, message, value };
}
