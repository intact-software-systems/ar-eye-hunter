import type { RallarBlackBoxCompositeChildDecodeIssue } from '../composite-results.ts';
import type { ControlDistributedRunCommandLink } from '../control-snapshots.ts';
import type {
    RallarBlackBoxTestCommandKind,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestSeverity,
    RallarBlackBoxTestTransport
} from '../rallar-black-box-test-contracts.ts';

export type DistributedRunProgressStatus =
    | 'pending'
    | 'queued'
    | 'running'
    | 'ready'
    | 'passed'
    | 'failed'
    | 'cancelled'
    | 'missing';

export type DistributedRunTimelineItem = Readonly<{
    id: string;
    atEpochMs: number;
    kind: 'lifecycle' | 'command' | 'result' | 'event' | 'diagnostic' | 'failure' | 'artifact';
    label: string;
    detail?: string;
    tone: string;
    agentId?: string;
    recipeId?: string;
    commandId?: string;
    phase?: ControlDistributedRunCommandLink['phase'];
}>;

export type DistributedRunAgentProgressRow = Readonly<{
    agentId: string;
    role?: string;
    readiness: DistributedRunProgressStatus;
    barrier: DistributedRunProgressStatus;
    execution: DistributedRunProgressStatus;
    stageCommandCount: number;
    barrierCommandCount: number;
    startCommandCount: number;
    completedCommandCount: number;
    failedCommandCount: number;
    resultCount: number;
    eventCount: number;
    averageLatencyMs?: number;
    lastActivityAtEpochMs?: number;
}>;

export type DistributedRunRecipeProgressRow = Readonly<{
    recipeId: string;
    profile?: string;
    role?: string;
    targetCount: number;
    queuedCount: number;
    runningCount: number;
    passedCount: number;
    failedCount: number;
    missingCount: number;
    averageLatencyMs?: number;
}>;

export type DistributedRunReadinessRow = Readonly<{
    agentId: string;
    role?: string;
    status: DistributedRunProgressStatus;
    commandId?: string;
    queuedAtEpochMs?: number;
    completedAtEpochMs?: number;
    latencyMs?: number;
    error?: string;
}>;

export type DistributedRunFailureRow = Readonly<{
    kind: 'run' | 'participant' | 'recipe' | 'group-assertion' | 'command';
    key: string;
    message: string;
    code?: string;
    agentId?: string;
    recipeId?: string;
    commandId?: string;
    atEpochMs?: number;
}>;

export type DistributedRunEventRow = Readonly<{
    eventId: string;
    atEpochMs: number;
    kind: string;
    agentId: string;
    commandId?: string;
    topic?: string;
    summary: string;
    payloadSummary: string;
}>;

export type DistributedRunRuntimeDiagnosticRow = Readonly<{
    eventId: string;
    atEpochMs: number;
    severity: RallarBlackBoxTestSeverity;
    agentId: string;
    commandId?: string;
    transport?: RallarBlackBoxTestTransport;
    topic: string;
    diagnosticTypeId: string;
    message: string;
    summary: string;
    payloadSummary: string;
    connection?: string;
    actor?: string;
    groupId?: string;
    roomId?: string;
    laneId?: string;
    peerId?: string;
    remotePeerId?: string;
    senderId?: string;
    typeId?: string;
    topicId?: string;
    contextId?: string;
    resourceId?: string;
    source?: string;
    correlatedFailureKeys: readonly string[];
}>;

export type DistributedRunRuntimeDiagnosticCounts = Readonly<{
    total: number;
    info: number;
    warning: number;
    error: number;
    ws: number;
    rtc: number;
    http: number;
    runtime: number;
}>;

export type DistributedRunLatencySummary = Readonly<{
    count: number;
    minMs?: number;
    p50Ms?: number;
    p95Ms?: number;
    maxMs?: number;
    averageMs?: number;
}>;

export type DistributedRunArtifactValidationStatus =
    | 'not-loaded'
    | 'valid'
    | 'missing-file'
    | 'invalid-json';

export type DistributedRunArtifactValidation = Readonly<{
    status: DistributedRunArtifactValidationStatus;
    fileCount: number;
    message: string;
}>;

export type DistributedRunCompositeCounts = Readonly<{
    total: number;
    passed: number;
    failed: number;
    childResults: number;
    composite: number;
    leaf: number;
}>;

export type DistributedRunCompositeSummary = Readonly<{
    total: number;
    passed: number;
    failed: number;
    cancelled: number;
    skipped: number;
    composite: number;
    leaf: number;
}>;

export type DistributedRunCompositeRow = Readonly<{
    path: string;
    sourceRecipePath: string;
    parentPath?: string;
    parentCommandId?: string;
    depth: number;
    childIndex?: number;
    commandIndex?: number;
    iteration?: number;
    groupId?: string;
    groupIndex?: number;
    originalCommandId?: string;
    commandId: string;
    kind: RallarBlackBoxTestResult['kind'];
    status: RallarBlackBoxTestResult['status'];
    ok: boolean;
    startedAtEpochMs: number;
    endedAtEpochMs: number;
    durationMs: number;
    summary: string;
    detail?: string;
    errorSummary?: string;
    valueSummary?: string;
}>;

export type DistributedRunCompositeGroupSummary = Readonly<{
    parentPath: string;
    parentCommandId: string;
    groupId: string;
    groupIndex: number;
    commandCount: number;
    passed: number;
    failed: number;
    cancelled: boolean;
    durationMs: number;
    status: 'passed' | 'failed' | 'cancelled' | 'empty';
}>;

export interface DistributedRunCompositeChildDecodeIssueRow extends RallarBlackBoxCompositeChildDecodeIssue {
    readonly parentPath: string;
    readonly parentCommandId: string;
    readonly parentEndedAtEpochMs: number;
}

export type DistributedRunCompositeDrilldown = Readonly<{
    key: string;
    commandId: string;
    agentId: string;
    recipeId?: string;
    role?: string;
    phase?: ControlDistributedRunCommandLink['phase'];
    commandKind?: RallarBlackBoxTestCommandKind;
    artifactRef: string;
    summary: DistributedRunCompositeSummary;
    firstFailure?: DistributedRunCompositeRow;
    groupSummaries: readonly DistributedRunCompositeGroupSummary[];
    childDecodeIssues: readonly DistributedRunCompositeChildDecodeIssueRow[];
    rows: readonly DistributedRunCompositeRow[];
}>;
