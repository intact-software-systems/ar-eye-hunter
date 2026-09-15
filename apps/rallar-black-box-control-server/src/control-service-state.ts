import type {
    ControlCommandEnvelope,
    ControlEventEnvelope,
    ControlHeartbeatEnvelope,
    ControlResultEnvelope
} from '@shared-test/rallar-bb-test/control-protocol.ts';
import type {
    ControlDistributedRunCommandLink,
    ControlDistributedRunSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    RallarBlackBoxControlAgentIdentity,
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedRunRollup,
    RallarBlackBoxDistributedRunState,
    RallarBlackBoxDistributedTargetResolution
} from '@shared-test/rallar-bb-test/distributed-run.ts';

export interface ControlCommandState {
    envelope: ControlCommandEnvelope;
    fingerprint: string;
    queuedAtEpochMs: number;
    dispatchedAtEpochMs?: number;
    completedAtEpochMs?: number;
    dispatchCount: number;
    lastDispatchedConnectionSequence?: number;
}

export interface ControlAgentState {
    runId: string;
    agentId: string;
    connected: boolean;
    registeredAtEpochMs?: number;
    disconnectedAtEpochMs?: number;
    lastSeenAtEpochMs?: number;
    lastHeartbeatAtEpochMs?: number;
    status?: string;
    identity?: RallarBlackBoxControlAgentIdentity;
    connectionSequence: number;
    reconnectCount: number;
    receivedResultCount: number;
    receivedEventCount: number;
    completedCommandIds: Set<string>;
    resumeCompletedCommandIds: Set<string>;
    commandEnqueueTimestamps: number[];
}

export interface ControlTokenState {
    runId: string;
    agentId: string;
    token: string;
    issuedAtEpochMs: number;
    expiresAtEpochMs: number;
}

export interface ControlRunState {
    runId: string;
    createdAtEpochMs: number;
    updatedAtEpochMs: number;
    agents: Map<string, ControlAgentState>;
    commands: Map<string, ControlCommandState>;
    results: Map<string, ControlResultEnvelope>;
    events: ControlEventEnvelope[];
    stats: ControlEventEnvelope[];
    reports: ControlEventEnvelope[];
    reportKeys: Set<string>;
    heartbeats: ControlHeartbeatEnvelope[];
    tokens: Map<string, ControlTokenState>;
    retentionRevision: number;
    issuedRunTokenStateRevision: number;
}

export interface ControlDistributedRunState {
    distributedRunId: string;
    controlRunId: string;
    manifest: RallarBlackBoxDistributedRunManifest;
    state: RallarBlackBoxDistributedRunState;
    rollup?: RallarBlackBoxDistributedRunRollup;
    createdAtEpochMs: number;
    updatedAtEpochMs: number;
    stagedAtEpochMs?: number;
    barrierStartedAtEpochMs?: number;
    barrierCompletedAtEpochMs?: number;
    startedAtEpochMs?: number;
    cancelledAtEpochMs?: number;
    completedAtEpochMs?: number;
    targetAgentIds: string[];
    targetResolution?: RallarBlackBoxDistributedTargetResolution;
    commandLinks: ControlDistributedRunCommandLink[];
    error?: ControlDistributedRunSnapshot['error'];
}
