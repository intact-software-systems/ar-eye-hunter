import { isDistributedRunTerminalState } from
    '@shared-test/rallar-bb-test/distributed-run.ts';
import {
    rebindControlAgentFromSelectionIndex,
    rebindControlRunFromSelectionIndex,
    rebindDistributedRunFromSelectionIndex,
    rebindDistributedRunsFromSelectionIndex,
    type ControlSnapshotSelectionIndex,
} from '@shared-test/rallar-bb-test/control-snapshot-selection-index.ts';
import type {
    ControlAgentSnapshot,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot,
} from '../../control-run-manager.ts';
import { isControlSelectionIndexBoundToSnapshot } from
    '../../control-selection-index-binding.ts';

export type IndexedRecipeConsoleControlSelectionWork = Readonly<{
    indexed: true;
    fallback: false;
    controlRunLookupCount: number;
    distributedRunLookupCount: number;
    agentLookupCount: number;
    activeRunProjectionCount: number;
}>;

type MutableWork = {
    -readonly [Key in keyof IndexedRecipeConsoleControlSelectionWork]:
        IndexedRecipeConsoleControlSelectionWork[Key];
};

export type ControlSelectionIndexProjection =
    | Readonly<{ kind: 'fallback' }>
    | Readonly<{
        kind: 'indexed';
        index: ControlSnapshotSelectionIndex;
        work: MutableWork;
        valid(): boolean;
        findControlRun(runId: string): ControlRunSnapshot | undefined;
        findDistributedRun(
            distributedRunId: string,
        ): ControlDistributedRunSnapshot | undefined;
        findAgent(
            controlRunId: string,
            agentId: string,
        ): ControlAgentSnapshot | undefined;
        activeRuns(controlRunId: string): readonly ControlDistributedRunSnapshot[];
    }>;

export function createControlSelectionIndexProjection(input: Readonly<{
    snapshot: ControlServerSnapshot;
    index: ControlSnapshotSelectionIndex;
}>): ControlSelectionIndexProjection {
    const { index, snapshot } = input;
    const distributedRuns = snapshot.distributedRuns ?? [];
    if (
        !isControlSelectionIndexBoundToSnapshot(snapshot, index) ||
        index.controlRunIdsByOrdinal.length !== snapshot.runs.length ||
        index.distributedRunIdsByOrdinal.length !== distributedRuns.length ||
        index.hasDistributedRunCollection !==
            (snapshot.distributedRuns !== undefined)
    ) {
        return Object.freeze({ kind: 'fallback' });
    }

    let valid = true;
    const work: MutableWork = {
        indexed: true,
        fallback: false,
        controlRunLookupCount: 0,
        distributedRunLookupCount: 0,
        agentLookupCount: 0,
        activeRunProjectionCount: 0,
    };
    return {
        kind: 'indexed',
        index,
        work,
        valid: () => valid,
        findControlRun(runId) {
            work.controlRunLookupCount += 1;
            if (!index.firstControlRunOrdinalById.has(runId)) return undefined;
            const run = rebindControlRunFromSelectionIndex(index, snapshot, runId);
            if (!run) valid = false;
            return run;
        },
        findDistributedRun(distributedRunId) {
            work.distributedRunLookupCount += 1;
            if (!index.firstDistributedRunOrdinalById.has(distributedRunId)) {
                return undefined;
            }
            const run = rebindDistributedRunFromSelectionIndex(
                index,
                snapshot,
                distributedRunId,
            );
            if (!run) valid = false;
            return run;
        },
        findAgent(controlRunId, agentId) {
            work.agentLookupCount += 1;
            const hasAgent = index.firstAgentOrdinalByControlRunId
                .get(controlRunId)?.has(agentId) === true;
            if (!hasAgent) return undefined;
            const agent = rebindControlAgentFromSelectionIndex(
                index,
                snapshot,
                controlRunId,
                agentId,
            );
            if (!agent) valid = false;
            return agent;
        },
        activeRuns(controlRunId) {
            const ordinals = index.activeDistributedRunOrdinalsByControlRunId
                .get(controlRunId) ?? [];
            const runs = rebindDistributedRunsFromSelectionIndex(
                index,
                snapshot,
                ordinals,
            );
            work.activeRunProjectionCount += runs.length;
            if (
                runs.length !== ordinals.length ||
                runs.some(run => isDistributedRunTerminalState(run.state)) ||
                !isUpdatedRunOrder(runs)
            ) {
                valid = false;
            }
            return runs;
        },
    };
}

function isUpdatedRunOrder(
    runs: readonly ControlDistributedRunSnapshot[],
): boolean {
    for (let ordinal = 1; ordinal < runs.length; ordinal += 1) {
        const previous = runs[ordinal - 1]!;
        const current = runs[ordinal]!;
        if (
            previous.updatedAtEpochMs < current.updatedAtEpochMs ||
            previous.updatedAtEpochMs === current.updatedAtEpochMs &&
                previous.distributedRunId.localeCompare(current.distributedRunId) > 0
        ) return false;
    }
    return true;
}
