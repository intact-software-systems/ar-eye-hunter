import type {
    ControlCommandEnvelope,
    ControlEventEnvelope,
    ControlHeartbeatEnvelope,
    ControlResultEnvelope,
} from './control-protocol.ts';
import type {
    RallarBlackBoxControlAgentIdentity,
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedRunRollup,
    RallarBlackBoxDistributedRunState,
    RallarBlackBoxDistributedTargetResolution,
} from './distributed-run.ts';
import type {
    ControlFleetAgentRunOutcome,
    ControlFleetAggregateReport,
    ControlFleetFailureSignature,
    ControlFleetReportBundle,
    ControlFleetReportsResponse,
    ControlFleetRunReport,
    ControlFleetTimingDistribution,
} from './fleet-report.ts';

export type ControlQueuedCommandSnapshot = Readonly<{
    envelope: ControlCommandEnvelope;
    queuedAtEpochMs: number;
    dispatchedAtEpochMs?: number;
    completedAtEpochMs?: number;
    dispatchCount: number;
}>;

export type ControlAgentSnapshot = Readonly<{
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
    completedCommandIds: readonly string[];
    resumeCompletedCommandIds: readonly string[];
}>;

export type ControlRunToken = Readonly<{
    runId: string;
    agentId: string;
    token: string;
    issuedAtEpochMs: number;
    expiresAtEpochMs: number;
}>;

export type ControlRunSnapshot = Readonly<{
    runId: string;
    createdAtEpochMs: number;
    updatedAtEpochMs: number;
    agents: readonly ControlAgentSnapshot[];
    commands: readonly ControlQueuedCommandSnapshot[];
    results: readonly ControlResultEnvelope[];
    events: readonly ControlEventEnvelope[];
    stats: readonly ControlEventEnvelope[];
    reports: readonly ControlEventEnvelope[];
    heartbeats: readonly ControlHeartbeatEnvelope[];
}>;

export type ControlDistributedRunCommandPhase = 'stage' | 'barrier' | 'start' | 'cancel';

export type ControlDistributedRunCommandLink = Readonly<{
    phase: ControlDistributedRunCommandPhase;
    agentId: string;
    commandId: string;
    recipeId?: string;
    role?: string;
    queuedAtEpochMs: number;
}>;

export type ControlDistributedRunSnapshot = Readonly<{
    distributedRunId: string;
    controlRunId: string;
    manifest: RallarBlackBoxDistributedRunManifest;
    state: RallarBlackBoxDistributedRunState;
    createdAtEpochMs: number;
    updatedAtEpochMs: number;
    stagedAtEpochMs?: number;
    barrierStartedAtEpochMs?: number;
    barrierCompletedAtEpochMs?: number;
    startedAtEpochMs?: number;
    cancelledAtEpochMs?: number;
    completedAtEpochMs?: number;
    targetAgentIds: readonly string[];
    targetResolution?: RallarBlackBoxDistributedTargetResolution;
    commandLinks: readonly ControlDistributedRunCommandLink[];
    rollup: RallarBlackBoxDistributedRunRollup;
    error?: Readonly<{
        code: string;
        message: string;
        details?: unknown;
    }>;
}>;

export type ControlDistributedRunListResponse = Readonly<{
    distributedRuns: readonly ControlDistributedRunSnapshot[];
}>;

export type ControlServerSnapshot = Readonly<{
    runs: readonly ControlRunSnapshot[];
    distributedRuns?: readonly ControlDistributedRunSnapshot[];
    fleetReports?: readonly ControlFleetRunReport[];
}>;

export type ControlSnapshotBounds = Readonly<{
    commands?: number;
    results?: number;
    events?: number;
    stats?: number;
    reports?: number;
    heartbeats?: number;
}>;

export type ControlRunSnapshotBounds = ControlSnapshotBounds;

export type ControlRunArtifactFileName =
    | 'report.json'
    | 'results.jsonl'
    | 'events.jsonl'
    | 'failures.json'
    | 'metadata.json';

export type ControlRunArtifactBundle = Readonly<{
    artifactSchemaVersion: number;
    runId: string;
    generatedAtEpochMs: number;
    files: Readonly<Record<ControlRunArtifactFileName, string>>;
}>;

export type ControlDistributedRunArtifactFileName =
    | 'distributed-run.json'
    | 'manifest.json'
    | 'target-resolution.json'
    | 'control-run.json'
    | 'report.json'
    | 'results.jsonl'
    | 'events.jsonl'
    | 'failures.json'
    | 'metadata.json';

export type ControlDistributedRunArtifactBaseFileName =
    | 'distributed-run.json'
    | 'manifest.json'
    | 'control-run.json';

export type ControlDistributedRunArtifactBundle = Readonly<{
    artifactSchemaVersion: 1 | 2 | number;
    distributedRunId: string;
    generatedAtEpochMs: number;
    files: Readonly<
        Record<ControlDistributedRunArtifactBaseFileName, string> &
            Partial<Record<ControlDistributedRunArtifactFileName, string>>
    >;
}>;

export type ControlRunArtifactSummary = Readonly<{
    total: number;
    success: number;
    failure: number;
    commandCount: number;
    eventCount: number;
    agentCount: number;
    reportCount: number;
}>;

export type ControlRunFailureBundle = Readonly<{
    summary: ControlRunArtifactSummary;
    failures: readonly Record<string, unknown>[];
    outputs: Record<string, unknown>;
}>;

export type ControlFleetReportFilter = Readonly<{
    region?: string;
    provider?: string;
    recipeId?: string;
    groupId?: string;
    state?: string;
    fromEpochMs?: number;
    toEpochMs?: number;
}>;

export type {
    ControlFleetAgentRunOutcome,
    ControlFleetAggregateReport,
    ControlFleetFailureSignature,
    ControlFleetReportBundle,
    ControlFleetReportsResponse,
    ControlFleetRunReport,
    ControlFleetTimingDistribution,
};
