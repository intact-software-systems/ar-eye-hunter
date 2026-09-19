import {
    rebindCommandLinksFromSelectionIndex,
    rebindControlAgentsFromSelectionIndex,
    rebindControlRunFromSelectionIndex,
    type ControlSnapshotSelectionIndex
} from '@shared-test/rallar-bb-test/control-snapshot-selection-index.ts';
import type {
    ControlDistributedRunSnapshot,
    ControlServerSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    ComputeControlAgentBoardRowsInput,
    ControlAgentBoardRow,
    ControlAgentRunParticipation
} from './control-agent-board-contract.ts';
import {
    controlAgentBoardRowFromParticipations,
    controlAgentBoardRowSort,
    controlAgentRunParticipation,
    syntheticControlAgentRow
} from './control-agent-board-model.ts';
import { projectRelevantControlAgentBoardRuns, type IndexedBoardRun } from './control-agent-board-run-projection.ts';
import type { ControlRunAgentRow } from './control-run-manager/control-run-projections.ts';
import { toControlAgentIdentitySummary } from './control-run-manager/to-control-agent-identity-summary.ts';
import { distributedRecipeTargetRows } from './distributed-recipes.ts';

/**
 * The board rows read through the caller's selection index, or `undefined` when the index cannot
 * prove the snapshot it was built from still holds — the caller then reads the snapshot directly.
 */
export function computeIndexedControlAgentBoardRows(
    input: ComputeControlAgentBoardRowsInput
): readonly ControlAgentBoardRow[] | undefined {
    const { run, selectionIndex, snapshot } = input;
    if (!selectionIndex || !snapshot) {
        return undefined;
    }
    if (!run && !input.selectedDistributedRun) {
        return [];
    }
    const distributedRunsMatch = snapshot.distributedRuns === input.distributedRuns ||
        (snapshot.distributedRuns === undefined && input.distributedRuns.length === 0);
    if (
        !run ||
        !distributedRunsMatch ||
        rebindControlRunFromSelectionIndex(selectionIndex, snapshot, run.runId) !== run
    ) {
        return undefined;
    }
    const selected = input.selectedDistributedRun;
    const selectedOrdinal = selected
        ? resolveProvenSelectedDistributedRunOrdinal(selectionIndex, snapshot, selected)
        : undefined;
    if (selected && selectedOrdinal === undefined) {
        return undefined;
    }

    const sortedAgentOrdinals = selectionIndex.controlAgentOrdinalsByControlRunIdSorted.get(run.runId) ?? [];
    const agents = rebindControlAgentsFromSelectionIndex(
        selectionIndex,
        snapshot,
        run.runId,
        sortedAgentOrdinals
    );
    if (agents.length !== sortedAgentOrdinals.length) {
        return undefined;
    }
    const agentRows: readonly ControlRunAgentRow[] = agents.map((agent) => ({
        agentId: agent.agentId,
        connected: agent.connected,
        status: agent.status ?? (agent.connected ? 'connected' : 'offline'),
        lastSeenAtEpochMs: agent.lastSeenAtEpochMs,
        lastHeartbeatAtEpochMs: agent.lastHeartbeatAtEpochMs,
        identity: agent.identity,
        identitySummary: toControlAgentIdentitySummary(agent.identity),
        queuedCommandCount: selectionIndex.queuedControlCommandCountByControlRunAgentId
            .get(run.runId)?.get(agent.agentId) ?? 0,
        completedCommandCount: agent.completedCommandIds.length,
        receivedResultCount: agent.receivedResultCount,
        receivedEventCount: agent.receivedEventCount,
        reconnectCount: agent.reconnectCount
    }));
    const scopedAgentIds = input.agentIds ? new Set(input.agentIds) : undefined;
    const scopedAgentRows = agentRows.filter((row) => !scopedAgentIds || scopedAgentIds.has(row.agentId));
    const nowEpochMs = input.nowEpochMs;
    const targetRows = input.group
        ? distributedRecipeTargetRows({
            run,
            group: input.group,
            requiredCommandKinds: input.requiredCommandKinds,
            requiredRecipes: input.requiredRecipes,
            nowEpochMs,
            staleAfterMs: input.staleAfterMs
        })
        : [];
    const targetRowsByAgentId = new Map(
        targetRows.map((row) => [row.agentId, row])
    );
    const progressByAgentId = new Map(
        input.monitorAgentProgress.map((row) => [row.agentId, row])
    );

    const relevantRuns = projectRelevantControlAgentBoardRuns({
        index: selectionIndex,
        snapshot,
        controlRunId: run.runId,
        selected,
        selectedOrdinal
    });
    if (!relevantRuns) {
        return undefined;
    }
    const relevantRunsByAgentId = toRelevantRunsByAgentId(relevantRuns);
    let topologyMismatch = false;
    const toAgentRunParticipations = (
        agentId: string
    ): readonly ControlAgentRunParticipation[] =>
        (relevantRunsByAgentId.get(agentId) ?? []).map((indexedRun) => {
            const linkOrdinals = selectionIndex.commandLinkOrdinalsByDistributedRunOrdinal
                .get(indexedRun.ordinal)?.get(agentId) ?? [];
            const links = rebindCommandLinksFromSelectionIndex(
                selectionIndex,
                snapshot,
                indexedRun.ordinal,
                linkOrdinals
            );
            if (links.length !== linkOrdinals.length) {
                topologyMismatch = true;
            }
            return controlAgentRunParticipation({
                run: indexedRun.run,
                agentId,
                selected: indexedRun.run.distributedRunId ===
                    selected?.distributedRunId,
                progress: progressByAgentId.get(agentId),
                links,
                indexedRole: selectionIndex.boardRoleByAgentIdByDistributedRunOrdinal
                    .get(indexedRun.ordinal)?.get(agentId),
                roleIndexed: true
            });
        });

    const rows = scopedAgentRows.map((agentRow) =>
        controlAgentBoardRowFromParticipations({
            agentRow,
            targetRow: targetRowsByAgentId.get(agentRow.agentId),
            nowEpochMs,
            participations: toAgentRunParticipations(agentRow.agentId),
            synthetic: false
        })
    );
    const knownAgentIds = new Set(rows.map((row) => row.agentId));
    const syntheticRows = (selected?.targetAgentIds ?? [])
        .filter((agentId) => !scopedAgentIds || scopedAgentIds.has(agentId))
        .filter((agentId) => !knownAgentIds.has(agentId))
        .map((agentId) =>
            controlAgentBoardRowFromParticipations({
                agentRow: syntheticControlAgentRow(agentId),
                targetRow: undefined,
                nowEpochMs,
                participations: toAgentRunParticipations(agentId),
                synthetic: true
            })
        );
    if (topologyMismatch) {
        return undefined;
    }
    return [...rows, ...syntheticRows].sort(controlAgentBoardRowSort);
}

function toRelevantRunsByAgentId(
    relevantRuns: readonly IndexedBoardRun[]
): ReadonlyMap<string, readonly IndexedBoardRun[]> {
    const byAgentId = new Map<string, IndexedBoardRun[]>();
    for (const indexedRun of relevantRuns) {
        const seenAgentIds = new Set<string>();
        for (const agentId of indexedRun.run.targetAgentIds) {
            if (seenAgentIds.has(agentId)) {
                continue;
            }
            seenAgentIds.add(agentId);
            const current = byAgentId.get(agentId);
            if (current) {
                current.push(indexedRun);
            }
            else {
                byAgentId.set(agentId, [indexedRun]);
            }
        }
    }
    return byAgentId;
}

function resolveProvenSelectedDistributedRunOrdinal(
    index: ControlSnapshotSelectionIndex,
    snapshot: ControlServerSnapshot,
    selected: ControlDistributedRunSnapshot
): number | undefined {
    const distributedRuns = snapshot.distributedRuns;
    if (!distributedRuns) {
        return undefined;
    }
    const first = index.firstDistributedRunOrdinalById.get(
        selected.distributedRunId
    );
    if (first !== undefined && distributedRuns[first] === selected) {
        return first;
    }
    const winner = index.boardSourceWinnerOrdinalByDistributedRunId.get(
        selected.distributedRunId
    );
    return winner !== undefined && distributedRuns[winner] === selected
        ? winner
        : undefined;
}
