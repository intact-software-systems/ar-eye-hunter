import { isDistributedRunTerminalState } from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { ControlAgentBoardRow, ControlAgentRunParticipation } from './control-agent-board-contract.ts';
import type { ControlDistributedRunSnapshot, ControlRunAgentRow } from './control-run-manager.ts';
import type { DistributedRecipeTargetRow, DistributedRunAgentProgressRow } from './distributed-recipes.ts';

export function controlAgentBoardRowFromParticipations(
    input: Readonly<{
        agentRow: ControlRunAgentRow;
        targetRow: DistributedRecipeTargetRow | undefined;
        nowEpochMs: number;
        participations: readonly ControlAgentRunParticipation[];
        synthetic: boolean;
    }>
): ControlAgentBoardRow {
    const identity = input.agentRow.identity;
    const crdt = identity?.capabilities?.crdt;
    const selectedRun = input.participations.find((item) => item.selected);
    const targetStatus = input.targetRow?.status ??
        (input.synthetic ? 'missing-agent' : 'not-scoped');

    return {
        agentId: input.agentRow.agentId,
        synthetic: input.synthetic,
        connected: input.agentRow.connected,
        connectionStatus: input.agentRow.status,
        lastSeenAtEpochMs: input.agentRow.lastSeenAtEpochMs,
        lastHeartbeatAtEpochMs: input.agentRow.lastHeartbeatAtEpochMs,
        heartbeatAgeMs: input.agentRow.lastHeartbeatAtEpochMs !== undefined
            ? Math.max(0, input.nowEpochMs - input.agentRow.lastHeartbeatAtEpochMs)
            : undefined,
        identity,
        identitySummary: input.agentRow.identitySummary,
        principalId: identity?.principalId,
        username: identity?.username,
        sessionId: identity?.sessionId,
        applicationId: identity?.applicationId,
        workspaceId: identity?.workspaceId,
        groupId: identity?.groupId,
        providerMode: identity?.providerMode,
        browserLabel: identity?.browserLabel,
        sessionLabel: identity?.sessionLabel,
        region: identity?.region,
        provider: identity?.provider,
        datacenter: identity?.datacenter,
        hostId: identity?.hostId,
        browserName: identity?.browserName,
        browserVersion: identity?.browserVersion,
        os: identity?.os,
        tags: identity?.tags ?? [],
        crdtSupported: crdt?.supported,
        crdtTransports: crdt?.transports ?? [],
        targetStatus,
        targetable: input.targetRow?.targetable ?? false,
        targetReason: input.targetRow?.reason ??
            (input.synthetic
                ? 'Target agent is part of the selected distributed run but missing from the control run snapshot.'
                : 'No target scope selected.'),
        queuedCommandCount: input.agentRow.queuedCommandCount,
        completedCommandCount: input.agentRow.completedCommandCount,
        receivedResultCount: input.agentRow.receivedResultCount,
        receivedEventCount: input.agentRow.receivedEventCount,
        reconnectCount: input.agentRow.reconnectCount,
        activeRuns: input.participations.filter((item) => item.active),
        selectedRun
    };
}

export function controlAgentRunParticipation(
    input: Readonly<{
        run: ControlDistributedRunSnapshot;
        agentId: string;
        selected: boolean;
        progress?: DistributedRunAgentProgressRow;
        links?: ControlDistributedRunSnapshot['commandLinks'];
        indexedRole?: string;
        roleIndexed?: boolean;
    }>
): ControlAgentRunParticipation {
    const links = input.links ?? input.run.commandLinks.filter((link) => link.agentId === input.agentId);
    const progress = input.progress;

    return {
        distributedRunId: input.run.distributedRunId,
        controlRunId: input.run.controlRunId,
        state: input.run.state,
        active: !isDistributedRunTerminalState(input.run.state),
        selected: input.selected,
        role: progress?.role ?? (input.roleIndexed
            ? input.indexedRole
            : roleForAgent(input.run, input.agentId)),
        commandPhases: uniqueValues(links.map((link) => link.phase)),
        commandCount: links.length,
        blockingFailures: input.run.rollup.summary.blockingFailures,
        updatedAtEpochMs: input.run.updatedAtEpochMs,
        readiness: progress?.readiness,
        barrier: progress?.barrier,
        execution: progress?.execution,
        completedCommandCount: progress?.completedCommandCount,
        failedCommandCount: progress?.failedCommandCount,
        resultCount: progress?.resultCount,
        eventCount: progress?.eventCount,
        averageLatencyMs: progress?.averageLatencyMs,
        lastActivityAtEpochMs: progress?.lastActivityAtEpochMs
    };
}

export function syntheticControlAgentRow(agentId: string): ControlRunAgentRow {
    return {
        agentId,
        connected: false,
        status: 'missing',
        identity: undefined,
        identitySummary: undefined,
        queuedCommandCount: 0,
        completedCommandCount: 0,
        receivedResultCount: 0,
        receivedEventCount: 0,
        reconnectCount: 0
    };
}

export function controlAgentBoardRowSort(
    left: ControlAgentBoardRow,
    right: ControlAgentBoardRow
): number {
    if (left.synthetic !== right.synthetic) {
        return left.synthetic ? 1 : -1;
    }
    return left.agentId.localeCompare(right.agentId);
}

function roleForAgent(
    run: ControlDistributedRunSnapshot,
    agentId: string
): string | undefined {
    return run.targetResolution?.roleAssignments.find((assignment) => assignment.agentId === agentId)?.role ??
        run.manifest.roleAssignments?.find((assignment) => assignment.agentId === agentId)?.role ??
        run.commandLinks.find((link) => link.agentId === agentId)?.role;
}

function uniqueValues<Value>(values: readonly Value[]): readonly Value[] {
    return values.filter((value, index) => values.indexOf(value) === index);
}
