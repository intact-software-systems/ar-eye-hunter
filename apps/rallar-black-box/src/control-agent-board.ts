import type {
    RallarBlackBoxTestCommandKind,
    RallarBlackBoxTestRecipe,
} from '@shared-test/rallar-bb-test/types.ts';
import {
    isDistributedRunTerminalState,
    type RallarBlackBoxDistributedGroupRef,
    type RallarBlackBoxDistributedRunState,
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import {
    controlRunAgentRows,
    type ControlDistributedRunCommandPhase,
    type ControlDistributedRunSnapshot,
    type ControlRunAgentRow,
    type ControlRunSnapshot,
} from './control-run-manager.ts';
import {
    distributedRecipeTargetRows,
    type DistributedRecipeTargetRow,
    type DistributedRunAgentProgressRow,
    type DistributedRunProgressStatus,
} from './distributed-recipes.ts';

export type ControlAgentBoardTargetStatus =
    | DistributedRecipeTargetRow['status']
    | 'missing-agent'
    | 'not-scoped';

export type ControlAgentRunParticipation = Readonly<{
    distributedRunId: string;
    controlRunId: string;
    state: RallarBlackBoxDistributedRunState;
    active: boolean;
    selected: boolean;
    role?: string;
    commandPhases: readonly ControlDistributedRunCommandPhase[];
    commandCount: number;
    blockingFailures: number;
    updatedAtEpochMs: number;
    readiness?: DistributedRunProgressStatus;
    barrier?: DistributedRunProgressStatus;
    execution?: DistributedRunProgressStatus;
    completedCommandCount?: number;
    failedCommandCount?: number;
    resultCount?: number;
    eventCount?: number;
    averageLatencyMs?: number;
    lastActivityAtEpochMs?: number;
}>;

export type ControlAgentBoardRow = Readonly<{
    agentId: string;
    synthetic: boolean;
    connected: boolean;
    connectionStatus: string;
    lastSeenAtEpochMs?: number;
    lastHeartbeatAtEpochMs?: number;
    heartbeatAgeMs?: number;
    identity: ControlRunAgentRow['identity'] | undefined;
    identitySummary?: string;
    principalId?: string;
    username?: string;
    sessionId?: string;
    applicationId?: string;
    workspaceId?: string;
    groupId?: string;
    providerMode?: string;
    browserLabel?: string;
    sessionLabel?: string;
    region?: string;
    provider?: string;
    datacenter?: string;
    hostId?: string;
    browserName?: string;
    browserVersion?: string;
    os?: string;
    tags: readonly string[];
    crdtSupported?: boolean;
    crdtTransports: readonly string[];
    targetStatus: ControlAgentBoardTargetStatus;
    targetable: boolean;
    targetReason: string;
    queuedCommandCount: number;
    completedCommandCount: number;
    receivedResultCount: number;
    receivedEventCount: number;
    reconnectCount: number;
    activeRuns: readonly ControlAgentRunParticipation[];
    selectedRun?: ControlAgentRunParticipation;
}>;

export type ControlAgentBoardSummary = Readonly<{
    total: number;
    connected: number;
    targetable: number;
    active: number;
    selected: number;
    stale: number;
    offline: number;
    wrongGroup: number;
    missingIdentity: number;
    missingCapability: number;
    synthetic: number;
}>;

export type DeriveControlAgentBoardRowsInput = Readonly<{
    run: ControlRunSnapshot | undefined;
    group?: RallarBlackBoxDistributedGroupRef;
    agentIds?: readonly string[];
    requiredCommandKinds?: readonly RallarBlackBoxTestCommandKind[];
    requiredRecipes?: readonly RallarBlackBoxTestRecipe[];
    distributedRuns?: readonly ControlDistributedRunSnapshot[];
    selectedDistributedRun?: ControlDistributedRunSnapshot;
    monitorAgentProgress?: readonly DistributedRunAgentProgressRow[];
    nowEpochMs?: number;
    staleAfterMs?: number;
}>;

export function deriveControlAgentBoardRows(
    input: DeriveControlAgentBoardRowsInput,
): readonly ControlAgentBoardRow[] {
    const nowEpochMs = input.nowEpochMs ?? Date.now();
    const scopedAgentIds = input.agentIds
        ? new Set(input.agentIds)
        : undefined;
    const agentRows = controlRunAgentRows(input.run)
        .filter((row) => !scopedAgentIds || scopedAgentIds.has(row.agentId));
    const targetRows = input.group
        ? distributedRecipeTargetRows({
            run: input.run,
            group: input.group,
            requiredCommandKinds: input.requiredCommandKinds ?? [],
            requiredRecipes: input.requiredRecipes ?? [],
            nowEpochMs,
            staleAfterMs: input.staleAfterMs,
        })
        : [];
    const targetRowsByAgentId = new Map(
        targetRows.map((row) => [row.agentId, row]),
    );
    const progressByAgentId = new Map(
        (input.monitorAgentProgress ?? []).map((row) => [row.agentId, row]),
    );
    const currentControlRunId =
        input.run?.runId ?? input.selectedDistributedRun?.controlRunId;
    const distributedRuns = uniqueRuns([
        ...(input.distributedRuns ?? []),
        ...(input.selectedDistributedRun ? [input.selectedDistributedRun] : []),
    ]).filter((run) =>
        currentControlRunId === undefined ||
        run.controlRunId === currentControlRunId
    );
    const selectedDistributedRunId =
        input.selectedDistributedRun?.distributedRunId;

    const rows = agentRows.map((agentRow) =>
        controlAgentBoardRow({
            agentRow,
            targetRow: targetRowsByAgentId.get(agentRow.agentId),
            nowEpochMs,
            runs: distributedRuns,
            selectedDistributedRunId,
            progressByAgentId,
            synthetic: false,
        })
    );

    const knownAgentIds = new Set(rows.map((row) => row.agentId));
    const syntheticRows = (input.selectedDistributedRun?.targetAgentIds ?? [])
        .filter((agentId) => !scopedAgentIds || scopedAgentIds.has(agentId))
        .filter((agentId) => !knownAgentIds.has(agentId))
        .map((agentId) =>
            controlAgentBoardRow({
                agentRow: syntheticAgentRow(agentId),
                targetRow: undefined,
                nowEpochMs,
                runs: distributedRuns,
                selectedDistributedRunId,
                progressByAgentId,
                synthetic: true,
            })
        );

    return [...rows, ...syntheticRows].sort(controlAgentBoardRowSort);
}

export function summarizeControlAgentBoardRows(
    rows: readonly ControlAgentBoardRow[],
): ControlAgentBoardSummary {
    return rows.reduce<ControlAgentBoardSummary>((summary, row) => ({
        total: summary.total + 1,
        connected: summary.connected + (row.connected ? 1 : 0),
        targetable: summary.targetable + (row.targetable ? 1 : 0),
        active: summary.active + (row.activeRuns.length > 0 ? 1 : 0),
        selected: summary.selected + (row.selectedRun ? 1 : 0),
        stale: summary.stale + (row.targetStatus === 'stale' ? 1 : 0),
        offline: summary.offline + (row.targetStatus === 'offline' ? 1 : 0),
        wrongGroup: summary.wrongGroup +
            (row.targetStatus === 'different-group' ? 1 : 0),
        missingIdentity: summary.missingIdentity +
            (row.targetStatus === 'missing-identity' ? 1 : 0),
        missingCapability: summary.missingCapability +
            (row.targetStatus === 'missing-crdt-runtime' ||
                    row.targetStatus === 'missing-crdt-transport'
                ? 1
                : 0),
        synthetic: summary.synthetic + (row.synthetic ? 1 : 0),
    }), {
        total: 0,
        connected: 0,
        targetable: 0,
        active: 0,
        selected: 0,
        stale: 0,
        offline: 0,
        wrongGroup: 0,
        missingIdentity: 0,
        missingCapability: 0,
        synthetic: 0,
    });
}

function controlAgentBoardRow(input: Readonly<{
    agentRow: ControlRunAgentRow;
    targetRow: DistributedRecipeTargetRow | undefined;
    nowEpochMs: number;
    runs: readonly ControlDistributedRunSnapshot[];
    selectedDistributedRunId?: string;
    progressByAgentId: ReadonlyMap<string, DistributedRunAgentProgressRow>;
    synthetic: boolean;
}>): ControlAgentBoardRow {
    const identity = input.agentRow.identity;
    const crdt = identity?.capabilities?.crdt;
    const participations = input.runs
        .filter((run) => run.targetAgentIds.includes(input.agentRow.agentId))
        .map((run) =>
            controlAgentRunParticipation({
                run,
                agentId: input.agentRow.agentId,
                selected: run.distributedRunId ===
                    input.selectedDistributedRunId,
                progress: input.progressByAgentId.get(input.agentRow.agentId),
            })
        );
    const selectedRun = participations.find((item) => item.selected);
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
        activeRuns: participations.filter((item) => item.active),
        selectedRun,
    };
}

function controlAgentRunParticipation(input: Readonly<{
    run: ControlDistributedRunSnapshot;
    agentId: string;
    selected: boolean;
    progress?: DistributedRunAgentProgressRow;
}>): ControlAgentRunParticipation {
    const links = input.run.commandLinks.filter((link) =>
        link.agentId === input.agentId
    );
    const progress = input.progress;

    return {
        distributedRunId: input.run.distributedRunId,
        controlRunId: input.run.controlRunId,
        state: input.run.state,
        active: !isDistributedRunTerminalState(input.run.state),
        selected: input.selected,
        role: progress?.role ?? roleForAgent(input.run, input.agentId),
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
        lastActivityAtEpochMs: progress?.lastActivityAtEpochMs,
    };
}

function roleForAgent(
    run: ControlDistributedRunSnapshot,
    agentId: string,
): string | undefined {
    return run.targetResolution?.roleAssignments.find((assignment) =>
        assignment.agentId === agentId
    )?.role ??
        run.manifest.roleAssignments?.find((assignment) =>
        assignment.agentId === agentId
    )?.role ??
        run.commandLinks.find((link) => link.agentId === agentId)?.role;
}

function syntheticAgentRow(agentId: string): ControlRunAgentRow {
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
        reconnectCount: 0,
    };
}

function uniqueRuns(
    runs: readonly ControlDistributedRunSnapshot[],
): readonly ControlDistributedRunSnapshot[] {
    const byId = new Map<string, ControlDistributedRunSnapshot>();
    runs.forEach((run) => {
        byId.set(run.distributedRunId, run);
    });
    return [...byId.values()];
}

function uniqueValues<T>(values: readonly T[]): readonly T[] {
    return values.filter((value, index) => values.indexOf(value) === index);
}

function controlAgentBoardRowSort(
    left: ControlAgentBoardRow,
    right: ControlAgentBoardRow,
): number {
    if (left.synthetic !== right.synthetic) {
        return left.synthetic ? 1 : -1;
    }
    return left.agentId.localeCompare(right.agentId);
}
