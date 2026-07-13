import {
    rebindCommandLinksFromSelectionIndex,
    rebindControlAgentsFromSelectionIndex,
    rebindControlRunFromSelectionIndex,
    type ControlSnapshotSelectionIndex,
} from '@shared-test/rallar-bb-test/control-snapshot-selection-index.ts';
import {
    projectRelevantControlAgentBoardRuns,
    type IndexedBoardRun,
} from './control-agent-board-run-projection.ts';
import {
    controlAgentBoardRowFromParticipations,
    controlAgentBoardRowSort,
    controlAgentRunParticipation,
    syntheticControlAgentRow,
} from './control-agent-board-model.ts';
import type {
    ControlAgentBoardRow,
    ControlAgentRunParticipation,
    DeriveControlAgentBoardRowsInput,
} from './control-agent-board-contract.ts';
import {
    controlAgentIdentitySummary,
    type ControlDistributedRunSnapshot,
    type ControlRunAgentRow,
    type ControlServerSnapshot,
} from './control-run-manager.ts';
import { distributedRecipeTargetRows } from './distributed-recipes.ts';

export type IndexedControlAgentBoardWork = Readonly<{
    indexed: true;
    fallback: false;
    agentProjectionCount: number;
    queuedCommandLookupCount: number;
    targetMembershipLookupCount: number;
    distributedRunProjectionCount: number;
    commandLinkProjectionCount: number;
    roleLookupCount: number;
}>;

type MutableWork = {
    -readonly [Key in keyof IndexedControlAgentBoardWork]:
        IndexedControlAgentBoardWork[Key];
};

export type IndexedControlAgentBoardDerivation = Readonly<{
    rows: readonly ControlAgentBoardRow[];
    work: IndexedControlAgentBoardWork;
}>;

export function deriveIndexedControlAgentBoardRows(
    input: DeriveControlAgentBoardRowsInput,
): IndexedControlAgentBoardDerivation | undefined {
    const { run, selectionIndex, snapshot } = input;
    if (!selectionIndex || !snapshot) return undefined;
    const work = emptyWork();
    if (!run && !input.selectedDistributedRun) {
        return { rows: [], work: Object.freeze({ ...work }) };
    }
    const distributedRunsMatch = snapshot?.distributedRuns === input.distributedRuns ||
        (snapshot?.distributedRuns === undefined &&
            (input.distributedRuns?.length ?? 0) === 0);
    if (!run ||
        !distributedRunsMatch ||
        rebindControlRunFromSelectionIndex(selectionIndex, snapshot, run.runId) !== run) {
        return undefined;
    }
    const selected = input.selectedDistributedRun;
    const selectedOrdinal = selected
        ? provenSelectedDistributedRunOrdinal(selectionIndex, snapshot, selected)
        : undefined;
    if (selected && selectedOrdinal === undefined) return undefined;

    const sortedAgentOrdinals =
        selectionIndex.controlAgentOrdinalsByControlRunIdSorted.get(run.runId) ?? [];
    const agents = rebindControlAgentsFromSelectionIndex(
        selectionIndex,
        snapshot,
        run.runId,
        sortedAgentOrdinals,
    );
    if (agents.length !== sortedAgentOrdinals.length) return undefined;
    const agentRows = agents.map(agent => {
        work.agentProjectionCount += 1;
        work.queuedCommandLookupCount += 1;
        return {
            agentId: agent.agentId,
            connected: agent.connected,
            status: agent.status ?? (agent.connected ? 'connected' : 'offline'),
            lastSeenAtEpochMs: agent.lastSeenAtEpochMs,
            lastHeartbeatAtEpochMs: agent.lastHeartbeatAtEpochMs,
            identity: agent.identity,
            identitySummary: controlAgentIdentitySummary(agent.identity),
            queuedCommandCount:
                selectionIndex.queuedControlCommandCountByControlRunAgentId
                    .get(run.runId)?.get(agent.agentId) ?? 0,
            completedCommandCount: agent.completedCommandIds.length,
            receivedResultCount: agent.receivedResultCount,
            receivedEventCount: agent.receivedEventCount,
            reconnectCount: agent.reconnectCount,
        } satisfies ControlRunAgentRow;
    });
    const scopedAgentIds = input.agentIds ? new Set(input.agentIds) : undefined;
    const scopedAgentRows = agentRows.filter(row =>
        !scopedAgentIds || scopedAgentIds.has(row.agentId)
    );
    const nowEpochMs = input.nowEpochMs ?? Date.now();
    const targetRows = input.group
        ? distributedRecipeTargetRows({
            run,
            group: input.group,
            requiredCommandKinds: input.requiredCommandKinds ?? [],
            requiredRecipes: input.requiredRecipes ?? [],
            nowEpochMs,
            staleAfterMs: input.staleAfterMs,
        })
        : [];
    const targetRowsByAgentId = new Map(
        targetRows.map(row => [row.agentId, row]),
    );
    const progressByAgentId = new Map(
        (input.monitorAgentProgress ?? []).map(row => [row.agentId, row]),
    );

    const relevantRuns = projectRelevantControlAgentBoardRuns({
        index: selectionIndex,
        snapshot,
        controlRunId: run.runId,
        selected,
        selectedOrdinal,
    });
    if (!relevantRuns) return undefined;
    work.distributedRunProjectionCount += relevantRuns.length;
    const relevantRunsByAgentId = new Map<string, IndexedBoardRun[]>();
    for (const indexedRun of relevantRuns) {
        const seenAgentIds = new Set<string>();
        for (const agentId of indexedRun.run.targetAgentIds) {
            if (seenAgentIds.has(agentId)) continue;
            seenAgentIds.add(agentId);
            const current = relevantRunsByAgentId.get(agentId);
            if (current) current.push(indexedRun);
            else relevantRunsByAgentId.set(agentId, [indexedRun]);
        }
    }
    let topologyMismatch = false;
    const participationsForAgent = (
        agentId: string,
    ): readonly ControlAgentRunParticipation[] => {
        work.targetMembershipLookupCount += 1;
        return (relevantRunsByAgentId.get(agentId) ?? []).map(indexedRun => {
            const linkOrdinals = selectionIndex.commandLinkOrdinalsByDistributedRunOrdinal
                .get(indexedRun.ordinal)?.get(agentId) ?? [];
            const links = rebindCommandLinksFromSelectionIndex(
                selectionIndex,
                snapshot,
                indexedRun.ordinal,
                linkOrdinals,
            );
            work.commandLinkProjectionCount += links.length;
            if (links.length !== linkOrdinals.length) topologyMismatch = true;
            work.roleLookupCount += 1;
            return controlAgentRunParticipation({
                run: indexedRun.run,
                agentId,
                selected: indexedRun.run.distributedRunId ===
                    selected?.distributedRunId,
                progress: progressByAgentId.get(agentId),
                links,
                indexedRole: selectionIndex.boardRoleByAgentIdByDistributedRunOrdinal
                    .get(indexedRun.ordinal)?.get(agentId),
                roleIndexed: true,
            });
        });
    };

    const rows = scopedAgentRows.map(agentRow =>
        controlAgentBoardRowFromParticipations({
            agentRow,
            targetRow: targetRowsByAgentId.get(agentRow.agentId),
            nowEpochMs,
            participations: participationsForAgent(agentRow.agentId),
            synthetic: false,
        })
    );
    const knownAgentIds = new Set(rows.map(row => row.agentId));
    const syntheticRows = (selected?.targetAgentIds ?? [])
        .filter(agentId => !scopedAgentIds || scopedAgentIds.has(agentId))
        .filter(agentId => !knownAgentIds.has(agentId))
        .map(agentId =>
            controlAgentBoardRowFromParticipations({
                agentRow: syntheticControlAgentRow(agentId),
                targetRow: undefined,
                nowEpochMs,
                participations: participationsForAgent(agentId),
                synthetic: true,
            })
        );
    if (topologyMismatch) return undefined;
    return {
        rows: [...rows, ...syntheticRows].sort(controlAgentBoardRowSort),
        work: Object.freeze({ ...work }),
    };
}

function provenSelectedDistributedRunOrdinal(
    index: ControlSnapshotSelectionIndex,
    snapshot: ControlServerSnapshot,
    selected: ControlDistributedRunSnapshot,
): number | undefined {
    const distributedRuns = snapshot.distributedRuns;
    if (!distributedRuns) return undefined;
    const first = index.firstDistributedRunOrdinalById.get(
        selected.distributedRunId,
    );
    if (first !== undefined && distributedRuns[first] === selected) return first;
    const winner = index.boardSourceWinnerOrdinalByDistributedRunId.get(
        selected.distributedRunId,
    );
    return winner !== undefined && distributedRuns[winner] === selected
        ? winner
        : undefined;
}

function emptyWork(): MutableWork {
    return {
        indexed: true,
        fallback: false,
        agentProjectionCount: 0,
        queuedCommandLookupCount: 0,
        targetMembershipLookupCount: 0,
        distributedRunProjectionCount: 0,
        commandLinkProjectionCount: 0,
        roleLookupCount: 0,
    };
}
