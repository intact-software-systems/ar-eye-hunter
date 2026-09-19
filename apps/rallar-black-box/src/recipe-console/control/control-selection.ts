import type { ControlSnapshotSelectionIndex } from '@shared-test/rallar-bb-test/control-snapshot-selection-index.ts';
import type {
    ControlAgentSnapshot,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { RallarBlackBoxDistributedGroupRef } from '@shared-test/rallar-bb-test/distributed-run.ts';
import { isDistributedRunTerminalState } from '@shared-test/rallar-bb-test/distributed/distributed-run-rollup.ts';
import { CONTROL_AGENT_BOARD_STALE_AFTER_MS } from '../../control-agent-board-contract.ts';
import {
    computeControlAgentBoardRows,
    computeControlAgentBoardSummary
} from '../../control-agent-board.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import type { ControlQueryStatus } from './control-query.ts';
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
        nowEpochMs: number;
        /** Absent unless the caller has a prebuilt snapshot selection index to reuse. */
        selectionIndex?: ControlSnapshotSelectionIndex;
    }>
): RecipeConsoleControlSelection {
    const runs = input.snapshot?.runs ?? [];
    // A poll that could not read the distributed-run collection leaves it absent rather than
    // writing an empty one. The distinction is reported as its own issue below; every scan after
    // that reads the absence as nothing to scan.
    const distributedRunCollection = input.snapshot?.distributedRuns;
    const hasDistributedRunCollection = distributedRunCollection !== undefined;
    const distributedRuns = distributedRunCollection ?? [];
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
    const snapshotEvidence = input.queryStatus === 'stale'
        ? 'last-known snapshot'
        : 'latest snapshot';
    const selectedContextEvidence = input.queryStatus === 'stale'
        ? 'last-known selected context'
        : 'selected context';
    const controlSnapshotEvidence = input.queryStatus === 'stale'
        ? 'last-known control snapshot'
        : 'control snapshot';
    const controlSelection = resolveControlRunSelection({
        explicitControlRunId: input.urlState.controlRunId,
        bootstrapRunId: input.bootstrapRunId,
        runs,
        hasSnapshot,
        snapshotEvidence,
        findControlRun
    });
    const issues: RecipeConsoleControlSelectionIssue[] = [...controlSelection.issues];
    const controlRunId = controlSelection.controlRunId;
    const controlRun = controlSelection.controlRun;
    const controlRunSource = controlSelection.controlRunSource;
    const urlReplacePatch = controlSelection.urlReplacePatch;
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
            distributedCandidate
                ? {
                    field: 'distributedRunId',
                    code: 'incompatible',
                    message:
                        `Distributed run ${distributedRunId} belongs to another control run in the ${snapshotEvidence}.`,
                    value: distributedRunId
                }
                : {
                    field: 'distributedRunId',
                    code: 'unavailable',
                    message: `Distributed run ${distributedRunId} is not available in the ${selectedContextEvidence}.`,
                    value: distributedRunId
                }
        );
    }
    if (hasSnapshot && !hasDistributedRunCollection) {
        issues.push({
            field: 'distributedRuns',
            code: 'unavailable',
            message: `The ${controlSnapshotEvidence} does not include distributed-run context.`
        });
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
        issues.push({
            field: 'agentId',
            code: 'unavailable',
            message: `Agent ${agentId} is not present in the selected control run in the ${snapshotEvidence}.`,
            value: agentId
        });
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
    const boardRows = computeControlAgentBoardRows({
        run: controlRun,
        group: groupContext.group,
        distributedRuns,
        selectedDistributedRun: distributedRun,
        requiredCommandKinds: [],
        requiredRecipes: [],
        monitorAgentProgress: [],
        nowEpochMs: input.nowEpochMs,
        staleAfterMs: CONTROL_AGENT_BOARD_STALE_AFTER_MS,
        snapshot: input.snapshot,
        selectionIndex
    });
    const boardSummary = computeControlAgentBoardSummary(boardRows);
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

type ControlRunSelection = Readonly<{
    /** Absent when no URL, bootstrap or sole control run names one. */
    controlRunId?: string;
    /** Absent when the named control run is not in this snapshot. */
    controlRun?: ControlRunSnapshot;
    /** Absent with `controlRunId`. */
    controlRunSource?: RecipeConsoleControlSelection['controlRunSource'];
    /** Absent unless the console resolved a run the URL does not yet name. */
    urlReplacePatch?: Partial<RecipeConsoleUrlState>;
    issues: readonly RecipeConsoleControlSelectionIssue[];
}>;

function resolveControlRunSelection(
    input: Readonly<{
        /** Absent when the URL names no control run. */
        explicitControlRunId?: string;
        /** Absent when the console was not bootstrapped with a run. */
        bootstrapRunId?: string;
        runs: readonly ControlRunSnapshot[];
        hasSnapshot: boolean;
        snapshotEvidence: string;
        findControlRun(runId: string): ControlRunSnapshot | undefined;
    }>
): ControlRunSelection {
    const explicitControlRunId = input.explicitControlRunId;
    if (explicitControlRunId) {
        const controlRun = input.findControlRun(explicitControlRunId);
        return {
            controlRunId: explicitControlRunId,
            controlRun,
            controlRunSource: 'url',
            issues: input.hasSnapshot && !controlRun
                ? [{
                    field: 'controlRunId',
                    code: 'unavailable',
                    message: `Control run ${explicitControlRunId} is not present in the ${input.snapshotEvidence}.`,
                    value: explicitControlRunId
                }]
                : []
        };
    }
    const bootstrapRun = input.bootstrapRunId
        ? input.findControlRun(input.bootstrapRunId)
        : undefined;
    if (bootstrapRun) {
        return {
            controlRunId: bootstrapRun.runId,
            controlRun: bootstrapRun,
            controlRunSource: 'bootstrap',
            urlReplacePatch: { controlRunId: bootstrapRun.runId },
            issues: []
        };
    }
    if (input.runs.length === 1) {
        const soleRun = input.runs[0];
        return {
            controlRunId: soleRun.runId,
            controlRun: soleRun,
            controlRunSource: 'sole-run',
            urlReplacePatch: { controlRunId: soleRun.runId },
            issues: []
        };
    }
    return {
        issues: input.runs.length > 1
            ? [{
                field: 'controlRunId',
                code: 'ambiguous',
                message: 'Multiple control runs are available; select one explicitly.'
            }]
            : []
    };
}
