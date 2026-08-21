import type { ControlSnapshotSelectionIndex } from '@shared-test/rallar-bb-test/control-snapshot-selection-index.ts';
import {
    isDistributedRunTerminalState,
    type RallarBlackBoxDistributedGroupRef
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import { deriveControlAgentBoardRows, summarizeControlAgentBoardRows } from '../../control-agent-board.ts';
import type {
    ControlAgentSnapshot,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot
} from '../../control-run-manager.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import type { ControlQueryStatus } from './control-query.ts';
import { deriveControlRunSelectionPatch } from './control-run-selection-patch.ts';
import { deriveControlSelectionContexts } from './control-selection-context.ts';
import type {
    RecipeConsoleControlSelection,
    RecipeConsoleControlSelectionIssue
} from './control-selection-contract.ts';
import {
    createControlSelectionIndexProjection,
    type IndexedRecipeConsoleControlSelectionWork
} from './control-selection-index-projection.ts';

export type {
    RecipeConsoleActiveRunContext,
    RecipeConsoleControlGroupContext,
    RecipeConsoleControlSelection,
    RecipeConsoleControlSelectionIssue
} from './control-selection-contract.ts';

export type RecipeConsoleControlSelectionWork =
    | IndexedRecipeConsoleControlSelectionWork
    | Readonly<{
        indexed: false;
        fallback: boolean;
    }>;
const workBySelection = new WeakMap<object, RecipeConsoleControlSelectionWork>();

export function deriveRecipeConsoleControlSelection(
    input: Readonly<{
        urlState: RecipeConsoleUrlState;
        snapshot?: ControlServerSnapshot;
        bootstrapRunId?: string;
        bootstrapGroup: RallarBlackBoxDistributedGroupRef;
        queryStatus: ControlQueryStatus;
        nowEpochMs?: number;
        selectionIndex?: ControlSnapshotSelectionIndex;
    }>
): RecipeConsoleControlSelection {
    const runs = input.snapshot?.runs ?? [];
    const distributedRuns = input.snapshot?.distributedRuns ?? [];
    const fallbackToLegacy = (): RecipeConsoleControlSelection => {
        const fallback = deriveRecipeConsoleControlSelection({
            ...input,
            selectionIndex: undefined
        });
        workBySelection.set(
            fallback,
            Object.freeze({
                indexed: false,
                fallback: true
            })
        );
        return fallback;
    };
    const requestedProjection = input.snapshot && input.selectionIndex
        ? createControlSelectionIndexProjection({
            snapshot: input.snapshot,
            index: input.selectionIndex
        })
        : undefined;
    if (requestedProjection?.kind === 'fallback') {
        return fallbackToLegacy();
    }
    const indexProjection = requestedProjection?.kind === 'indexed'
        ? requestedProjection
        : undefined;
    const selectionIndex = indexProjection?.index;
    const findControlRun = (runId: string): ControlRunSnapshot | undefined => {
        return indexProjection
            ? indexProjection.findControlRun(runId)
            : runs.find((run) => run.runId === runId);
    };
    const findDistributedRun = (
        distributedRunId: string
    ): ControlDistributedRunSnapshot | undefined => {
        return indexProjection
            ? indexProjection.findDistributedRun(distributedRunId)
            : distributedRuns.find((run) => run.distributedRunId === distributedRunId);
    };
    const hasSnapshot = input.snapshot !== undefined;
    const hasDistributedRunCollection = input.snapshot?.distributedRuns !== undefined;
    const snapshotEvidence = input.queryStatus === 'stale'
        ? 'last-known snapshot'
        : 'latest snapshot';
    const selectedContextEvidence = input.queryStatus === 'stale'
        ? 'last-known selected context'
        : 'selected context';
    const controlSnapshotEvidence = input.queryStatus === 'stale'
        ? 'last-known control snapshot'
        : 'control snapshot';
    const issues: RecipeConsoleControlSelectionIssue[] = [];
    const explicitControlRunId = input.urlState.controlRunId;
    let controlRunId = explicitControlRunId;
    let controlRun = explicitControlRunId
        ? findControlRun(explicitControlRunId)
        : undefined;
    let controlRunSource: RecipeConsoleControlSelection['controlRunSource'];
    let urlReplacePatch: Partial<RecipeConsoleUrlState> | undefined;

    if (explicitControlRunId) {
        controlRunSource = 'url';
        if (hasSnapshot && !controlRun) {
            issues.push(issue(
                'controlRunId',
                'unavailable',
                `Control run ${explicitControlRunId} is not present in the ${snapshotEvidence}.`,
                explicitControlRunId
            ));
        }
    }
    else {
        const bootstrapRun = input.bootstrapRunId
            ? findControlRun(input.bootstrapRunId)
            : undefined;
        if (bootstrapRun) {
            controlRun = bootstrapRun;
            controlRunId = bootstrapRun.runId;
            controlRunSource = 'bootstrap';
            urlReplacePatch = { controlRunId };
        }
        else if (runs.length === 1) {
            controlRun = runs[0];
            controlRunId = controlRun.runId;
            controlRunSource = 'sole-run';
            urlReplacePatch = { controlRunId };
        }
        else if (runs.length > 1) {
            issues.push(issue(
                'controlRunId',
                'ambiguous',
                'Multiple control runs are available; select one explicitly.'
            ));
        }
    }
    if (indexProjection && !indexProjection.valid()) {
        return fallbackToLegacy();
    }

    const distributedRunId = input.urlState.distributedRunId;
    const distributedCandidate = distributedRunId
        ? findDistributedRun(distributedRunId)
        : undefined;
    if (indexProjection && !indexProjection.valid()) {
        return fallbackToLegacy();
    }
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
        issues.push(
            distributedCandidate && controlRun
                ? issue(
                    'distributedRunId',
                    'incompatible',
                    `Distributed run ${distributedRunId} belongs to another control run in the ${snapshotEvidence}.`,
                    distributedRunId
                )
                : issue(
                    'distributedRunId',
                    'unavailable',
                    `Distributed run ${distributedRunId} is not available in the ${selectedContextEvidence}.`,
                    distributedRunId
                )
        );
    }
    if (hasSnapshot && !hasDistributedRunCollection) {
        issues.push(issue(
            'distributedRuns',
            'unavailable',
            `The ${controlSnapshotEvidence} does not include distributed-run context.`
        ));
    }

    const agentId = input.urlState.agentId;
    let agent: ControlAgentSnapshot | undefined;
    if (agentId && controlRun) {
        agent = indexProjection
            ? indexProjection.findAgent(controlRun.runId, agentId)
            : controlRun.agents.find((candidate) => candidate.agentId === agentId);
    }
    if (indexProjection && !indexProjection.valid()) {
        return fallbackToLegacy();
    }
    if (agentId && controlRun && !agent) {
        issues.push(issue(
            'agentId',
            'unavailable',
            `Agent ${agentId} is not present in the selected control run in the ${snapshotEvidence}.`,
            agentId
        ));
    }

    let activeRuns: readonly ControlDistributedRunSnapshot[] = [];
    if (controlRun) {
        activeRuns = indexProjection
            ? indexProjection.activeRuns(controlRun.runId)
            : distributedRuns
                .filter((run) => run.controlRunId === controlRun.runId)
                .filter((run) => !isDistributedRunTerminalState(run.state))
                .sort((left, right) =>
                    right.updatedAtEpochMs - left.updatedAtEpochMs ||
                    left.distributedRunId.localeCompare(right.distributedRunId)
                );
    }
    if (indexProjection && !indexProjection.valid()) {
        return fallbackToLegacy();
    }
    const { activeRunContext, groupContext } = deriveControlSelectionContexts({
        activeRuns,
        distributedRun,
        bootstrapGroup: input.bootstrapGroup
    });
    const boardRows = deriveControlAgentBoardRows({
        run: controlRun,
        group: groupContext.group,
        distributedRuns,
        selectedDistributedRun: distributedRun,
        nowEpochMs: input.nowEpochMs,
        snapshot: input.snapshot,
        selectionIndex
    });
    const boardSummary = summarizeControlAgentBoardRows(boardRows);
    const safe = input.queryStatus === 'live' || input.queryStatus === 'partial';

    const selection: RecipeConsoleControlSelection = {
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
        boardSummary,
        safeTargetableCount: safe ? boardSummary.targetable : 0,
        lastKnownTargetableCount: boardSummary.targetable
    };
    workBySelection.set(
        selection,
        indexProjection
            ? Object.freeze({ ...indexProjection.work })
            : Object.freeze({ indexed: false, fallback: false })
    );
    return selection;
}

export function recipeConsoleControlSelectionWorkForTest(
    selection: RecipeConsoleControlSelection
): RecipeConsoleControlSelectionWork | undefined {
    return workBySelection.get(selection);
}

export function recipeConsoleControlRunSelectionPatch(
    input: Readonly<{
        state: RecipeConsoleUrlState;
        controlRunId: string;
        distributedRuns: readonly ControlDistributedRunSnapshot[];
    }>
): Partial<RecipeConsoleUrlState> {
    return deriveControlRunSelectionPatch(input);
}

function issue(
    field: RecipeConsoleControlSelectionIssue['field'],
    code: RecipeConsoleControlSelectionIssue['code'],
    message: string,
    value?: string
): RecipeConsoleControlSelectionIssue {
    return { field, code, message, value };
}
