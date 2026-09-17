import type { ControlSnapshotSelectionIndex } from '@shared-test/rallar-bb-test/control-snapshot-selection-index.ts';
import type {
    RallarBlackBoxDistributedGroupRef,
    RallarBlackBoxDistributedRunState
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import type {
    RallarBlackBoxTestCommandKind,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type {
    ControlDistributedRunCommandPhase,
    ControlDistributedRunSnapshot,
    ControlRunAgentRow,
    ControlRunSnapshot,
    ControlServerSnapshot
} from './control-run-manager.ts';
import type {
    DistributedRecipeTargetRow,
    DistributedRunAgentProgressRow,
    DistributedRunProgressStatus
} from './distributed-recipes.ts';

export type ControlAgentBoardTargetStatus =
    | DistributedRecipeTargetRow['status']
    | 'missing-agent'
    | 'not-scoped';

/**
 * One agent's part in a distributed run. Every progress fact below the command counts is absent
 * when the run's monitor reports no progress row for this agent.
 */
export type ControlAgentRunParticipation = Readonly<{
    distributedRunId: string;
    controlRunId: string;
    state: RallarBlackBoxDistributedRunState;
    active: boolean;
    selected: boolean;
    /** Absent when neither the monitor nor the run's role map names a role for this agent. */
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

/**
 * One agent as the operator board shows it. Each heartbeat time is absent until the control
 * server has seen that signal, and every identity fact below is absent when the agent's own
 * registration does not report it.
 */
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
    /** Absent when the agent's registration reports no CRDT capability at all. */
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
    /** Absent when none of the agent's runs is the selected one. */
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

/** The heartbeat age at which the board calls an agent stale. */
export const CONTROL_AGENT_BOARD_STALE_AFTER_MS = 30_000;

export type ComputeControlAgentBoardRowsInput = Readonly<{
    /** The control run the rows describe, or `undefined` before the operator has loaded one. */
    run: ControlRunSnapshot | undefined;
    /** The scoped group, or `undefined` when no group is selected and no agent is targetable. */
    group: RallarBlackBoxDistributedGroupRef | undefined;
    /**
     * The agent ids the board is scoped to. Absent scopes the board to every agent of the run;
     * an empty list scopes it to none.
     */
    agentIds?: readonly string[];
    requiredCommandKinds: readonly RallarBlackBoxTestCommandKind[];
    requiredRecipes: readonly RallarBlackBoxTestRecipe[];
    distributedRuns: readonly ControlDistributedRunSnapshot[];
    /** The selected distributed run, or `undefined` when the operator has selected none. */
    selectedDistributedRun: ControlDistributedRunSnapshot | undefined;
    monitorAgentProgress: readonly DistributedRunAgentProgressRow[];
    nowEpochMs: number;
    staleAfterMs: number;
    /** The server snapshot a selection index was built from; absent without an index. */
    snapshot?: ControlServerSnapshot;
    /** A prebuilt selection index; absent when the caller reads the rows without one. */
    selectionIndex?: ControlSnapshotSelectionIndex;
}>;
