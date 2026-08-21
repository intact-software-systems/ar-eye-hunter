import type { ControlSnapshotSelectionIndex } from '@shared-test/rallar-bb-test/control-snapshot-selection-index.ts';
import type {
    RallarBlackBoxDistributedGroupRef,
    RallarBlackBoxDistributedRunState
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { RallarBlackBoxTestCommandKind, RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/types.ts';
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
    snapshot?: ControlServerSnapshot;
    selectionIndex?: ControlSnapshotSelectionIndex;
}>;
