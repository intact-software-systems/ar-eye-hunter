import type {
    RallarBlackBoxDistributedBarrierPolicy,
    RallarBlackBoxDistributedGroupRef,
    RallarBlackBoxDistributedRoleAssignment,
    RallarBlackBoxDistributedRoleAssignmentPolicy,
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedRunRecipeSelection,
    RallarBlackBoxDistributedTargetResolution,
    RallarBlackBoxDistributedTargetPolicy,
} from './distributed-run.ts';
import { RALLAR_BLACK_BOX_COMMAND_CAPABILITIES } from './schema.ts';
import {
    flattenRallarBlackBoxCompositeResults,
    summarizeRallarBlackBoxCompositeResults,
    toRallarBlackBoxCompositeDisplayResults,
} from './composite-results.ts';
import {
    RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS,
    type RallarBlackBoxTestAssertCommand,
    type RallarBlackBoxTestAssertResultValue,
    type RallarBlackBoxTestCommand,
    type RallarBlackBoxTestCrdtTransport,
    type RallarBlackBoxTestCommandKind,
    type RallarBlackBoxTestLoopResultValue,
    type RallarBlackBoxTestParallelResultValue,
    type RallarBlackBoxTestRecipe,
    type RallarBlackBoxTestResult,
    type RallarBlackBoxTestSeverity,
    type RallarBlackBoxTestTransport,
    type RallarBlackBoxTestWaitResultValue,
    type RallarBlackBoxTestWaitCommand,
} from './types.ts';
import type { RallarBlackBoxRuntimeDiagnosticPayload } from './diagnostics.ts';
import type {
    ControlAgentSnapshot,
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunCommandLink,
    ControlDistributedRunSnapshot,
    ControlSnapshotBounds,
    ControlRunSnapshot,
} from './control-snapshots.ts';

export type DistributedRecipeRolePattern =
    | 'all-agents'
    | 'sender-receiver'
    | 'one-sender-many-receivers'
    | 'three-browser-matrix';

export type DistributedRecipeTargetPolicyMode =
    | 'all-online-group-members'
    | 'selected-agents'
    | 'role-map';

export type DistributedRecipeCatalogItem = Readonly<{
    itemId: string;
    title: string;
    description: string;
    recipe: RallarBlackBoxTestRecipe;
    providerMode: string;
    profiles: readonly string[];
    prerequisites: readonly string[];
    live: boolean;
    source: 'app-local';
}>;

export type DistributedRecipeCommandPreview = Readonly<{
    manifestCommandCount: number;
    effectiveCommandCount: number;
    effectiveFrameCount?: number;
    label: string;
}>;

export type DistributedRecipePreflightServiceBadge = Readonly<{
    label: string;
    tone: string;
}>;

export type DistributedRecipePreflightLoop = Readonly<{
    path: string;
    commandId?: string;
    estimatedIterations: number;
    childCommandCount: number;
    effectiveCommandCount: number;
    count?: number;
    durationMs?: number;
    intervalMs?: number;
    maxCommands?: number;
    frameCount?: number;
}>;

export type DistributedRecipePreflightParallel = Readonly<{
    path: string;
    commandId?: string;
    groupCount: number;
    maxConcurrency: number;
    effectiveCommandCount: number;
    groups: readonly string[];
}>;

export type DistributedRecipePreflightWait = Readonly<{
    path: string;
    commandId?: string;
    matchSummary: string;
    timeoutMs?: number;
}>;

export type DistributedRecipePreflightAssert = Readonly<{
    path: string;
    commandId?: string;
    predicate: string;
}>;

export type DistributedRecipePreflightTreeRow = Readonly<{
    path: string;
    depth: number;
    kind: RallarBlackBoxTestCommandKind;
    commandId?: string;
    label: string;
    summary: string;
    effectiveCommandCount: number;
    details: readonly string[];
    warnings: readonly string[];
}>;

export type DistributedRecipePreflightSummary = Readonly<{
    recipeId: string;
    manifestCommandCount: number;
    effectiveCommandCount: number;
    effectiveFrameCount?: number;
    maxDepth: number;
    commandKinds: readonly RallarBlackBoxTestCommandKind[];
    providerModes: readonly string[];
    runtimeSurfaces: readonly string[];
    liveServiceRequirements: readonly string[];
    serviceBadges: readonly DistributedRecipePreflightServiceBadge[];
    loops: readonly DistributedRecipePreflightLoop[];
    parallelGroups: readonly DistributedRecipePreflightParallel[];
    waits: readonly DistributedRecipePreflightWait[];
    asserts: readonly DistributedRecipePreflightAssert[];
    tree: readonly DistributedRecipePreflightTreeRow[];
    warnings: readonly string[];
    errors: readonly string[];
}>;

export type DistributedRecipeTargetStatus =
    | 'matched'
    | 'stale'
    | 'offline'
    | 'different-group'
    | 'missing-identity'
    | 'missing-crdt-runtime'
    | 'missing-crdt-transport';

export type DistributedRecipeTargetRow = Readonly<{
    agentId: string;
    connected: boolean;
    status: DistributedRecipeTargetStatus;
    targetable: boolean;
    reason: string;
    principalId?: string;
    sessionId?: string;
    groupId?: string;
    applicationId?: string;
    workspaceId?: string;
    crdtSupported?: boolean;
    crdtTransports?: readonly string[];
    lastHeartbeatAtEpochMs?: number;
    lastSeenAtEpochMs?: number;
}>;

export type DistributedWorldFleetTargetGate = Readonly<{
    usesWorldFleetTargets: boolean;
    targetResolution?: RallarBlackBoxDistributedTargetResolution;
    expectedParticipantCount?: number;
    previewSelected?: number;
    blocked: boolean;
    blockReason?: string;
}>;

export type BuildDistributedRunManifestInput = Readonly<{
    distributedRunId: string;
    controlRunId: string;
    displayName?: string;
    group: RallarBlackBoxDistributedGroupRef;
    recipes: readonly DistributedRecipeCatalogItem[];
    targetAgentIds: readonly string[];
    targetPolicyMode: DistributedRecipeTargetPolicyMode;
    rolePattern: DistributedRecipeRolePattern;
    ackTimeoutMs: number;
    barrier?: RallarBlackBoxDistributedBarrierPolicy;
    startMode: 'manual' | 'auto-after-ready' | 'scheduled';
    startDeadlineEpochMs?: number;
    expectedParticipantCount?: number;
}>;

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
    required: boolean;
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
    kind: 'run' | 'participant' | 'recipe' | 'command';
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
    expectedLaneId?: string;
    observedLaneId?: string;
    accepted?: boolean;
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
    rows: readonly DistributedRunCompositeRow[];
}>;

export type DistributedRunMonitor = Readonly<{
    distributedRunId: string;
    state: string;
    commandCounts: Readonly<{
        total: number;
        stage: number;
        barrier: number;
        start: number;
        cancel: number;
        completed: number;
        failed: number;
        pending: number;
    }>;
    resultCounts: Readonly<{
        total: number;
        ok: number;
        failed: number;
    }>;
    compositeCounts: DistributedRunCompositeCounts;
    diagnosticCounts: DistributedRunRuntimeDiagnosticCounts;
    latency: DistributedRunLatencySummary;
    artifact: DistributedRunArtifactValidation;
    timeline: readonly DistributedRunTimelineItem[];
    agentProgress: readonly DistributedRunAgentProgressRow[];
    recipeProgress: readonly DistributedRunRecipeProgressRow[];
    readiness: readonly DistributedRunReadinessRow[];
    failures: readonly DistributedRunFailureRow[];
    events: readonly DistributedRunEventRow[];
    runtimeDiagnostics: readonly DistributedRunRuntimeDiagnosticRow[];
    compositeDrilldowns: readonly DistributedRunCompositeDrilldown[];
}>;

export type DistributedRunHistoryFilter = Readonly<{
    query?: string;
    groupId?: string;
    recipeId?: string;
    profile?: string;
    user?: string;
    status?: string;
    failureType?: string;
    fromEpochMs?: number;
    toEpochMs?: number;
}>;

export type DistributedRunCompareSummary = Readonly<{
    leftId: string;
    rightId: string;
    recipeDelta: Readonly<{
        leftOnly: readonly string[];
        rightOnly: readonly string[];
        changedProfiles: readonly string[];
    }>;
    participantDelta: Readonly<{
        leftOnly: readonly string[];
        rightOnly: readonly string[];
        shared: readonly string[];
    }>;
    failureDelta: Readonly<{
        leftCount: number;
        rightCount: number;
        leftOnly: readonly string[];
        rightOnly: readonly string[];
    }>;
    timingDelta: Readonly<{
        leftDurationMs?: number;
        rightDurationMs?: number;
        durationDeltaMs?: number;
        startedDeltaMs?: number;
        completedDeltaMs?: number;
    }>;
    receivedMessageDelta: Readonly<{
        leftCount: number;
        rightCount: number;
        delta: number;
        leftOnly: readonly string[];
        rightOnly: readonly string[];
    }>;
}>;

export type DistributedFailureExplanation = Readonly<{
    category:
        | 'targeting'
        | 'readiness'
        | 'barrier'
        | 'command'
        | 'rtc-stream-performance'
        | 'diagnostic'
        | 'runtime'
        | 'unknown';
    title: string;
    likelyCause: string;
    nextAction: string;
    evidence: readonly string[];
}>;

export type DistributedRunAnalysisReport = Readonly<{
    distributedRunId: string;
    summary: Readonly<{
        state: string;
        ok: boolean;
        durationMs?: number;
        targetCount: number;
        commandCount: number;
        completedCommandCount: number;
        failedCommandCount: number;
        resultCount: number;
        failedResultCount: number;
        artifactStatus: DistributedRunArtifactValidationStatus;
        snapshotMayBeTruncated: boolean;
        snapshotWarnings: readonly string[];
    }>;
    firstFailure?: Readonly<{
        category: DistributedFailureExplanation['category'];
        key: string;
        kind: DistributedRunFailureRow['kind'];
        message: string;
        code?: string;
        agentId?: string;
        recipeId?: string;
        commandId?: string;
        atEpochMs?: number;
    }>;
    agents: readonly Readonly<{
        agentId: string;
        role?: string;
        readiness: DistributedRunProgressStatus;
        barrier: DistributedRunProgressStatus;
        execution: DistributedRunProgressStatus;
        eventCount: number;
        failedCommandCount: number;
        reconnectCount?: number;
        lastHeartbeatAtEpochMs?: number;
    }>[];
    recipes: readonly DistributedRunRecipeProgressRow[];
    diagnostics: Readonly<{
        total: number;
        warnings: number;
        errors: number;
        ws: number;
        rtc: number;
        correlated: readonly DistributedRunRuntimeDiagnosticRow[];
    }>;
    nextActions: readonly DistributedFailureExplanation[];
    rawEvidence: Readonly<{
        failureKeys: readonly string[];
        diagnosticIds: readonly string[];
        artifactStatus: DistributedRunArtifactValidationStatus;
        artifactMessage: string;
    }>;
}>;

export type RunVerdictKind =
    | 'no-run'
    | 'running'
    | 'passed'
    | 'failed'
    | 'attention';

export type RunVerdictTone = 'good' | 'active' | 'warn' | 'bad' | 'muted';

export type RunVerdictEvidenceItem = Readonly<{
    label: string;
    value: string;
    tone: RunVerdictTone;
    detail?: string;
}>;

export type RunCausalTrailItem = Readonly<{
    kind:
        | 'failure-category'
        | 'command-result'
        | 'stream-performance'
        | 'diagnostic'
        | 'artifact'
        | 'events';
    label: string;
    detail: string;
    tone: RunVerdictTone;
    targetKind?: 'command' | 'diagnostic' | 'artifact' | 'event' | 'agent';
    targetId?: string;
    actionLabel?: string;
    agentId?: string;
    recipeId?: string;
    commandId?: string;
    atEpochMs?: number;
    evidence: readonly string[];
}>;

export type RunVerdictView = Readonly<{
    verdict: RunVerdictKind;
    tone: RunVerdictTone;
    title: string;
    summary: string;
    runId?: string;
    state?: string;
    recipeLabel?: string;
    profileLabel?: string;
    targetCount?: number;
    durationMs?: number;
    artifactStatus: DistributedRunArtifactValidationStatus;
    artifactMessage: string;
    refreshedAtEpochMs?: number;
    likelyCause?: string;
    nextAction?: string;
    primaryEvidence: readonly RunVerdictEvidenceItem[];
    successSignals: readonly string[];
    warningSignals: readonly string[];
    causalTrail: readonly RunCausalTrailItem[];
}>;

export function runCausalTrailForFailure(input: Readonly<{
    causalTrail: readonly RunCausalTrailItem[];
    failure: DistributedRunFailureRow;
    runtimeDiagnostics: readonly DistributedRunRuntimeDiagnosticRow[];
}>): readonly RunCausalTrailItem[] {
    const directDiagnosticIds = new Set(input.runtimeDiagnostics
        .filter(row => row.correlatedFailureKeys.includes(input.failure.key))
        .map(row => row.eventId));

    return input.causalTrail.filter(item => {
        if (item.kind === 'artifact') {
            return true;
        }
        if (item.kind === 'diagnostic') {
            return item.targetId !== undefined && directDiagnosticIds.has(item.targetId);
        }
        if (input.failure.kind === 'command') {
            return item.commandId === input.failure.commandId;
        }
        if (input.failure.kind === 'recipe') {
            return item.commandId === undefined && item.recipeId === input.failure.recipeId;
        }
        if (input.failure.kind === 'participant') {
            return item.commandId === undefined && item.agentId === input.failure.agentId;
        }
        return item.commandId === undefined && item.agentId === undefined &&
            item.recipeId === undefined;
    });
}

export type DistributedRunWarningRegressionExpectation = Readonly<{
    messageEvidence?: readonly string[];
    diagnosticTypeIds?: readonly string[];
    compositeRecipeIds?: readonly string[];
    failOnDiagnosticSeverities?: readonly RallarBlackBoxTestSeverity[];
}>;

export type DistributedRunWarningRegressionReport = Readonly<{
    schemaVersion: 1;
    distributedRunId: string;
    ok: boolean;
    expected: Readonly<{
        messageEvidence: readonly string[];
        diagnosticTypeIds: readonly string[];
        compositeRecipeIds: readonly string[];
        failOnDiagnosticSeverities: readonly RallarBlackBoxTestSeverity[];
    }>;
    observed: Readonly<{
        monitorMessageEvidence: readonly string[];
        artifactMessageEvidence: readonly string[];
        diagnosticTypeIds: readonly string[];
        warningDiagnosticTypeIds: readonly string[];
        highSeverityDiagnosticTypeIds: readonly string[];
        compositeRecipeIds: readonly string[];
        artifactStatus: DistributedRunArtifactValidationStatus;
    }>;
    failures: readonly string[];
}>;

export const DISTRIBUTED_RECIPE_ROLE_PATTERN_OPTIONS: readonly Readonly<{
    value: DistributedRecipeRolePattern;
    label: string;
    description: string;
}>[] = [
    {
        value: 'all-agents',
        label: 'All agents same recipe',
        description: 'Every selected browser receives every selected recipe.',
    },
    {
        value: 'sender-receiver',
        label: 'Sender / receiver pair',
        description: 'First target is sender, second target is receiver.',
    },
    {
        value: 'one-sender-many-receivers',
        label: 'One sender, many receivers',
        description: 'First target is sender, remaining targets are receivers.',
    },
    {
        value: 'three-browser-matrix',
        label: 'Three-browser matrix',
        description: 'First target publishes, second relays, third and later observe.',
    },
];

export function distributedRecipeTargetRows(input: Readonly<{
    run: ControlRunSnapshot | undefined;
    group: RallarBlackBoxDistributedGroupRef;
    requiredCommandKinds?: readonly RallarBlackBoxTestCommandKind[];
    nowEpochMs?: number;
    staleAfterMs?: number;
}>): readonly DistributedRecipeTargetRow[] {
    const nowEpochMs = input.nowEpochMs ?? Date.now();
    const staleAfterMs = input.staleAfterMs ?? 30_000;
    const requiredCrdtTransports = crdtTransportsForCommandKinds(input.requiredCommandKinds ?? []);
    return [...(input.run?.agents ?? [])]
        .sort((left, right) => left.agentId.localeCompare(right.agentId))
        .map(agent =>
            distributedRecipeTargetRow(agent, input.group, nowEpochMs, staleAfterMs, requiredCrdtTransports)
        );
}

export function defaultDistributedRecipeTargetIds(
    rows: readonly DistributedRecipeTargetRow[],
): readonly string[] {
    return rows
        .filter(row => row.targetable)
        .map(row => row.agentId);
}

export function deriveDistributedWorldFleetTargetGate(input: Readonly<{
    usesWorldFleetTargets: boolean;
    expectedParticipantCount?: number;
    targetResolutionPreview?: RallarBlackBoxDistributedTargetResolution;
    selectedDistributedRun?: ControlDistributedRunSnapshot;
    distributedRunId?: string;
}>): DistributedWorldFleetTargetGate {
    const selectedRunUsesWorldFleetTargets =
        input.selectedDistributedRun?.manifest.targetPolicy.mode === 'all-online-group-members';
    const selectedRunMatchesDraft =
        input.distributedRunId === undefined ||
        input.selectedDistributedRun?.distributedRunId === input.distributedRunId;
    const useSelectedRunResolution = selectedRunUsesWorldFleetTargets &&
        (!input.usesWorldFleetTargets || selectedRunMatchesDraft);
    const targetResolution = input.usesWorldFleetTargets
        ? input.targetResolutionPreview ??
            (useSelectedRunResolution ? input.selectedDistributedRun?.targetResolution : undefined)
        : useSelectedRunResolution
        ? input.selectedDistributedRun?.targetResolution
        : undefined;
    const usesWorldFleetTargets = input.usesWorldFleetTargets || useSelectedRunResolution;
    const expectedParticipantCount = input.usesWorldFleetTargets
        ? input.expectedParticipantCount
        : useSelectedRunResolution
        ? input.selectedDistributedRun?.manifest.targetPolicy.expectedParticipantCount
        : undefined;
    const previewSelected = usesWorldFleetTargets
        ? targetResolution?.summary.selected
        : undefined;
    const resolutionExpected = targetResolution?.summary.expectedParticipantCount;
    const blocked = usesWorldFleetTargets &&
        (
            targetResolution === undefined ||
            expectedParticipantCount === undefined ||
            resolutionExpected !== expectedParticipantCount ||
            previewSelected !== expectedParticipantCount
        );
    const blockReason = blocked
        ? targetResolution === undefined
            ? 'Resolve world-fleet targets before staging or starting.'
            : `Resolved ${previewSelected ?? 0}/${expectedParticipantCount ?? 'unknown'} world-fleet target(s).`
        : undefined;

    return {
        usesWorldFleetTargets,
        targetResolution,
        expectedParticipantCount,
        previewSelected,
        blocked,
        blockReason,
    };
}

export function distributedRecipeCommandPreview(
    recipe: RallarBlackBoxTestRecipe,
): DistributedRecipeCommandPreview {
    const manifestCommandCount = recipe.commands.length;
    const effectiveCommandCount = recipe.commands.reduce(
        (sum, command) => sum + effectiveCommandCountForCommand(command),
        0,
    );
    const hasStreamFrames = recipe.commands.some(command => commandKindsForCommand(command).includes('rtc.stream'));
    const effectiveFrameCount = firstPositiveInteger(
        asRecord(asRecord(recipe.metadata).realtime).frameCount,
        asRecord(recipe.metadata).frameCount,
        ...recipe.commands.map(effectiveFrameCountForCommand),
    );
    const labelParts = [
        `${manifestCommandCount} manifest command${manifestCommandCount === 1 ? '' : 's'}`,
    ];
    if (effectiveCommandCount !== manifestCommandCount) {
        labelParts.push(`${effectiveCommandCount} effective operation${effectiveCommandCount === 1 ? '' : 's'}`);
    }
    if (effectiveFrameCount !== undefined) {
        labelParts.push(`${effectiveFrameCount} ${hasStreamFrames ? 'stream ' : ''}frames`);
    }

    return {
        manifestCommandCount,
        effectiveCommandCount,
        effectiveFrameCount,
        label: labelParts.join(' - '),
    };
}

export function distributedRecipeCommandKinds(
    recipe: RallarBlackBoxTestRecipe,
): readonly RallarBlackBoxTestCommandKind[] {
    return uniqueValues(recipe.commands.flatMap(commandKindsForCommand));
}

export function distributedRecipePreflight(
    recipe: RallarBlackBoxTestRecipe,
): DistributedRecipePreflightSummary {
    const analyses = recipe.commands.map((command, index) =>
        analyzeDistributedRecipeCommand(command, `$.commands[${index}]`, 0)
    );
    const commandKinds = uniqueValues(analyses.flatMap(analysis => analysis.commandKinds));
    const capabilities = commandKinds
        .map(kind => COMMAND_CAPABILITY_BY_KIND.get(kind))
        .filter((capability): capability is CommandCapability => Boolean(capability));
    const liveServiceRequirements = uniqueValues([
        ...capabilities.flatMap(capability => capability.liveServiceRequirements),
        ...analyses.flatMap(analysis => analysis.liveServiceRequirements),
    ].filter(requirement => requirement !== COMPOSITE_CHILD_REQUIREMENTS_LABEL));
    const warnings = uniqueValues([
        ...analyses.flatMap(analysis => analysis.warnings),
        ...rtcReadinessWarnings(recipe),
        ...compatibilityWarnings(commandKinds, liveServiceRequirements),
    ]);
    const errors = uniqueValues(analyses.flatMap(analysis => analysis.errors));

    return {
        recipeId: recipe.recipeId,
        manifestCommandCount: recipe.commands.length,
        effectiveCommandCount: analyses.reduce((sum, analysis) => sum + analysis.effectiveCommandCount, 0),
        effectiveFrameCount: firstPositiveInteger(
            asRecord(asRecord(recipe.metadata).realtime).frameCount,
            asRecord(recipe.metadata).frameCount,
            ...analyses.map(analysis => analysis.effectiveFrameCount),
        ),
        maxDepth: Math.max(0, ...analyses.map(analysis => analysis.maxDepth)),
        commandKinds,
        providerModes: uniqueValues(capabilities.flatMap(capability => capability.supportedProviderModes)),
        runtimeSurfaces: uniqueValues(capabilities.flatMap(capability => capability.runtimeSurfaces)),
        liveServiceRequirements,
        serviceBadges: serviceBadgesForPreflight(commandKinds, liveServiceRequirements),
        loops: analyses.flatMap(analysis => analysis.loops),
        parallelGroups: analyses.flatMap(analysis => analysis.parallelGroups),
        waits: analyses.flatMap(analysis => analysis.waits),
        asserts: analyses.flatMap(analysis => analysis.asserts),
        tree: analyses.flatMap(analysis => analysis.tree),
        warnings,
        errors,
    };
}

type CommandCapability = typeof RALLAR_BLACK_BOX_COMMAND_CAPABILITIES[number];

type RecipeCommandNode = Readonly<{
    command: RallarBlackBoxTestCommand;
    insideLoop: boolean;
}>;

function recipeCommandNodes(
    commands: readonly RallarBlackBoxTestCommand[],
    insideLoop = false,
): readonly RecipeCommandNode[] {
    return commands.flatMap((command): readonly RecipeCommandNode[] => {
        const current = [{ command, insideLoop }];
        if (command.kind === 'loop') {
            return [
                ...current,
                ...recipeCommandNodes(command.commands, true),
            ];
        }
        if (command.kind === 'parallel') {
            return [
                ...current,
                ...command.groups.flatMap(group => recipeCommandNodes(group.commands, insideLoop)),
            ];
        }
        if ((command.kind === 'recipe.load' || command.kind === 'recipe.run') && command.recipe) {
            return [
                ...current,
                ...recipeCommandNodes(command.recipe.commands, insideLoop),
            ];
        }
        return current;
    });
}

function hasRtcConnectReadiness(command: RallarBlackBoxTestCommand): boolean {
    return command.kind === 'rtc.connect' && command.readiness !== undefined;
}

function rtcReadinessWarnings(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    const nodes = recipeCommandNodes(recipe.commands);
    const sends = nodes.filter(node => node.command.kind === 'rtc.send' || node.command.kind === 'rtc.stream');
    if (sends.length === 0 || nodes.some(node => hasRtcConnectReadiness(node.command))) {
        return [];
    }

    const hasStream = sends.some(node => node.command.kind === 'rtc.stream');
    const warnings = [
        hasStream
            ? 'RTC stream traffic starts without an explicit rtc.connect readiness contract; frames can race signaling and data-channel readiness.'
            : 'RTC send traffic starts without an explicit rtc.connect readiness contract; sends can race signaling and data-channel readiness.',
    ];
    if (sends.some(node => node.insideLoop)) {
        warnings.push('Looped RTC sends are especially sensitive to missing ready-peer checks before the first frame.');
    }
    if (hasStream) {
        warnings.push('Streamed RTC frames are especially sensitive to missing ready-peer checks before the first frame.');
    }
    return warnings;
}

type DistributedRecipeCommandAnalysis = Readonly<{
    effectiveCommandCount: number;
    effectiveFrameCount?: number;
    maxDepth: number;
    commandKinds: readonly RallarBlackBoxTestCommandKind[];
    liveServiceRequirements: readonly string[];
    loops: readonly DistributedRecipePreflightLoop[];
    parallelGroups: readonly DistributedRecipePreflightParallel[];
    waits: readonly DistributedRecipePreflightWait[];
    asserts: readonly DistributedRecipePreflightAssert[];
    tree: readonly DistributedRecipePreflightTreeRow[];
    warnings: readonly string[];
    errors: readonly string[];
}>;

const COMMAND_CAPABILITY_BY_KIND = new Map(
    RALLAR_BLACK_BOX_COMMAND_CAPABILITIES.map(capability => [capability.kind, capability]),
);
const COMPOSITE_CHILD_REQUIREMENTS_LABEL = 'same live requirements as its child commands';
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;

function analyzeDistributedRecipeCommand(
    command: RallarBlackBoxTestCommand,
    path: string,
    depth: number,
): DistributedRecipeCommandAnalysis {
    const capability = COMMAND_CAPABILITY_BY_KIND.get(command.kind);
    const directRequirements = capability?.liveServiceRequirements.filter(requirement =>
        requirement !== COMPOSITE_CHILD_REQUIREMENTS_LABEL
    ) ?? [];
    const commandWarnings: string[] = [];
    const commandErrors: string[] = [];
    const details: string[] = [];
    let effectiveCommandCount = 1;
    let childAnalyses: readonly DistributedRecipeCommandAnalysis[] = [];
    let loops: readonly DistributedRecipePreflightLoop[] = [];
    let parallelGroups: readonly DistributedRecipePreflightParallel[] = [];
    let waits: readonly DistributedRecipePreflightWait[] = [];
    let asserts: readonly DistributedRecipePreflightAssert[] = [];
    let summary = commandSummary(command);

    if (depth > RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxDepth) {
        commandErrors.push(
            `${path} exceeds max composite depth ${RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxDepth}.`,
        );
    }

    if (command.kind === 'loop') {
        childAnalyses = command.commands.map((child, index) =>
            analyzeDistributedRecipeCommand(child, `${path}.commands[${index}]`, depth + 1)
        );
        const estimate = estimateLoopIterations(command);
        const childEffectiveCommandCount = childAnalyses.reduce(
            (sum, analysis) => sum + analysis.effectiveCommandCount,
            0,
        );
        effectiveCommandCount = childEffectiveCommandCount * estimate.estimatedIterations;
        loops = [{
            path,
            commandId: command.commandId,
            estimatedIterations: estimate.estimatedIterations,
            childCommandCount: command.commands.length,
            effectiveCommandCount,
            count: optionalPositiveIntegerValue(command.count),
            durationMs: optionalPositiveIntegerValue(command.durationMs),
            intervalMs: nonNegativeIntegerValue(command.intervalMs ?? command.delayMs),
            maxCommands: optionalPositiveIntegerValue(command.maxCommands),
            frameCount: effectiveFrameCountForCommand(command),
        }];
        summary = `loop x${estimate.estimatedIterations}`;
        details.push(
            `${command.commands.length} child command${command.commands.length === 1 ? '' : 's'}`,
            `${effectiveCommandCount} effective operation${effectiveCommandCount === 1 ? '' : 's'}`,
        );
        if (estimate.intervalMs !== undefined) {
            details.push(`interval ${estimate.intervalMs} ms`);
        }
        if (estimate.durationMs !== undefined) {
            details.push(`duration ${estimate.durationMs} ms`);
        }
        if (command.commands.length === 0) {
            commandErrors.push(`${path} has no loop child commands.`);
        }
        if (estimate.limitErrors.length > 0) {
            commandErrors.push(...estimate.limitErrors.map(error => `${path}: ${error}`));
        }
        if (estimate.warnings.length > 0) {
            commandWarnings.push(...estimate.warnings.map(warning => `${path}: ${warning}`));
        }
    } else if (command.kind === 'parallel') {
        const groupAnalyses = command.groups.map((group, groupIndex) =>
            group.commands.map((child, commandIndex) =>
                analyzeDistributedRecipeCommand(
                    child,
                    `${path}.groups[${groupIndex}].commands[${commandIndex}]`,
                    depth + 1,
                )
            )
        );
        childAnalyses = groupAnalyses.flat();
        effectiveCommandCount = childAnalyses.reduce(
            (sum, analysis) => sum + analysis.effectiveCommandCount,
            0,
        );
        const maxConcurrency = optionalPositiveIntegerValue(command.maxConcurrency) ?? command.groups.length;
        parallelGroups = [{
            path,
            commandId: command.commandId,
            groupCount: command.groups.length,
            maxConcurrency,
            effectiveCommandCount,
            groups: command.groups.map((group, index) =>
                group.label ?? group.groupId ?? `group ${index + 1}`
            ),
        }];
        summary = `parallel ${command.groups.length} group${command.groups.length === 1 ? '' : 's'}`;
        details.push(
            `max concurrency ${maxConcurrency}`,
            `${effectiveCommandCount} effective operation${effectiveCommandCount === 1 ? '' : 's'}`,
        );
        if (command.groups.length === 0) {
            commandErrors.push(`${path} has no parallel groups.`);
        }
        if (maxConcurrency > RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxParallelConcurrency) {
            commandErrors.push(
                `${path}: parallel maxConcurrency ${maxConcurrency} exceeds ` +
                `${RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxParallelConcurrency}.`,
            );
        }
    } else if (command.kind === 'recipe.load' || command.kind === 'recipe.run') {
        const nestedRecipe = command.recipe;
        if (!nestedRecipe) {
            summary = 'run loaded recipe';
        } else {
            childAnalyses = nestedRecipe.commands.map((child, index) =>
                analyzeDistributedRecipeCommand(child, `${path}.recipe.commands[${index}]`, depth + 1)
            );
            if (command.kind === 'recipe.run') {
                effectiveCommandCount = childAnalyses.reduce(
                    (sum, analysis) => sum + analysis.effectiveCommandCount,
                    0,
                );
                summary = `runs ${nestedRecipe.commands.length} recipe command${nestedRecipe.commands.length === 1 ? '' : 's'}`;
            } else {
                summary = `loads ${nestedRecipe.commands.length} recipe command${nestedRecipe.commands.length === 1 ? '' : 's'}`;
            }
            details.push(nestedRecipe.recipeId);
        }
    } else if (command.kind === 'rtc.connect') {
        const readinessDetail = rtcConnectReadinessDetail(command);
        if (readinessDetail) {
            details.push(readinessDetail);
        }
    } else if (command.kind === 'rtc.stream') {
        const frameCount = effectiveFrameCountForCommand(command);
        if (frameCount !== undefined) {
            details.push(`${frameCount} frame${frameCount === 1 ? '' : 's'}`);
        }
        if (command.intervalMs !== undefined) {
            details.push(`interval ${command.intervalMs} ms`);
        } else if (command.rateHz !== undefined) {
            details.push(`rate ${command.rateHz} Hz`);
        }
        if (command.maxInFlight !== undefined) {
            details.push(`max in-flight ${command.maxInFlight}`);
        }
        if (command.thresholds?.minSendSuccessRatio !== undefined) {
            details.push(`min success ratio ${command.thresholds.minSendSuccessRatio}`);
        }
        if (command.thresholds?.maxDroppedFrames !== undefined) {
            details.push(`max dropped frames ${command.thresholds.maxDroppedFrames}`);
        }
    } else if (command.kind === 'wait') {
        waits = [waitPreflight(command, path)];
        const timeoutMs = command.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
        summary = `wait up to ${timeoutMs} ms`;
        details.push(waits[0].matchSummary);
        commandWarnings.push(`${path}: wait can time out if matching evidence is not emitted.`);
    } else if (command.kind === 'assert') {
        asserts = [assertPreflight(command, path)];
        summary = asserts[0].predicate;
        commandWarnings.push(`${path}: assert fails the recipe when its runtime evidence does not match.`);
    }

    const childWarnings = childAnalyses.flatMap(analysis => analysis.warnings);
    const childErrors = childAnalyses.flatMap(analysis => analysis.errors);
    const commandKinds = uniqueValues([
        command.kind,
        ...childAnalyses.flatMap(analysis => analysis.commandKinds),
    ]);
    const liveServiceRequirements = uniqueValues([
        ...directRequirements,
        ...childAnalyses.flatMap(analysis => analysis.liveServiceRequirements),
    ]);
    const row: DistributedRecipePreflightTreeRow = {
        path,
        depth,
        kind: command.kind,
        commandId: command.commandId,
        label: command.label ?? command.commandId ?? command.kind,
        summary,
        effectiveCommandCount,
        details,
        warnings: commandWarnings,
    };

    return {
        effectiveCommandCount,
        effectiveFrameCount: firstPositiveInteger(
            effectiveFrameCountForCommand(command),
            ...childAnalyses.map(analysis => analysis.effectiveFrameCount),
        ),
        maxDepth: Math.max(depth + 1, ...childAnalyses.map(analysis => analysis.maxDepth)),
        commandKinds,
        liveServiceRequirements,
        loops: [
            ...loops,
            ...childAnalyses.flatMap(analysis => analysis.loops),
        ],
        parallelGroups: [
            ...parallelGroups,
            ...childAnalyses.flatMap(analysis => analysis.parallelGroups),
        ],
        waits: [
            ...waits,
            ...childAnalyses.flatMap(analysis => analysis.waits),
        ],
        asserts: [
            ...asserts,
            ...childAnalyses.flatMap(analysis => analysis.asserts),
        ],
        tree: [
            row,
            ...childAnalyses.flatMap(analysis => analysis.tree),
        ],
        warnings: uniqueValues([...commandWarnings, ...childWarnings]),
        errors: uniqueValues([...commandErrors, ...childErrors]),
    };
}

function estimateLoopIterations(command: Extract<RallarBlackBoxTestCommand, { kind: 'loop' }>): Readonly<{
    estimatedIterations: number;
    durationMs?: number;
    intervalMs?: number;
    warnings: readonly string[];
    limitErrors: readonly string[];
}> {
    const warnings: string[] = [];
    const limitErrors: string[] = [];
    const count = optionalPositiveIntegerValue(command.count);
    const durationMs = optionalPositiveIntegerValue(command.durationMs);
    const intervalMs = nonNegativeIntegerValue(command.intervalMs ?? command.delayMs);
    const maxCommands = optionalPositiveIntegerValue(command.maxCommands) ??
        RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxExpandedCommands;
    const childCommandCount = Math.max(1, command.commands.length);

    if (command.count !== undefined && count === undefined) {
        limitErrors.push('loop count must be a positive integer.');
    } else if ((count ?? 0) > RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopCount) {
        limitErrors.push(
            `loop count ${count} exceeds ${RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopCount}.`,
        );
    }

    if (command.durationMs !== undefined && durationMs === undefined) {
        limitErrors.push('loop durationMs must be a positive integer.');
    } else if ((durationMs ?? 0) > RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopDurationMs) {
        limitErrors.push(
            `loop durationMs ${durationMs} exceeds ${RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopDurationMs}.`,
        );
    }

    if ((command.intervalMs ?? command.delayMs) !== undefined && intervalMs === undefined) {
        limitErrors.push('loop intervalMs/delayMs must be a non-negative integer.');
    }

    if (command.maxCommands !== undefined && optionalPositiveIntegerValue(command.maxCommands) === undefined) {
        limitErrors.push('loop maxCommands must be a positive integer.');
    }

    if (count !== undefined) {
        const plannedDirectCommands = count * childCommandCount;
        if (durationMs === undefined && plannedDirectCommands > maxCommands) {
            limitErrors.push(`loop schedules ${plannedDirectCommands} direct child commands but maxCommands is ${maxCommands}.`);
        }
        if (count > 100 && intervalMs === 0) {
            warnings.push(`loop schedules ${count} iterations without pacing.`);
        }
        return {
            estimatedIterations: count,
            durationMs,
            intervalMs,
            warnings,
            limitErrors,
        };
    }

    if (durationMs !== undefined) {
        const intervalEstimate = intervalMs && intervalMs > 0
            ? Math.max(1, Math.ceil(durationMs / intervalMs))
            : RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopCount;
        const maxCommandEstimate = Math.max(1, Math.floor(maxCommands / childCommandCount));
        const estimatedIterations = Math.min(
            RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopCount,
            intervalEstimate,
            maxCommandEstimate,
        );
        warnings.push(
            'duration-based loop estimate depends on runtime command latency and can finish earlier or later.',
        );
        if (!intervalMs || intervalMs === 0) {
            warnings.push('duration-based loop has no positive pacing interval.');
        }
        return {
            estimatedIterations,
            durationMs,
            intervalMs,
            warnings,
            limitErrors,
        };
    }

    return {
        estimatedIterations: 1,
        intervalMs,
        warnings,
        limitErrors,
    };
}

function commandSummary(command: RallarBlackBoxTestCommand): string {
    switch (command.kind) {
        case 'configure':
            return 'configure runtime';
        case 'recipe.load':
            return 'load recipe';
        case 'recipe.run':
            return command.recipe ? 'run inline recipe' : 'run loaded recipe';
        case 'recipe.cancel':
            return 'cancel loaded recipe';
        case 'rtc.connect':
            return [
                'connect RTC',
                command.connection,
                roomLabel(command),
            ].filter(Boolean).join(' - ');
        case 'rtc.send':
            return [
                'send RTC',
                command.connection,
                roomLabel(command),
            ].filter(Boolean).join(' - ');
        case 'rtc.stream':
            return [
                'stream RTC',
                command.transport,
                roomLabel(command),
            ].filter(Boolean).join(' - ');
        case 'ws.open':
            return ['open WebSocket', command.connection].filter(Boolean).join(' - ');
        case 'ws.send':
            return ['send WebSocket', command.connection].filter(Boolean).join(' - ');
        case 'ws.close':
            return ['close WebSocket', command.connection].filter(Boolean).join(' - ');
        case 'http.request':
            return `${command.request.method ?? 'GET'} ${command.request.path ?? command.request.url ?? 'HTTP request'}`;
        case 'health':
            return 'agent health';
        case 'stats':
            return 'agent stats';
        case 'close':
            return 'close transports';
        case 'reset':
            return 'reset agent runtime';
        default:
            return command.kind;
    }
}

function roomLabel(
    command: Extract<RallarBlackBoxTestCommand, { kind: 'rtc.connect' | 'rtc.send' | 'rtc.stream' }>,
): string | undefined {
    const roomRef = asRecord(command.roomRef);
    const send = command.kind === 'rtc.send' || command.kind === 'rtc.stream'
        ? asRecord(command.send)
        : {};
    const roomId = command.kind === 'rtc.connect' || command.kind === 'rtc.stream'
        ? command.roomId
        : undefined;
    return String(roomId ?? send.roomId ?? roomRef.groupId ?? roomRef.roomId ?? '') || undefined;
}

function rtcConnectReadinessDetail(
    command: Extract<RallarBlackBoxTestCommand, { kind: 'rtc.connect' }>,
): string | undefined {
    if (!command.readiness) {
        return undefined;
    }

    const minReadyPeers = optionalPositiveIntegerValue(command.readiness.minReadyPeers) ?? 1;
    const timeoutMs = optionalPositiveIntegerValue(command.readiness.timeoutMs) ?? 5_000;
    const intervalMs = optionalPositiveIntegerValue(command.readiness.intervalMs) ?? 100;
    return `readiness: min ${minReadyPeers} ready peer(s), timeout ${timeoutMs} ms, poll ${intervalMs} ms`;
}

function waitPreflight(command: RallarBlackBoxTestWaitCommand, path: string): DistributedRecipePreflightWait {
    return {
        path,
        commandId: command.commandId,
        matchSummary: matchSummary(command.match),
        timeoutMs: command.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
    };
}

function assertPreflight(command: RallarBlackBoxTestAssertCommand, path: string): DistributedRecipePreflightAssert {
    return {
        path,
        commandId: command.commandId,
        predicate: `${command.source} ${command.operator}${command.expected === undefined ? '' : ` ${shortValue(command.expected)}`}`,
    };
}

function matchSummary(match: RallarBlackBoxTestWaitCommand['match']): string {
    const entries = Object.entries(match).map(([key, value]) => `${key}=${shortValue(value)}`);
    return entries.length > 0 ? entries.join(', ') : 'any runtime evidence';
}

function shortValue(value: unknown): string {
    const rendered = typeof value === 'string'
        ? value
        : JSON.stringify(value);
    if (rendered === undefined) {
        return 'undefined';
    }
    return rendered.length > 72 ? `${rendered.slice(0, 69)}...` : rendered;
}

function compatibilityWarnings(
    commandKinds: readonly RallarBlackBoxTestCommandKind[],
    liveServiceRequirements: readonly string[],
): readonly string[] {
    const warnings: string[] = [];
    const kinds = new Set(commandKinds);
    if (liveServiceRequirements.length > 0) {
        warnings.push('Recipe requires live runtime evidence or live services from the selected browser agents.');
    }
    if (kinds.has('rtc.connect') || kinds.has('rtc.send') || kinds.has('rtc.stream')) {
        warnings.push('RTC recipes require real Rallar signaling, compatible group membership, and at least one peer for delivery checks.');
    }
    if (kinds.has('ws.open') || kinds.has('ws.send')) {
        warnings.push('WebSocket recipes require an open or openable socket for every target agent that sends WS traffic.');
    }
    if (kinds.has('http.request')) {
        warnings.push('HTTP recipes can require access tokens and reachable Rallar Server endpoints.');
    }
    if (hasCrdtCommandKind(commandKinds)) {
        warnings.push('CRDT recipes require browser agents with the Rallar CRDT runtime and requested CRDT transport support.');
    }
    return warnings;
}

function serviceBadgesForPreflight(
    commandKinds: readonly RallarBlackBoxTestCommandKind[],
    liveServiceRequirements: readonly string[],
): readonly DistributedRecipePreflightServiceBadge[] {
    const kinds = new Set(commandKinds);
    const badges: DistributedRecipePreflightServiceBadge[] = [
        { label: 'control server', tone: 'active' },
        { label: 'browser agents', tone: 'active' },
    ];
    if (liveServiceRequirements.length > 0) {
        badges.push({ label: 'runtime evidence', tone: 'warn' });
    }
    if (kinds.has('http.request')) {
        badges.push({ label: 'HTTP/API', tone: 'warn' });
    }
    if (kinds.has('ws.open') || kinds.has('ws.send') || kinds.has('ws.close')) {
        badges.push({ label: 'WebSocket', tone: 'warn' });
    }
    if (kinds.has('rtc.connect')) {
        badges.push({ label: 'Rallar auth/signaling', tone: 'warn' });
    }
    if (kinds.has('rtc.send') || kinds.has('rtc.stream')) {
        badges.push({ label: 'RTC peers', tone: 'warn' });
    }
    if (hasCrdtCommandKind(commandKinds)) {
        badges.push({ label: 'CRDT', tone: 'warn' });
    }
    if (kinds.has('loop')) {
        badges.push({ label: 'looped traffic', tone: 'active' });
    }
    if (kinds.has('parallel')) {
        badges.push({ label: 'parallel groups', tone: 'active' });
    }
    return badges;
}

function hasCrdtCommandKind(commandKinds: readonly RallarBlackBoxTestCommandKind[]): boolean {
    return commandKinds.some(kind => kind.startsWith('crdt.'));
}

function crdtTransportsForCommandKinds(
    commandKinds: readonly RallarBlackBoxTestCommandKind[],
): readonly RallarBlackBoxTestCrdtTransport[] {
    return hasCrdtCommandKind(commandKinds)
        ? ['local-only', 'ws', 'rtc', 'ws-then-rtc', 'rtc-with-ws-fallback']
        : [];
}

function commandKindsForCommand(command: RallarBlackBoxTestCommand): readonly RallarBlackBoxTestCommandKind[] {
    const nested = (() => {
        switch (command.kind) {
            case 'loop':
                return command.commands.flatMap(commandKindsForCommand);
            case 'parallel':
                return command.groups.flatMap(group => group.commands.flatMap(commandKindsForCommand));
            case 'recipe.load':
            case 'recipe.run':
                return command.recipe?.commands.flatMap(commandKindsForCommand) ?? [];
            default:
                return [];
        }
    })();

    return uniqueValues([command.kind, ...nested]);
}

function effectiveCommandCountForCommand(command: RallarBlackBoxTestCommand): number {
    if (command.kind === 'loop') {
        const childCommandCount = command.commands.reduce(
            (sum, childCommand) => sum + effectiveCommandCountForCommand(childCommand),
            0,
        );
        return childCommandCount * positiveIntegerValue(command.count, 1);
    }

    if (command.kind === 'parallel') {
        return command.groups.reduce(
            (sum, group) => sum + group.commands.reduce(
                (groupSum, childCommand) => groupSum + effectiveCommandCountForCommand(childCommand),
                0,
            ),
            0,
        );
    }

    return 1;
}

function effectiveFrameCountForCommand(command: RallarBlackBoxTestCommand): number | undefined {
    const metadata = asRecord(command.metadata);
    const realtime = asRecord(metadata.realtime);
    const frameCount = firstPositiveInteger(realtime.frameCount, metadata.frameCount);
    if (frameCount !== undefined) {
        return frameCount;
    }

    if (command.kind === 'rtc.stream') {
        return firstPositiveInteger(command.count);
    }

    if (command.kind === 'loop') {
        const childFrameCount = firstPositiveInteger(...command.commands.map(effectiveFrameCountForCommand));
        return childFrameCount;
    }

    return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function positiveIntegerValue(value: unknown, fallback?: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0
        ? value
        : fallback ?? 1;
}

function optionalPositiveIntegerValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value > 0
        ? value
        : undefined;
}

function nonNegativeIntegerValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
        ? value
        : undefined;
}

function firstPositiveInteger(...values: readonly unknown[]): number | undefined {
    return values.find((value): value is number =>
        typeof value === 'number' && Number.isInteger(value) && value > 0
    );
}

function uniqueValues<T extends string>(values: readonly T[]): readonly T[] {
    return [...new Set(values)].sort();
}

export function buildDistributedRunManifest(
    input: BuildDistributedRunManifestInput,
): RallarBlackBoxDistributedRunManifest {
    const recipeSelections = input.recipes.map((item, index) => ({
        recipeId: item.recipe.recipeId,
        recipe: item.recipe,
        role: recipeRoleForPattern(input.rolePattern, index, input.recipes.length),
        profile: item.profiles[0],
        required: true,
    } satisfies RallarBlackBoxDistributedRunRecipeSelection));
    const roles = rolesForPattern(input.rolePattern, input.targetAgentIds);
    const targetPolicy = buildTargetPolicy({
        mode: input.targetPolicyMode,
        agentIds: input.targetAgentIds,
        roles,
        expectedParticipantCount: input.expectedParticipantCount,
    });
    const useOrderedTargetRoles = input.targetPolicyMode === 'all-online-group-members' &&
        input.rolePattern !== 'all-agents';
    const roleAssignments = useOrderedTargetRoles
        ? undefined
        : roleAssignmentsForPattern(input.rolePattern, input.targetAgentIds);
    const roleAssignmentPolicy = useOrderedTargetRoles
        ? orderedTargetRoleAssignmentPolicy(input.rolePattern)
        : undefined;

    return {
        schemaVersion: 1,
        distributedRunId: input.distributedRunId,
        controlRunId: input.controlRunId,
        displayName: input.displayName,
        group: input.group,
        recipes: recipeSelections,
        targetPolicy,
        roleAssignments,
        roleAssignmentPolicy,
        ackTimeoutMs: input.ackTimeoutMs,
        barrier: input.barrier,
        startMode: input.startMode,
        startDeadlineEpochMs: input.startMode === 'scheduled'
            ? input.startDeadlineEpochMs
            : undefined,
        artifactPolicy: {
            retainArtifacts: true,
            includeDistributedMetadata: true,
            includeEventJsonl: true,
            includeResultJsonl: true,
            includeFailureBundle: true,
        },
        metadata: {
            createdBy: 'rallar-black-box-spa',
            rolePattern: input.rolePattern,
        },
    };
}

export function distributedRecipeStateTone(state: string): string {
    if (state === 'passed' || state === 'ready') {
        return 'good';
    }
    if (state === 'running' || state === 'waiting-for-ack' || state === 'waiting-for-barrier' || state === 'staging') {
        return 'active';
    }
    if (state === 'failed' || state === 'timed-out') {
        return 'bad';
    }
    if (state === 'cancelled') {
        return 'warn';
    }
    return 'muted';
}

export function deriveDistributedRunMonitor(input: Readonly<{
    distributedRun: ControlDistributedRunSnapshot;
    controlRun?: ControlRunSnapshot;
    artifactBundle?: ControlDistributedRunArtifactBundle;
}>): DistributedRunMonitor {
    const linkedCommandIds = new Set(input.distributedRun.commandLinks.map(link => link.commandId));
    const commands = new Map((input.controlRun?.commands ?? [])
        .map(command => [command.envelope.commandId, command]));
    const linkedResults = (input.controlRun?.results ?? [])
        .filter(result => linkedCommandIds.has(result.commandId));
    const resultsByCommandId = new Map(linkedResults.map(result => [result.commandId, result]));
    const linkedEvents = distributedRunEvents(input.distributedRun, input.controlRun);
    const compositeDrilldowns = distributedRunCompositeDrilldowns(
        input.distributedRun,
        linkedResults,
        commands,
    );
    const failures = [
        ...distributedRunFailures(input.distributedRun, linkedResults, commands),
        ...distributedRunCompositeFailures(compositeDrilldowns),
    ].sort((left, right) => (right.atEpochMs ?? 0) - (left.atEpochMs ?? 0));
    const runtimeDiagnostics = correlateDistributedRunRuntimeDiagnostics(
        distributedRunRuntimeDiagnostics(input.distributedRun, input.controlRun),
        failures,
    );
    const commandCounts = distributedRunCommandCounts(
        input.distributedRun.commandLinks,
        commands,
        resultsByCommandId,
    );
    const latencies = linkedResults
        .map(result => result.result?.durationMs)
        .filter(isFiniteNumber);
    const artifact = validateDistributedRunArtifact(input.artifactBundle);

    return {
        distributedRunId: input.distributedRun.distributedRunId,
        state: input.distributedRun.state,
        commandCounts,
        resultCounts: {
            total: linkedResults.length,
            ok: linkedResults.filter(result => result.ok).length,
            failed: linkedResults.filter(result => !result.ok).length,
        },
        compositeCounts: distributedRunCompositeCounts(compositeDrilldowns),
        diagnosticCounts: distributedRunRuntimeDiagnosticCounts(runtimeDiagnostics),
        latency: summarizeLatencies(latencies),
        artifact,
        timeline: distributedRunTimeline({
            distributedRun: input.distributedRun,
            commands,
            results: linkedResults,
            events: linkedEvents,
            runtimeDiagnostics,
            failures,
            artifact,
        }),
        agentProgress: distributedRunAgentProgress({
            distributedRun: input.distributedRun,
            commands,
            resultsByCommandId,
            events: linkedEvents,
        }),
        recipeProgress: distributedRunRecipeProgress({
            distributedRun: input.distributedRun,
            commands,
            resultsByCommandId,
        }),
        readiness: distributedRunReadiness({
            distributedRun: input.distributedRun,
            commands,
            resultsByCommandId,
        }),
        failures,
        events: linkedEvents,
        runtimeDiagnostics,
        compositeDrilldowns,
    };
}

export function deriveDistributedRunAnalysisReport(input: Readonly<{
    distributedRun: ControlDistributedRunSnapshot;
    controlRun?: ControlRunSnapshot;
    artifactBundle?: ControlDistributedRunArtifactBundle;
    snapshotBounds?: ControlSnapshotBounds;
}>): DistributedRunAnalysisReport {
    const monitor = deriveDistributedRunMonitor(input);
    const firstFailure = firstDistributedFailure(monitor.failures);
    const explanations = distributedFailureExplanations(input.distributedRun, monitor, firstFailure);
    const controlAgents = new Map((input.controlRun?.agents ?? []).map(agent => [agent.agentId, agent]));
    const snapshotWarnings = distributedSnapshotWarnings(input.controlRun, input.snapshotBounds);
    const correlatedDiagnostics = monitor.runtimeDiagnostics
        .filter(row => row.correlatedFailureKeys.length > 0);
    const firstExplanation = firstFailure
        ? explanations.find(explanation => explanation.evidence.includes(firstFailure.key)) ??
            explanations[0]
        : undefined;

    return {
        distributedRunId: input.distributedRun.distributedRunId,
        summary: {
            state: input.distributedRun.state,
            ok: input.distributedRun.rollup.ok,
            durationMs: distributedRunDuration(input.distributedRun),
            targetCount: input.distributedRun.targetAgentIds.length,
            commandCount: monitor.commandCounts.total,
            completedCommandCount: monitor.commandCounts.completed,
            failedCommandCount: monitor.commandCounts.failed,
            resultCount: monitor.resultCounts.total,
            failedResultCount: monitor.resultCounts.failed,
            artifactStatus: monitor.artifact.status,
            snapshotMayBeTruncated: snapshotWarnings.length > 0,
            snapshotWarnings,
        },
        firstFailure: firstFailure
            ? {
                category: firstExplanation?.category ?? failureCategory(firstFailure),
                key: firstFailure.key,
                kind: firstFailure.kind,
                message: firstFailure.message,
                code: firstFailure.code,
                agentId: firstFailure.agentId,
                recipeId: firstFailure.recipeId,
                commandId: firstFailure.commandId,
                atEpochMs: firstFailure.atEpochMs,
            }
            : undefined,
        agents: monitor.agentProgress.map(row => {
            const agent = controlAgents.get(row.agentId);
            return {
                agentId: row.agentId,
                role: row.role,
                readiness: row.readiness,
                barrier: row.barrier,
                execution: row.execution,
                eventCount: row.eventCount,
                failedCommandCount: row.failedCommandCount,
                reconnectCount: agent?.reconnectCount,
                lastHeartbeatAtEpochMs: agent?.lastHeartbeatAtEpochMs,
            };
        }),
        recipes: monitor.recipeProgress,
        diagnostics: {
            total: monitor.diagnosticCounts.total,
            warnings: monitor.diagnosticCounts.warning,
            errors: monitor.diagnosticCounts.error,
            ws: monitor.diagnosticCounts.ws,
            rtc: monitor.diagnosticCounts.rtc,
            correlated: correlatedDiagnostics,
        },
        nextActions: explanations,
        rawEvidence: {
            failureKeys: monitor.failures.map(failure => failure.key),
            diagnosticIds: monitor.runtimeDiagnostics.map(row => row.eventId),
            artifactStatus: monitor.artifact.status,
            artifactMessage: monitor.artifact.message,
        },
    };
}

export function deriveRunVerdictView(input: Readonly<{
    distributedRun?: ControlDistributedRunSnapshot;
    monitor?: DistributedRunMonitor;
    report?: DistributedRunAnalysisReport;
    artifactBundle?: ControlDistributedRunArtifactBundle;
    refreshedAtEpochMs?: number;
}>): RunVerdictView {
    if (!input.distributedRun) {
        return {
            verdict: 'no-run',
            tone: 'muted',
            title: 'No run selected',
            summary: 'Start or select a distributed run to inspect recipe evidence.',
            artifactStatus: 'not-loaded',
            artifactMessage: 'No distributed artifact bundle was loaded.',
            refreshedAtEpochMs: input.refreshedAtEpochMs,
            primaryEvidence: [
                { label: 'Evidence', value: 'No run loaded', tone: 'muted' },
            ],
            successSignals: [],
            warningSignals: [],
            causalTrail: [],
        };
    }

    const monitor = input.monitor ?? deriveDistributedRunMonitor({
        distributedRun: input.distributedRun,
        artifactBundle: input.artifactBundle,
    });
    const report = input.report ?? deriveDistributedRunAnalysisReport({
        distributedRun: input.distributedRun,
        artifactBundle: input.artifactBundle,
    });
    const selectedRecipe = input.distributedRun.manifest.recipes[0];
    const recipeLabel = selectedRecipe
        ? [recipeSelectionId(selectedRecipe), selectedRecipe.profile].filter(Boolean).join(' ')
        : undefined;
    const firstAction = report.nextActions[0];
    const warningSignals = runVerdictWarnings(monitor, report);
    const successSignals = runVerdictSuccessSignals(monitor, report);
    const baseVerdict = runVerdictKind(input.distributedRun, report);
    const hasWarnings = warningSignals.length > 0;
    const verdict = baseVerdict === 'passed' && hasWarnings ? 'passed' : baseVerdict;
    const tone = runVerdictTone(verdict, hasWarnings);
    const title = runVerdictTitle(verdict, hasWarnings);
    const linkedFailureCount = report.firstFailure ? 1 : report.rawEvidence.failureKeys.length;
    const linkedEvidence = `${linkedFailureCount} failure${linkedFailureCount === 1 ? '' : 's'} / ${report.rawEvidence.diagnosticIds.length} diagnostic${report.rawEvidence.diagnosticIds.length === 1 ? '' : 's'} / ${monitor.events.length} event${monitor.events.length === 1 ? '' : 's'}`;
    const evidenceItems: RunVerdictEvidenceItem[] = [
        {
            label: 'Commands',
            value: `${monitor.resultCounts.ok}/${Math.max(monitor.commandCounts.total, monitor.resultCounts.total)} ok`,
            tone: monitor.resultCounts.failed > 0 ? 'warn' : 'good',
            detail: `${monitor.commandCounts.completed} completed, ${monitor.commandCounts.pending} pending`,
        },
        {
            label: 'Evidence',
            value: `${monitor.resultCounts.total} results / ${monitor.events.length} events`,
            tone: monitor.events.length > 0 || monitor.resultCounts.total > 0 ? 'active' : 'muted',
            detail: `${monitor.runtimeDiagnostics.length} runtime diagnostics`,
        },
        {
            label: 'Evidence warnings',
            value: String(warningSignals.length),
            tone: warningSignals.length > 0 ? 'warn' : 'good',
        },
        {
            label: 'Slowest',
            value: monitor.latency.maxMs !== undefined ? `${Math.round(monitor.latency.maxMs)} ms` : '-',
            tone: monitor.latency.maxMs !== undefined ? 'active' : 'muted',
        },
        {
            label: 'Artifact',
            value: monitor.artifact.status,
            tone: monitor.artifact.status === 'valid' ? 'good' : 'warn',
            detail: monitor.artifact.message,
        },
    ];

    if (baseVerdict === 'failed') {
        evidenceItems.push({
            label: 'Linked evidence',
            value: linkedEvidence,
            tone: report.rawEvidence.failureKeys.length > 0 ? 'bad' : 'warn',
        });
    }

    return {
        verdict,
        tone,
        title,
        summary: runVerdictSummary(input.distributedRun, report, monitor),
        runId: input.distributedRun.distributedRunId,
        state: input.distributedRun.state,
        recipeLabel,
        profileLabel: selectedRecipe?.profile,
        targetCount: report.summary.targetCount,
        durationMs: report.summary.durationMs,
        artifactStatus: monitor.artifact.status,
        artifactMessage: monitor.artifact.message,
        refreshedAtEpochMs: input.refreshedAtEpochMs,
        likelyCause: firstAction
            ? report.firstFailure?.message ?? firstAction.likelyCause
            : undefined,
        nextAction: firstAction?.category === 'command'
            ? verdictCommandFailureNextAction(report.firstFailure)
            : firstAction?.nextAction,
        primaryEvidence: evidenceItems,
        successSignals,
        warningSignals,
        causalTrail: runVerdictCausalTrail(report, monitor),
    };
}

function runVerdictKind(
    run: ControlDistributedRunSnapshot,
    report: DistributedRunAnalysisReport,
): RunVerdictKind {
    if (report.summary.ok || run.state === 'passed') {
        return 'passed';
    }
    if (run.state === 'failed' || run.state === 'timed-out' || report.firstFailure) {
        return 'failed';
    }
    if (run.state === 'running' || run.state === 'waiting-for-ack' || run.state === 'waiting-for-barrier' || run.state === 'staging') {
        return 'running';
    }
    return 'attention';
}

function runVerdictTone(verdict: RunVerdictKind, hasWarnings: boolean): RunVerdictTone {
    if (verdict === 'failed') return 'bad';
    if (verdict === 'running') return 'active';
    if (verdict === 'passed') return hasWarnings ? 'warn' : 'good';
    if (verdict === 'attention') return 'warn';
    return 'muted';
}

function runVerdictTitle(verdict: RunVerdictKind, hasWarnings: boolean): string {
    if (verdict === 'passed') {
        return hasWarnings ? 'Outcome passed; evidence needs review' : 'Outcome passed';
    }
    if (verdict === 'failed') return 'Outcome failed';
    if (verdict === 'running') return 'Outcome still running';
    if (verdict === 'attention') return 'Outcome needs attention';
    return 'No run selected';
}

function verdictCommandFailureNextAction(
    failure?: DistributedRunAnalysisReport['firstFailure'],
): string {
    const command = failure?.commandId ? `Open command ${failure.commandId}` : 'Open the affected command';
    const agent = failure?.agentId ? ` on agent ${failure.agentId}` : '';
    return `${command}${agent}, inspect the command payload/result, and compare sibling agents running the same recipe.`;
}

function runVerdictWarnings(
    monitor: DistributedRunMonitor,
    report: DistributedRunAnalysisReport,
): readonly string[] {
    const warnings = [
        ...report.summary.snapshotWarnings.map(warning => `Evidence warning: snapshot ${warning}`),
        ...(monitor.artifact.status === 'valid'
            ? []
            : [`Evidence warning: artifact ${monitor.artifact.status === 'not-loaded' ? 'not loaded' : monitor.artifact.status}: ${monitor.artifact.message}`]),
        ...(monitor.resultCounts.failed > 0 ? [`Evidence warning: ${monitor.resultCounts.failed} failed command result${monitor.resultCounts.failed === 1 ? '' : 's'} remained in evidence.`] : []),
        ...(report.diagnostics.warnings > 0 ? [`Evidence warning: ${report.diagnostics.warnings} runtime warning diagnostic${report.diagnostics.warnings === 1 ? '' : 's'}.`] : []),
        ...(report.diagnostics.errors > 0 ? [`Evidence warning: ${report.diagnostics.errors} runtime error diagnostic${report.diagnostics.errors === 1 ? '' : 's'}.`] : []),
    ];
    return uniqueValues(warnings);
}

function runVerdictSuccessSignals(
    monitor: DistributedRunMonitor,
    report: DistributedRunAnalysisReport,
): readonly string[] {
    const okResults = monitor.resultCounts.ok;
    const completed = okResults > 0 ? okResults : monitor.commandCounts.completed;
    const signals = [
        completed > 0 ? `${completed} completed command${completed === 1 ? '' : 's'}` : undefined,
        monitor.events.length > 0 ? `${monitor.events.length} received evidence event${monitor.events.length === 1 ? '' : 's'}` : undefined,
        report.summary.artifactStatus === 'valid' ? 'Artifact bundle is valid.' : undefined,
        report.summary.failedCommandCount === 0 && report.summary.failedResultCount === 0
            ? 'No failed command results in the loaded snapshot.'
            : undefined,
    ];
    return compactStrings(signals);
}

function runVerdictSummary(
    run: ControlDistributedRunSnapshot,
    report: DistributedRunAnalysisReport,
    monitor: DistributedRunMonitor,
): string {
    if (report.firstFailure) {
        return [
            report.firstFailure.category,
            report.firstFailure.agentId ? `agent ${report.firstFailure.agentId}` : undefined,
            report.firstFailure.commandId ? `command ${report.firstFailure.commandId}` : undefined,
            report.firstFailure.message,
        ].filter(Boolean).join(' - ');
    }
    if (report.summary.ok || run.state === 'passed') {
        return `${report.summary.completedCommandCount} commands completed across ${report.summary.targetCount} target${report.summary.targetCount === 1 ? '' : 's'}; ${monitor.events.length} event${monitor.events.length === 1 ? '' : 's'} linked.`;
    }
    return `Run state is ${run.state}; ${monitor.commandCounts.pending} command${monitor.commandCounts.pending === 1 ? '' : 's'} still pending.`;
}

function runVerdictCausalTrail(
    report: DistributedRunAnalysisReport,
    monitor: DistributedRunMonitor,
): readonly RunCausalTrailItem[] {
    if (!report.firstFailure) {
        return [];
    }

    const firstAction = report.nextActions.find(action =>
        action.evidence.includes(report.firstFailure!.key)
    ) ?? report.nextActions[0];
    const correlatedDiagnostics = report.diagnostics.correlated.filter(row =>
        row.correlatedFailureKeys.includes(report.firstFailure!.key)
    );
    const diagnosticEvidence = correlatedDiagnostics.length > 0
        ? correlatedDiagnostics.map(row => row.eventId)
        : report.rawEvidence.diagnosticIds.slice(0, 3);
    const eventEvidence = monitor.events
        .filter(event =>
            event.commandId === report.firstFailure?.commandId ||
            event.agentId === report.firstFailure?.agentId
        )
        .map(event => event.eventId);
    const streamPerformanceEvent = monitor.events.find(event =>
        isRtcStreamPerformanceFailureText(`${event.topic ?? ''} ${event.summary} ${event.payloadSummary}`)
    );
    const isStreamPerformanceFailure = firstAction?.category === 'rtc-stream-performance' ||
        isRtcStreamPerformanceFailureText(`${report.firstFailure.code ?? ''} ${report.firstFailure.message}`);
    const streamAgentId = report.firstFailure.agentId ?? streamPerformanceEvent?.agentId;
    const streamCommandId = report.firstFailure.commandId ?? streamPerformanceEvent?.commandId;
    const streamEventEvidence = eventEvidence.length > 0
        ? eventEvidence
        : streamPerformanceEvent
        ? [streamPerformanceEvent.eventId]
        : [];
    const streamPerformanceItem: RunCausalTrailItem | undefined = isStreamPerformanceFailure
        ? {
              kind: 'stream-performance',
              label: 'Stream pacing evidence',
              detail:
                  'Check frame disposition, in-flight drops, max start drift, late frames, and stream P95/P99 before changing RTC routing or recipe thresholds.',
              tone: 'bad',
              targetKind: streamCommandId ? 'command' : 'agent',
              targetId: streamCommandId ?? streamAgentId,
              actionLabel: 'Inspect stream pacing',
              agentId: streamAgentId,
              recipeId: report.firstFailure.recipeId,
              commandId: streamCommandId,
              atEpochMs: report.firstFailure.atEpochMs,
              evidence: compactStrings([
                  streamCommandId,
                  streamAgentId,
                  report.firstFailure.code,
                  ...streamEventEvidence.slice(0, 3),
              ]),
          }
        : undefined;

    return [
        {
            kind: 'failure-category',
            label: firstAction?.title ?? 'Failure category',
            detail: firstAction?.likelyCause ?? report.firstFailure.message,
            tone: 'bad',
            targetKind: report.firstFailure.commandId ? 'command' : 'agent',
            targetId: report.firstFailure.commandId ?? report.firstFailure.agentId,
            actionLabel: report.firstFailure.commandId
                ? `Open command ${report.firstFailure.commandId}`
                : report.firstFailure.agentId
                ? `Inspect agent ${report.firstFailure.agentId}`
                : 'Inspect first failure',
            agentId: report.firstFailure.agentId,
            recipeId: report.firstFailure.recipeId,
            commandId: report.firstFailure.commandId,
            atEpochMs: report.firstFailure.atEpochMs,
            evidence: compactStrings([report.firstFailure.key, report.firstFailure.code]),
        },
        {
            kind: 'command-result',
            label: report.firstFailure.commandId
                ? `Command ${report.firstFailure.commandId}`
                : 'Distributed result',
            detail: report.firstFailure.message,
            tone: 'bad',
            targetKind: report.firstFailure.commandId ? 'command' : undefined,
            targetId: report.firstFailure.commandId,
            actionLabel: report.firstFailure.commandId
                ? `Open command ${report.firstFailure.commandId}`
                : 'Open distributed result',
            agentId: report.firstFailure.agentId,
            recipeId: report.firstFailure.recipeId,
            commandId: report.firstFailure.commandId,
            atEpochMs: report.firstFailure.atEpochMs,
            evidence: compactStrings([
                report.firstFailure.commandId,
                report.firstFailure.agentId,
                report.firstFailure.recipeId,
            ]),
        },
        ...(streamPerformanceItem ? [streamPerformanceItem] : []),
        {
            kind: 'diagnostic',
            label: correlatedDiagnostics.length > 0
                ? `${correlatedDiagnostics.length} correlated diagnostic${correlatedDiagnostics.length === 1 ? '' : 's'}`
                : 'No correlated diagnostics',
            detail: correlatedDiagnostics[0]?.summary ??
                'No runtime diagnostic was directly correlated to the first failure in the loaded snapshot.',
            tone: correlatedDiagnostics.length > 0 ? 'warn' : 'muted',
            targetKind: 'diagnostic',
            targetId: diagnosticEvidence[0],
            actionLabel: correlatedDiagnostics.length > 0
                ? `Filter diagnostics (${correlatedDiagnostics.length})`
                : 'Filter diagnostics for first failure',
            agentId: correlatedDiagnostics[0]?.agentId ?? report.firstFailure.agentId,
            commandId: correlatedDiagnostics[0]?.commandId ?? report.firstFailure.commandId,
            atEpochMs: correlatedDiagnostics[0]?.atEpochMs,
            evidence: diagnosticEvidence,
        },
        {
            kind: 'artifact',
            label: `Artifact ${report.rawEvidence.artifactStatus}`,
            detail: report.rawEvidence.artifactMessage,
            tone: report.rawEvidence.artifactStatus === 'valid' ? 'good' : 'warn',
            targetKind: 'artifact',
            targetId: report.rawEvidence.artifactStatus,
            actionLabel: 'Inspect artifact evidence',
            evidence: [report.rawEvidence.artifactStatus],
        },
        {
            kind: 'events',
            label: `${eventEvidence.length} linked event${eventEvidence.length === 1 ? '' : 's'}`,
            detail: eventEvidence.length > 0
                ? 'Runtime events were emitted near the failed command or agent.'
                : 'No runtime events were linked to the first failed command or agent.',
            tone: eventEvidence.length > 0 ? 'active' : 'muted',
            targetKind: eventEvidence.length > 0 ? 'event' : undefined,
            targetId: eventEvidence[0],
            actionLabel: eventEvidence.length > 0
                ? `Filter ${eventEvidence.length} linked event${eventEvidence.length === 1 ? '' : 's'}`
                : 'Review event filters',
            agentId: report.firstFailure.agentId,
            commandId: report.firstFailure.commandId,
            evidence: eventEvidence,
        },
    ];
}

export function filterDistributedRuns(
    runs: readonly ControlDistributedRunSnapshot[],
    filter: DistributedRunHistoryFilter,
): readonly ControlDistributedRunSnapshot[] {
    const query = normalizeFilterText(filter.query);
    const groupId = normalizeFilterText(filter.groupId);
    const recipeId = normalizeFilterText(filter.recipeId);
    const profile = normalizeFilterText(filter.profile);
    const user = normalizeFilterText(filter.user);
    const status = normalizeFilterText(filter.status);
    const failureType = normalizeFilterText(filter.failureType);

    return [...runs]
        .filter(run => {
            if (status && normalizeFilterText(run.state) !== status) {
                return false;
            }
            if (groupId && !normalizeFilterText(run.manifest.group.groupId).includes(groupId)) {
                return false;
            }
            if (recipeId && !run.manifest.recipes.some(selection =>
                normalizeFilterText(recipeSelectionId(selection)).includes(recipeId)
            )) {
                return false;
            }
            if (profile && !run.manifest.recipes.some(selection =>
                normalizeFilterText(selection.profile).includes(profile)
            )) {
                return false;
            }
            if (user && !normalizeFilterText(String(run.manifest.metadata?.createdBy ?? '')).includes(user)) {
                return false;
            }
            if (filter.fromEpochMs !== undefined && run.createdAtEpochMs < filter.fromEpochMs) {
                return false;
            }
            if (filter.toEpochMs !== undefined && run.createdAtEpochMs > filter.toEpochMs) {
                return false;
            }
            if (failureType && !distributedRunMatchesFailureType(run, failureType)) {
                return false;
            }
            if (!query) {
                return true;
            }
            return distributedRunSearchText(run).includes(query);
        })
        .sort((left, right) => right.updatedAtEpochMs - left.updatedAtEpochMs);
}

export function compareDistributedRuns(input: Readonly<{
    left: ControlDistributedRunSnapshot;
    right: ControlDistributedRunSnapshot;
    leftControlRun?: ControlRunSnapshot;
    rightControlRun?: ControlRunSnapshot;
}>): DistributedRunCompareSummary {
    const leftRecipes = recipeCompareMap(input.left);
    const rightRecipes = recipeCompareMap(input.right);
    const leftParticipants = new Set(input.left.targetAgentIds);
    const rightParticipants = new Set(input.right.targetAgentIds);
    const leftFailures = distributedRunFailureSignatures(input.left);
    const rightFailures = distributedRunFailureSignatures(input.right);
    const leftMessages = distributedRunReceivedMessageSignatures(input.left, input.leftControlRun);
    const rightMessages = distributedRunReceivedMessageSignatures(input.right, input.rightControlRun);
    const leftDurationMs = distributedRunDuration(input.left);
    const rightDurationMs = distributedRunDuration(input.right);

    return {
        leftId: input.left.distributedRunId,
        rightId: input.right.distributedRunId,
        recipeDelta: {
            leftOnly: setDifference([...leftRecipes.keys()], new Set(rightRecipes.keys())),
            rightOnly: setDifference([...rightRecipes.keys()], new Set(leftRecipes.keys())),
            changedProfiles: [...leftRecipes.entries()]
                .filter(([recipeId, leftProfile]) =>
                    rightRecipes.has(recipeId) && rightRecipes.get(recipeId) !== leftProfile
                )
                .map(([recipeId, leftProfile]) => `${recipeId}: ${leftProfile || '-'} -> ${rightRecipes.get(recipeId) || '-'}`),
        },
        participantDelta: {
            leftOnly: setDifference([...leftParticipants], rightParticipants),
            rightOnly: setDifference([...rightParticipants], leftParticipants),
            shared: [...leftParticipants]
                .filter(agentId => rightParticipants.has(agentId))
                .sort(),
        },
        failureDelta: {
            leftCount: leftFailures.length,
            rightCount: rightFailures.length,
            leftOnly: setDifference(leftFailures, new Set(rightFailures)),
            rightOnly: setDifference(rightFailures, new Set(leftFailures)),
        },
        timingDelta: {
            leftDurationMs,
            rightDurationMs,
            durationDeltaMs: leftDurationMs !== undefined && rightDurationMs !== undefined
                ? rightDurationMs - leftDurationMs
                : undefined,
            startedDeltaMs: input.left.startedAtEpochMs !== undefined && input.right.startedAtEpochMs !== undefined
                ? input.right.startedAtEpochMs - input.left.startedAtEpochMs
                : undefined,
            completedDeltaMs: input.left.completedAtEpochMs !== undefined && input.right.completedAtEpochMs !== undefined
                ? input.right.completedAtEpochMs - input.left.completedAtEpochMs
                : undefined,
        },
        receivedMessageDelta: {
            leftCount: leftMessages.length,
            rightCount: rightMessages.length,
            delta: rightMessages.length - leftMessages.length,
            leftOnly: setDifference(leftMessages, new Set(rightMessages)),
            rightOnly: setDifference(rightMessages, new Set(leftMessages)),
        },
    };
}

export function deriveDistributedRunWarningRegressionReport(input: Readonly<{
    distributedRun: ControlDistributedRunSnapshot;
    controlRun?: ControlRunSnapshot;
    artifactBundle?: ControlDistributedRunArtifactBundle;
    expectation?: DistributedRunWarningRegressionExpectation;
}>): DistributedRunWarningRegressionReport {
    const monitor = deriveDistributedRunMonitor(input);
    const expectation = input.expectation ?? {};
    const expectedMessageEvidence = expectation.messageEvidence ?? [];
    const expectedDiagnosticTypeIds = expectation.diagnosticTypeIds ?? [];
    const expectedCompositeRecipeIds = expectation.compositeRecipeIds ?? [];
    const failOnDiagnosticSeverities = expectation.failOnDiagnosticSeverities ?? ['error'];
    const monitorEvidenceText = distributedRunMonitorEvidenceText(monitor);
    const artifactEvidenceText = input.artifactBundle
        ? Object.values(input.artifactBundle.files).join('\n')
        : '';
    const artifactHasEmbeddedEvidence = Boolean(
        input.artifactBundle?.files['events.jsonl'] || input.artifactBundle?.files['results.jsonl'],
    );
    const monitorMessageEvidence = expectedMessageEvidence
        .filter(value => monitorEvidenceText.includes(value));
    const artifactMessageEvidence = expectedMessageEvidence
        .filter(value => artifactEvidenceText.includes(value));
    const diagnosticTypeIds = uniqueValues(monitor.runtimeDiagnostics.map(row => row.diagnosticTypeId));
    const warningDiagnosticTypeIds = uniqueValues(monitor.runtimeDiagnostics
        .filter(row => row.severity === 'warning')
        .map(row => row.diagnosticTypeId));
    const highSeverityDiagnosticTypeIds = uniqueValues(monitor.runtimeDiagnostics
        .filter(row => failOnDiagnosticSeverities.includes(row.severity))
        .map(row => row.diagnosticTypeId));
    const compositeRecipeIds = uniqueValues(monitor.compositeDrilldowns
        .map(row => row.recipeId ?? row.commandId)
        .filter((value): value is string => Boolean(value)));
    const failures = [
        ...expectedMessageEvidence
            .filter(value => !monitorMessageEvidence.includes(value))
            .map(value => `Monitor evidence is missing expected message payload token: ${value}`),
        ...(
            input.artifactBundle && artifactHasEmbeddedEvidence
                ? expectedMessageEvidence
                    .filter(value => !artifactMessageEvidence.includes(value))
                    .map(value => `Artifact evidence is missing expected message payload token: ${value}`)
                : []
        ),
        ...expectedDiagnosticTypeIds
            .filter(value => !diagnosticTypeIds.includes(value))
            .map(value => `Monitor diagnostics are missing expected diagnostic type: ${value}`),
        ...expectedCompositeRecipeIds
            .filter(value => !compositeRecipeIds.includes(value))
            .map(value => `Monitor composite drilldowns are missing expected recipe: ${value}`),
        ...highSeverityDiagnosticTypeIds
            .map(value => `High-severity runtime diagnostic observed: ${value}`),
        ...(
            input.artifactBundle && monitor.artifact.status !== 'valid'
                ? [`Distributed artifact is ${monitor.artifact.status}: ${monitor.artifact.message}`]
                : []
        ),
    ];

    return {
        schemaVersion: 1,
        distributedRunId: input.distributedRun.distributedRunId,
        ok: failures.length === 0,
        expected: {
            messageEvidence: expectedMessageEvidence,
            diagnosticTypeIds: expectedDiagnosticTypeIds,
            compositeRecipeIds: expectedCompositeRecipeIds,
            failOnDiagnosticSeverities,
        },
        observed: {
            monitorMessageEvidence,
            artifactMessageEvidence,
            diagnosticTypeIds,
            warningDiagnosticTypeIds,
            highSeverityDiagnosticTypeIds,
            compositeRecipeIds,
            artifactStatus: monitor.artifact.status,
        },
        failures,
    };
}

function distributedRecipeTargetRow(
    agent: ControlAgentSnapshot,
    group: RallarBlackBoxDistributedGroupRef,
    nowEpochMs: number,
    staleAfterMs: number,
    requiredCrdtTransports: readonly RallarBlackBoxTestCrdtTransport[],
): DistributedRecipeTargetRow {
    const identity = agent.identity;
    const crdt = identity?.capabilities?.crdt;
    const crdtTransports = crdt?.transports ?? [];
    const lastActiveAtEpochMs = agent.lastHeartbeatAtEpochMs ?? agent.lastSeenAtEpochMs ?? identity?.updatedAtEpochMs;
    const stale = typeof lastActiveAtEpochMs === 'number' && nowEpochMs - lastActiveAtEpochMs > staleAfterMs;
    const base = {
        agentId: agent.agentId,
        connected: agent.connected,
        principalId: identity?.principalId ?? identity?.clientId ?? identity?.username,
        sessionId: identity?.sessionId,
        groupId: identity?.groupId,
        applicationId: identity?.applicationId,
        workspaceId: identity?.workspaceId,
        crdtSupported: crdt?.supported,
        crdtTransports,
        lastHeartbeatAtEpochMs: agent.lastHeartbeatAtEpochMs,
        lastSeenAtEpochMs: agent.lastSeenAtEpochMs,
    };

    if (!identity?.applicationId || !identity.workspaceId || !identity.groupId) {
        return {
            ...base,
            status: 'missing-identity',
            targetable: false,
            reason: 'Agent has not reported enough Rallar identity metadata.',
        };
    }

    if (
        identity.applicationId !== group.applicationId ||
        identity.workspaceId !== group.workspaceId ||
        identity.groupId !== group.groupId
    ) {
        return {
            ...base,
            status: 'different-group',
            targetable: false,
            reason: 'Agent identity does not match the selected global group.',
        };
    }

    if (!agent.connected) {
        return {
            ...base,
            status: 'offline',
            targetable: false,
            reason: 'Agent matches the group but is disconnected from the control server.',
        };
    }

    if (stale) {
        return {
            ...base,
            status: 'stale',
            targetable: false,
            reason: 'Agent matches the group but the last heartbeat is stale.',
        };
    }

    if (requiredCrdtTransports.length > 0 && !crdt?.supported) {
        return {
            ...base,
            status: 'missing-crdt-runtime',
            targetable: false,
            reason: 'Agent matches the group but has not reported a CRDT runtime.',
        };
    }

    const missingCrdtTransport = requiredCrdtTransports
        .find(transport => !crdtTransports.includes(transport));
    if (missingCrdtTransport) {
        return {
            ...base,
            status: 'missing-crdt-transport',
            targetable: false,
            reason: `Agent CRDT runtime does not report ${missingCrdtTransport} transport support.`,
        };
    }

    return {
        ...base,
        status: 'matched',
        targetable: true,
        reason: 'Agent is connected and reports the selected global group.',
    };
}

function buildTargetPolicy(input: Readonly<{
    mode: DistributedRecipeTargetPolicyMode;
    agentIds: readonly string[];
    roles: Readonly<Record<string, readonly string[]>>;
    expectedParticipantCount?: number;
}>): RallarBlackBoxDistributedTargetPolicy {
    const expected = input.expectedParticipantCount && input.expectedParticipantCount > 0
        ? { expectedParticipantCount: Math.floor(input.expectedParticipantCount) }
        : {};
    if (input.mode === 'all-online-group-members') {
        return {
            mode: input.mode,
            ...expected,
        };
    }
    if (input.mode === 'role-map') {
        return {
            mode: input.mode,
            roles: input.roles,
            ...expected,
        };
    }
    return {
        mode: input.mode,
        agentIds: input.agentIds,
        ...expected,
    };
}

function roleAssignmentsForPattern(
    pattern: DistributedRecipeRolePattern,
    agentIds: readonly string[],
): readonly RallarBlackBoxDistributedRoleAssignment[] | undefined {
    const roles = rolesForPattern(pattern, agentIds);
    const assignments = Object.entries(roles).flatMap(([role, ids]) =>
        ids.map(agentId => ({
            role,
            agentId,
            required: true,
        }))
    );
    return assignments.length > 0 ? assignments : undefined;
}

function orderedTargetRoleAssignmentPolicy(
    pattern: DistributedRecipeRolePattern,
): RallarBlackBoxDistributedRoleAssignmentPolicy {
    return {
        mode: 'ordered-targets',
        pattern,
        orderBy: 'agent-id',
    };
}

function rolesForPattern(
    pattern: DistributedRecipeRolePattern,
    agentIds: readonly string[],
): Readonly<Record<string, readonly string[]>> {
    if (pattern === 'all-agents') {
        return {};
    }
    if (pattern === 'sender-receiver') {
        return {
            sender: agentIds.slice(0, 1),
            receiver: agentIds.slice(1, 2),
        };
    }
    if (pattern === 'one-sender-many-receivers') {
        return {
            sender: agentIds.slice(0, 1),
            receiver: agentIds.slice(1),
        };
    }
    return {
        publisher: agentIds.slice(0, 1),
        relay: agentIds.slice(1, 2),
        observer: agentIds.slice(2),
    };
}

function recipeRoleForPattern(
    pattern: DistributedRecipeRolePattern,
    recipeIndex: number,
    recipeCount: number,
): string | undefined {
    if (pattern === 'all-agents' || recipeCount < 2) {
        return undefined;
    }
    if (pattern === 'sender-receiver' || pattern === 'one-sender-many-receivers') {
        return recipeIndex === 0 ? 'sender' : 'receiver';
    }
    const roles = ['publisher', 'relay', 'observer'];
    return roles[Math.min(recipeIndex, roles.length - 1)];
}

type ControlCommandSnapshot = ControlRunSnapshot['commands'][number];
type ControlResultSnapshot = ControlRunSnapshot['results'][number];
type ControlEventSnapshot = ControlRunSnapshot['events'][number];

function distributedRunCommandCounts(
    links: readonly ControlDistributedRunCommandLink[],
    commands: ReadonlyMap<string, ControlCommandSnapshot>,
    resultsByCommandId: ReadonlyMap<string, ControlResultSnapshot>,
): DistributedRunMonitor['commandCounts'] {
    const completed = links.filter(link =>
        resultsByCommandId.has(link.commandId) ||
        commands.get(link.commandId)?.completedAtEpochMs !== undefined
    ).length;
    const failed = links.filter(link => resultsByCommandId.get(link.commandId)?.ok === false).length;

    return {
        total: links.length,
        stage: links.filter(link => link.phase === 'stage').length,
        barrier: links.filter(link => link.phase === 'barrier').length,
        start: links.filter(link => link.phase === 'start').length,
        cancel: links.filter(link => link.phase === 'cancel').length,
        completed,
        failed,
        pending: Math.max(0, links.length - completed),
    };
}

function distributedRunCompositeDrilldowns(
    distributedRun: ControlDistributedRunSnapshot,
    results: readonly ControlResultSnapshot[],
    commands: ReadonlyMap<string, ControlCommandSnapshot>,
): readonly DistributedRunCompositeDrilldown[] {
    const linksByCommandId = new Map(distributedRun.commandLinks.map(link => [link.commandId, link]));
    return results.flatMap(result => {
        const roots = distributedRunCompositeRoots(result.result);
        if (roots.length === 0) {
            return [];
        }

        const link = linksByCommandId.get(result.commandId);
        const command = commands.get(result.commandId);
        const rows = distributedRunCompositeRows(roots);
        if (rows.length === 0) {
            return [];
        }

        const summary = summarizeRallarBlackBoxCompositeResults(roots);
        const failedRows = [...rows]
            .filter(row => !row.ok)
            .sort((left, right) =>
                left.startedAtEpochMs - right.startedAtEpochMs ||
                left.endedAtEpochMs - right.endedAtEpochMs ||
                left.path.localeCompare(right.path)
            );
        const firstFailure = failedRows.find(row => row.depth > 0) ?? failedRows[0];

        return [{
            key: `${result.agentId}:${result.commandId}`,
            commandId: result.commandId,
            agentId: result.agentId,
            recipeId: link?.recipeId ?? commandRecipeId(command),
            role: link?.role,
            phase: link?.phase,
            commandKind: command?.envelope.command.kind ?? result.result?.kind,
            artifactRef: `control-run.json#results[commandId=${result.commandId}]`,
            summary: {
                total: summary.total,
                passed: summary.passed,
                failed: summary.failed,
                cancelled: summary.cancelled,
                skipped: summary.skipped,
                composite: summary.composite,
                leaf: summary.leaf,
            },
            firstFailure,
            groupSummaries: distributedRunCompositeGroupSummaries(roots),
            rows,
        }];
    });
}

function distributedRunCompositeCounts(
    drilldowns: readonly DistributedRunCompositeDrilldown[],
): DistributedRunCompositeCounts {
    return {
        total: drilldowns.length,
        passed: drilldowns.filter(drilldown => drilldown.summary.failed === 0).length,
        failed: drilldowns.filter(drilldown => drilldown.summary.failed > 0).length,
        childResults: drilldowns.reduce((sum, drilldown) => sum + drilldown.summary.total, 0),
        composite: drilldowns.reduce((sum, drilldown) => sum + drilldown.summary.composite, 0),
        leaf: drilldowns.reduce((sum, drilldown) => sum + drilldown.summary.leaf, 0),
    };
}

function distributedRunCompositeFailures(
    drilldowns: readonly DistributedRunCompositeDrilldown[],
): readonly DistributedRunFailureRow[] {
    return drilldowns.flatMap((drilldown): DistributedRunFailureRow[] => {
        if (!drilldown.firstFailure) {
            return [];
        }
        return [{
            kind: 'command',
            key: `${drilldown.commandId}:${drilldown.firstFailure.path}`,
            commandId: drilldown.firstFailure.commandId,
            agentId: drilldown.agentId,
            recipeId: drilldown.recipeId,
            code: drilldown.firstFailure.errorSummary ? undefined : drilldown.firstFailure.status,
            message: drilldown.firstFailure.errorSummary ??
                `${drilldown.firstFailure.kind} ${drilldown.firstFailure.status} at ${drilldown.firstFailure.path}.`,
            atEpochMs: drilldown.firstFailure.endedAtEpochMs,
        }];
    });
}

function distributedRunCompositeRoots(
    result: RallarBlackBoxTestResult | undefined,
): readonly RallarBlackBoxTestResult[] {
    if (!result) {
        return [];
    }

    const recipeResults = recipeRunChildResults(result);
    if (recipeResults.length > 0) {
        return recipeResults.some(compositeMonitorRelevantResult) ? recipeResults : [];
    }

    return compositeMonitorRelevantResult(result) ? [result] : [];
}

function compositeMonitorRelevantResult(result: RallarBlackBoxTestResult): boolean {
    if (
        result.kind === 'loop' ||
        result.kind === 'parallel' ||
        result.kind === 'wait' ||
        result.kind === 'assert'
    ) {
        return true;
    }
    return recipeRunChildResults(result).some(compositeMonitorRelevantResult);
}

function recipeRunChildResults(result: RallarBlackBoxTestResult): readonly RallarBlackBoxTestResult[] {
    if (result.kind !== 'recipe.run') {
        return [];
    }
    const value = asRecord(result.value);
    return Array.isArray(value.results)
        ? value.results.filter(isRallarBlackBoxTestResult)
        : [];
}

function isRallarBlackBoxTestResult(value: unknown): value is RallarBlackBoxTestResult {
    const candidate = asRecord(value);
    return typeof candidate.commandId === 'string' &&
        typeof candidate.kind === 'string' &&
        typeof candidate.status === 'string' &&
        typeof candidate.ok === 'boolean' &&
        isFiniteNumber(candidate.startedAtEpochMs) &&
        isFiniteNumber(candidate.endedAtEpochMs) &&
        isFiniteNumber(candidate.durationMs);
}

function distributedRunCompositeRows(
    roots: readonly RallarBlackBoxTestResult[],
): readonly DistributedRunCompositeRow[] {
    const entries = flattenRallarBlackBoxCompositeResults(roots);
    const displayByPath = new Map(toRallarBlackBoxCompositeDisplayResults(roots)
        .map(row => [row.path, row]));

    return entries.map(entry => {
        const display = displayByPath.get(entry.path);
        const errorSummary = compositeErrorSummary(display?.error ?? entry.result.error);
        return {
            path: entry.path,
            sourceRecipePath: entry.sourceRecipePath,
            parentPath: entry.parentPath,
            parentCommandId: entry.parentCommandId,
            depth: entry.depth,
            childIndex: entry.childIndex,
            commandIndex: entry.commandIndex,
            iteration: entry.iteration,
            groupId: entry.groupId,
            groupIndex: entry.groupIndex,
            originalCommandId: entry.originalCommandId,
            commandId: entry.commandId,
            kind: entry.kind,
            status: entry.status,
            ok: entry.ok,
            startedAtEpochMs: entry.startedAtEpochMs,
            endedAtEpochMs: entry.endedAtEpochMs,
            durationMs: entry.durationMs,
            summary: compositeResultSummary(entry.result, display?.value),
            detail: compositeResultDetail(entry.result, display?.value, errorSummary),
            errorSummary,
            valueSummary: compositeValueSummary(display?.value),
        };
    });
}

function distributedRunCompositeGroupSummaries(
    roots: readonly RallarBlackBoxTestResult[],
): readonly DistributedRunCompositeGroupSummary[] {
    return flattenRallarBlackBoxCompositeResults(roots)
        .flatMap(entry => {
            const value = compositeParallelResultValue(entry.result.value);
            if (!value) {
                return [];
            }
            return value.groups.map((group, groupIndex) => ({
                parentPath: entry.path,
                parentCommandId: entry.commandId,
                groupId: group.groupId,
                groupIndex,
                commandCount: group.commandCount,
                passed: group.passed,
                failed: group.failed,
                cancelled: group.cancelled,
                durationMs: group.durationMs,
                status: compositeGroupStatus(group),
            }));
        });
}

function compositeResultSummary(result: RallarBlackBoxTestResult, displayValue: unknown): string {
    if (result.kind === 'loop') {
        const value = compositeLoopResultValue(result.value);
        if (value) {
            const averageCadenceMs = value.childResultCount > 0
                ? Math.round(result.durationMs / value.childResultCount)
                : undefined;
            return [
                `${value.iterations} iterations`,
                `${value.childResultCount} children`,
                `${value.passed} passed`,
                `${value.failed} failed`,
                value.cancelled ? 'cancelled' : undefined,
                averageCadenceMs !== undefined ? `avg ${averageCadenceMs}ms/result` : undefined,
            ].filter(Boolean).join(' - ');
        }
    }

    if (result.kind === 'parallel') {
        const value = compositeParallelResultValue(result.value);
        if (value) {
            const failedGroups = value.groups
                .filter(group => group.failed > 0)
                .map(group => group.groupId);
            return [
                `${value.groupCount} groups`,
                `max ${value.maxConcurrency}`,
                `${value.passed} passed`,
                `${value.failed} failed`,
                value.cancelled ? 'cancelled' : undefined,
                failedGroups.length > 0 ? `failed groups ${failedGroups.join(', ')}` : undefined,
            ].filter(Boolean).join(' - ');
        }
    }

    if (result.kind === 'wait') {
        const value = compositeWaitResultValue(result.value);
        if (value) {
            return [
                value.matched ? 'matched' : value.timedOut ? 'timed out' : value.cancelled ? 'cancelled' : 'pending',
                waitMatchSummary(value.match),
            ].filter(Boolean).join(' - ');
        }
    }

    if (result.kind === 'assert') {
        const value = compositeAssertResultValue(result.value);
        if (value) {
            return [
                value.passed ? 'passed' : 'failed',
                `${value.source} ${value.operator}`,
                value.expected !== undefined ? `expected ${safePayloadSummary(value.expected)}` : undefined,
            ].filter(Boolean).join(' - ');
        }
    }

    return compositeValueSummary(displayValue) || result.kind;
}

function compositeResultDetail(
    result: RallarBlackBoxTestResult,
    displayValue: unknown,
    errorSummary: string | undefined,
): string | undefined {
    if (errorSummary) {
        return errorSummary;
    }

    if (result.kind === 'assert') {
        const value = compositeAssertResultValue(result.value);
        if (value) {
            return [
                `actual ${safePayloadSummary(value.actual)}`,
                `exists ${value.exists}`,
            ].join(' - ');
        }
    }

    if (result.kind === 'wait') {
        const value = compositeWaitResultValue(result.value);
        if (value?.event) {
            return `event ${safePayloadSummary(value.event)}`;
        }
    }

    if (result.kind === 'loop' || result.kind === 'parallel') {
        return undefined;
    }

    return compositeValueSummary(displayValue);
}

function compositeValueSummary(value: unknown): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    const summary = safePayloadSummary(value);
    return summary.length > 0 ? summary : undefined;
}

function compositeErrorSummary(error: unknown): string | undefined {
    if (error === undefined) {
        return undefined;
    }
    const record = asRecord(error);
    const code = firstString(record.code);
    const message = firstString(record.message);
    if (code || message) {
        return [code, message].filter(Boolean).join(': ');
    }
    return safePayloadSummary(error);
}

function waitMatchSummary(value: unknown): string | undefined {
    const match = asRecord(value);
    return [
        firstString(match.topic),
        firstString(match.commandId),
        firstString(match.connection),
        firstString(match.transport),
        firstString(match.severity),
        firstString(match.payloadPath),
        match.equals !== undefined ? `equals ${safePayloadSummary(match.equals)}` : undefined,
        firstString(match.contains) ? `contains ${firstString(match.contains)}` : undefined,
        typeof match.exists === 'boolean' ? `exists ${match.exists}` : undefined,
    ].filter(Boolean).join(', ') || undefined;
}

function compositeGroupStatus(
    group: Readonly<{ commandCount: number; passed: number; failed: number; cancelled: boolean }>,
): DistributedRunCompositeGroupSummary['status'] {
    if (group.cancelled) {
        return 'cancelled';
    }
    if (group.failed > 0) {
        return 'failed';
    }
    if (group.commandCount === 0) {
        return 'empty';
    }
    return 'passed';
}

function compositeLoopResultValue(value: unknown): RallarBlackBoxTestLoopResultValue | undefined {
    const candidate = asRecord(value) as Partial<RallarBlackBoxTestLoopResultValue>;
    return Array.isArray(candidate.results) &&
        typeof candidate.iterations === 'number' &&
        typeof candidate.childResultCount === 'number'
        ? candidate as RallarBlackBoxTestLoopResultValue
        : undefined;
}

function compositeParallelResultValue(value: unknown): RallarBlackBoxTestParallelResultValue | undefined {
    const candidate = asRecord(value) as Partial<RallarBlackBoxTestParallelResultValue>;
    return Array.isArray(candidate.groups) &&
        typeof candidate.groupCount === 'number' &&
        typeof candidate.maxConcurrency === 'number'
        ? candidate as RallarBlackBoxTestParallelResultValue
        : undefined;
}

function compositeWaitResultValue(value: unknown): RallarBlackBoxTestWaitResultValue | undefined {
    const candidate = asRecord(value) as Partial<RallarBlackBoxTestWaitResultValue>;
    return typeof candidate.matched === 'boolean' && candidate.match !== undefined
        ? candidate as RallarBlackBoxTestWaitResultValue
        : undefined;
}

function compositeAssertResultValue(value: unknown): RallarBlackBoxTestAssertResultValue | undefined {
    const candidate = asRecord(value) as Partial<RallarBlackBoxTestAssertResultValue>;
    return typeof candidate.source === 'string' &&
        typeof candidate.operator === 'string' &&
        typeof candidate.exists === 'boolean' &&
        typeof candidate.passed === 'boolean'
        ? candidate as RallarBlackBoxTestAssertResultValue
        : undefined;
}

function commandRecipeId(command: ControlCommandSnapshot | undefined): string | undefined {
    if (!command) {
        return undefined;
    }
    return command.envelope.command.kind === 'recipe.run' || command.envelope.command.kind === 'recipe.load'
        ? command.envelope.command.recipe?.recipeId
        : undefined;
}

function distributedRunEvents(
    distributedRun: ControlDistributedRunSnapshot,
    controlRun: ControlRunSnapshot | undefined,
): readonly DistributedRunEventRow[] {
    if (!controlRun) {
        return [];
    }
    const linkedCommandIds = new Set(distributedRun.commandLinks.map(link => link.commandId));
    return controlRun.events
        .filter(event =>
            (event.commandId !== undefined && linkedCommandIds.has(event.commandId)) ||
            payloadReferencesDistributedRun(event.payload, distributedRun.distributedRunId)
        )
        .sort((left, right) => left.atEpochMs - right.atEpochMs)
        .map((event, index) => ({
            eventId: event.eventId ?? `${event.agentId}-${event.commandId ?? 'event'}-${index}`,
            atEpochMs: event.atEpochMs,
            kind: event.kind,
            agentId: event.agentId,
            commandId: event.commandId,
            topic: payloadTopic(event.payload),
            summary: eventSummary(event),
            payloadSummary: distributedRunEventPayloadSummary(event.payload),
        }));
}

function distributedRunRuntimeDiagnostics(
    distributedRun: ControlDistributedRunSnapshot,
    controlRun: ControlRunSnapshot | undefined,
): readonly Omit<DistributedRunRuntimeDiagnosticRow, 'correlatedFailureKeys'>[] {
    if (!controlRun) {
        return [];
    }
    const linkedCommandIds = new Set(distributedRun.commandLinks.map(link => link.commandId));
    return controlRun.events
        .filter(event =>
            (event.commandId !== undefined && linkedCommandIds.has(event.commandId)) ||
            payloadReferencesDistributedRun(event.payload, distributedRun.distributedRunId)
        )
        .map((event, index) => distributedRunRuntimeDiagnostic(event, index))
        .filter((row): row is Omit<DistributedRunRuntimeDiagnosticRow, 'correlatedFailureKeys'> =>
            row !== undefined
        )
        .sort((left, right) => left.atEpochMs - right.atEpochMs || left.eventId.localeCompare(right.eventId));
}

function distributedRunRuntimeDiagnostic(
    event: ControlEventSnapshot,
    index: number,
): Omit<DistributedRunRuntimeDiagnosticRow, 'correlatedFailureKeys'> | undefined {
    const runtimeEvent = asRecord(event.payload);
    const normalizedPayload = normalizedRuntimeDiagnosticPayload(event.payload);
    if (!normalizedPayload && event.kind !== 'diagnostic') {
        return undefined;
    }

    const payload = normalizedPayload ?? runtimeEvent;
    const data = asRecord(payload.data);
    const topic = firstString(
        payload.topic,
        runtimeEvent.topic,
        payload.diagnosticTypeId,
        payloadTopic(event.payload),
        event.kind,
    ) ?? 'runtime.diagnostic';
    const diagnosticTypeId = firstString(payload.diagnosticTypeId, topic) ?? topic;
    const transport = diagnosticTransport(firstString(payload.transport, runtimeEvent.transport));
    if (!normalizedPayload && !looksLikeTransportDiagnostic(topic, transport, payload)) {
        return undefined;
    }

    const severity = diagnosticSeverity(firstString(payload.severity, runtimeEvent.severity), event.kind);
    const message = firstString(
        payload.message,
        runtimeEvent.message,
        payload.reason,
        data.message,
        data.reason,
        eventSummary(event),
    ) ?? topic;
    const payloadSummary = safePayloadSummary(payload.data ?? payload.payload ?? runtimeEvent.payload ?? event.payload);
    const expectedLaneId = firstString(
        payload.expectedLaneId,
        payload.expectedLane,
        payload.expectedChannel,
        payload.expectedChannelLabel,
        data.expectedLaneId,
        data.expectedChannel,
        data.expectedChannelLabel,
    );
    const observedLaneId = firstString(
        payload.observedLaneId,
        payload.observedLane,
        payload.observedChannel,
        payload.observedChannelLabel,
        payload.actualChannel,
        data.observedLaneId,
        data.observedChannel,
        data.observedChannelLabel,
        data.actualChannel,
    );

    return {
        eventId: event.eventId ?? `${event.agentId}-${event.commandId ?? 'diagnostic'}-${index}`,
        atEpochMs: numberOrUndefined(payload.atEpochMs) ?? numberOrUndefined(runtimeEvent.atEpochMs) ?? event.atEpochMs,
        severity,
        agentId: event.agentId,
        commandId: firstString(payload.commandId, runtimeEvent.commandId, event.commandId),
        transport,
        topic,
        diagnosticTypeId,
        message,
        summary: diagnosticSummary({
            message,
            transport,
            typeId: firstString(payload.typeId, data.typeId),
            topicId: firstString(payload.topicId, data.topicId),
            contextId: firstString(payload.contextId, data.contextId),
            resourceId: firstString(payload.resourceId, data.resourceId),
            expectedLaneId,
            observedLaneId,
            payloadSummary,
        }),
        payloadSummary,
        connection: firstString(payload.connection, runtimeEvent.connection),
        actor: firstString(payload.actor, runtimeEvent.actor),
        groupId: firstString(payload.groupId, data.groupId),
        roomId: firstString(payload.roomId, data.roomId),
        laneId: firstString(payload.laneId, data.laneId),
        expectedLaneId,
        observedLaneId,
        accepted: booleanOrUndefined(payload.accepted) ?? booleanOrUndefined(data.accepted),
        peerId: firstString(payload.peerId, data.peerId),
        remotePeerId: firstString(payload.remotePeerId, data.remotePeerId),
        senderId: firstString(payload.senderId, data.senderId),
        typeId: firstString(payload.typeId, data.typeId),
        topicId: firstString(payload.topicId, data.topicId),
        contextId: firstString(payload.contextId, data.contextId),
        resourceId: firstString(payload.resourceId, data.resourceId),
        source: firstString(payload.source, runtimeEvent.source),
    };
}

function correlateDistributedRunRuntimeDiagnostics(
    diagnostics: readonly Omit<DistributedRunRuntimeDiagnosticRow, 'correlatedFailureKeys'>[],
    failures: readonly DistributedRunFailureRow[],
): readonly DistributedRunRuntimeDiagnosticRow[] {
    return diagnostics.map(diagnostic => ({
        ...diagnostic,
        correlatedFailureKeys: failures
            .filter(failure => diagnosticCorrelatesWithFailure(diagnostic, failure))
            .map(failure => failure.key),
    }));
}

function diagnosticCorrelatesWithFailure(
    diagnostic: Omit<DistributedRunRuntimeDiagnosticRow, 'correlatedFailureKeys'>,
    failure: DistributedRunFailureRow,
): boolean {
    if (diagnostic.commandId && failure.commandId === diagnostic.commandId) {
        return true;
    }
    if (diagnostic.commandId && failure.key === diagnostic.commandId) {
        return true;
    }
    if (!diagnostic.agentId || failure.agentId !== diagnostic.agentId || failure.atEpochMs === undefined) {
        return false;
    }
    return Math.abs(failure.atEpochMs - diagnostic.atEpochMs) <= 15_000;
}

function distributedRunRuntimeDiagnosticCounts(
    diagnostics: readonly DistributedRunRuntimeDiagnosticRow[],
): DistributedRunRuntimeDiagnosticCounts {
    return {
        total: diagnostics.length,
        info: diagnostics.filter(row => row.severity === 'info' || row.severity === 'debug').length,
        warning: diagnostics.filter(row => row.severity === 'warning').length,
        error: diagnostics.filter(row => row.severity === 'error').length,
        ws: diagnostics.filter(row => row.transport === 'ws').length,
        rtc: diagnostics.filter(row => row.transport === 'realtime' || row.transport === 'messages.rtc').length,
        http: diagnostics.filter(row => row.transport === 'http').length,
        runtime: diagnostics.filter(row => row.transport === undefined).length,
    };
}

function distributedRunFailures(
    distributedRun: ControlDistributedRunSnapshot,
    results: readonly ControlResultSnapshot[],
    commands: ReadonlyMap<string, ControlCommandSnapshot>,
): readonly DistributedRunFailureRow[] {
    const rows: DistributedRunFailureRow[] = [];
    if (distributedRun.error) {
        rows.push({
            kind: 'run',
            key: distributedRun.distributedRunId,
            code: distributedRun.error.code,
            message: distributedRun.error.message,
            atEpochMs: distributedRun.updatedAtEpochMs,
        });
    }

    distributedRun.rollup.failures.forEach(failure => {
        rows.push({
            kind: failure.kind,
            key: failure.key,
            code: failure.error?.code,
            message: failure.error?.message ?? failure.state,
            atEpochMs: distributedRun.updatedAtEpochMs,
            agentId: failure.kind === 'participant' ? failure.key : undefined,
            recipeId: failure.kind === 'recipe' ? failure.key : undefined,
        });
    });

    results
        .filter(result => !result.ok)
        .forEach(result => {
            const command = commands.get(result.commandId);
            rows.push({
                kind: 'command',
                key: result.commandId,
                commandId: result.commandId,
                agentId: result.agentId,
                recipeId: command?.envelope.command.kind === 'recipe.run'
                    ? command.envelope.command.recipe?.recipeId
                    : undefined,
                code: result.error?.code ?? result.result?.error?.code,
                message: result.error?.message ?? result.result?.error?.message ?? 'Command failed.',
                atEpochMs: result.result?.endedAtEpochMs ?? command?.completedAtEpochMs,
            });
        });

    return rows.sort((left, right) => (right.atEpochMs ?? 0) - (left.atEpochMs ?? 0));
}

function firstDistributedFailure(
    failures: readonly DistributedRunFailureRow[],
): DistributedRunFailureRow | undefined {
    return [...failures]
        .sort((left, right) =>
            (left.atEpochMs ?? Number.MAX_SAFE_INTEGER) -
                (right.atEpochMs ?? Number.MAX_SAFE_INTEGER) ||
            left.key.localeCompare(right.key)
        )[0] ?? failures[0];
}

function distributedFailureExplanations(
    distributedRun: ControlDistributedRunSnapshot,
    monitor: DistributedRunMonitor,
    firstFailure: DistributedRunFailureRow | undefined,
): readonly DistributedFailureExplanation[] {
    const explanations: DistributedFailureExplanation[] = [];
    const orderedFailures = firstFailure
        ? [
            firstFailure,
            ...monitor.failures.filter(failure => failure.key !== firstFailure.key),
        ]
        : monitor.failures;

    orderedFailures.slice(0, 6).forEach(failure => {
        explanations.push(explanationForFailure(distributedRun, failure));
    });

    const highSignalDiagnostics = monitor.runtimeDiagnostics
        .filter(row =>
            row.severity === 'error' ||
            row.severity === 'warning' ||
            row.correlatedFailureKeys.length > 0
        )
        .slice(0, 3);
    highSignalDiagnostics.forEach(diagnostic => {
        explanations.push({
            category: 'diagnostic',
            title: `${diagnostic.transport ?? 'Runtime'} diagnostic`,
            likelyCause: diagnostic.summary || diagnostic.message,
            nextAction: diagnostic.transport === 'ws'
                ? 'Inspect the WebSocket topic/payload and confirm every agent is subscribed before the recipe sends.'
                : diagnostic.transport === 'realtime' || diagnostic.transport === 'messages.rtc'
                ? 'Inspect RTC peer, lane, group, and topic evidence; mismatched lane or peer metadata usually means agents joined different realtime contexts.'
                : 'Inspect the correlated diagnostic payload and the command result that emitted it.',
            evidence: compactStrings([
                diagnostic.eventId,
                diagnostic.commandId,
                diagnostic.agentId,
                ...diagnostic.correlatedFailureKeys,
            ]),
        });
    });

    if (explanations.length === 0 && !distributedRun.rollup.ok) {
        explanations.push({
            category: 'unknown',
            title: 'Run ended without linked failure evidence',
            likelyCause: 'The distributed rollup is not OK, but no command result or diagnostic was available in the loaded snapshot.',
            nextAction: 'Load the distributed artifact, refresh the control run with larger bounds, or inspect the raw control-run snapshot.',
            evidence: [distributedRun.distributedRunId],
        });
    }

    if (explanations.length === 0 && !isDistributedAnalysisTerminal(distributedRun.state)) {
        explanations.push({
            category: 'readiness',
            title: 'Run is still collecting evidence',
            likelyCause: 'At least one distributed command is still queued, running, or waiting for agent results.',
            nextAction: 'Keep the agents connected and wait for the live monitor to reach a terminal state.',
            evidence: [distributedRun.distributedRunId],
        });
    }

    return uniqueExplanations(explanations);
}

function explanationForFailure(
    distributedRun: ControlDistributedRunSnapshot,
    failure: DistributedRunFailureRow,
): DistributedFailureExplanation {
    const code = failure.code ?? '';
    const text = `${code} ${failure.message}`.toLowerCase();
    const evidence = compactStrings([
        failure.key,
        failure.code,
        failure.agentId,
        failure.recipeId,
        failure.commandId,
    ]);
    if (code === 'RALLAR_BB_DISTRIBUTED_NO_TARGET_AGENTS' || text.includes('no target')) {
        return {
            category: 'targeting',
            title: 'No target agents resolved',
            likelyCause: 'The selected control run has no connected agents matching the current application, workspace, and group.',
            nextAction: 'Open or restart agents for this group, then refresh target resolution before launching the recipe again.',
            evidence,
        };
    }
    if (code === 'RALLAR_BB_DISTRIBUTED_TARGET_COUNT_MISMATCH' || text.includes('target count')) {
        return {
            category: 'targeting',
            title: 'Target count mismatch',
            likelyCause: 'The recipe expected a fixed participant count, but the resolved agent count was different.',
            nextAction: 'Adjust the expected participant count or connect exactly the intended number of agents before staging.',
            evidence,
        };
    }
    if (code === 'RALLAR_BB_DISTRIBUTED_ACK_TIMEOUT' || text.includes('ack') && text.includes('timeout')) {
        return {
            category: 'readiness',
            title: 'Agent did not ACK staging',
            likelyCause: 'An agent did not load or acknowledge the recipe before ackTimeoutMs expired.',
            nextAction: 'Check that the agent tab is still connected, logged in, and not blocked by a recipe-load error.',
            evidence,
        };
    }
    if (code === 'RALLAR_BB_DISTRIBUTED_BARRIER_TIMEOUT' || text.includes('barrier') && text.includes('timeout')) {
        return {
            category: 'barrier',
            title: 'Barrier timed out',
            likelyCause: 'One or more agents never reported barrier.ready after staging.',
            nextAction: 'Inspect ACK readiness and per-agent execution; the missing agent usually failed before the synchronized start point.',
            evidence,
        };
    }
    if (code === 'RALLAR_BB_DISTRIBUTED_BARRIER_DISCONNECTED' || text.includes('disconnected')) {
        return {
            category: 'barrier',
            title: 'Agent disconnected during barrier',
            likelyCause: 'An agent left the control run while the distributed run waited at the barrier.',
            nextAction: 'Restart the disconnected agent with the same control run and a unique agent ID, then rerun the recipe.',
            evidence,
        };
    }
    if (isRtcStreamPerformanceFailureText(text)) {
        return {
            category: 'rtc-stream-performance',
            title: 'RTC stream pacing/backlog threshold failed',
            likelyCause: failure.message || 'The RTC stream command exceeded pacing, backlog, or frame-drop thresholds.',
            nextAction:
                'Inspect frame disposition, in-flight drops, max start drift, late frames, stream duration percentiles, and slowest stream agents before changing RTC routing or thresholds.',
            evidence,
        };
    }
    if (failure.kind === 'command' || failure.commandId) {
        return {
            category: 'command',
            title: 'Distributed command failed',
            likelyCause: failure.message || 'The browser agent returned a failed command result.',
            nextAction: commandFailureNextAction(distributedRun, failure),
            evidence,
        };
    }
    return {
        category: failureCategory(failure),
        title: 'Distributed run failure',
        likelyCause: failure.message || 'The distributed rollup reported a blocking failure.',
        nextAction: 'Inspect the linked recipe, agent, and raw failure payload for the exact failing stage.',
        evidence,
    };
}

function commandFailureNextAction(
    distributedRun: ControlDistributedRunSnapshot,
    failure: DistributedRunFailureRow,
): string {
    const link = distributedRun.commandLinks.find(candidate => candidate.commandId === failure.commandId);
    if (link?.phase === 'stage') {
        return 'Open the agent progress and recipe-load output; staging failures usually mean invalid recipe JSON, missing auth, or a blocked browser runtime.';
    }
    if (link?.phase === 'barrier') {
        return 'Inspect barrier readiness for every target and confirm all agents stayed connected until the synchronized start.';
    }
    if (link?.phase === 'start') {
        return 'Open the composite drilldown and runtime diagnostics for the failing agent, then compare expected vs observed payload evidence.';
    }
    return 'Inspect the command result, runtime diagnostics, and raw evidence for this command ID.';
}

function isRtcStreamPerformanceFailureText(text: string): boolean {
    const normalized = text.toLowerCase();
    const hasRtcStreamContext = normalized.includes('rallar_black_box_rtc_stream') ||
        normalized.includes('rallar.bb.rtc.stream') ||
        normalized.includes('rtc.stream') ||
        normalized.includes('rtc stream') ||
        normalized.includes('stream pacing');
    const hasInFlightBacklogText = normalized.includes('in-flight') || normalized.includes('in flight');
    return normalized.includes('rallar_black_box_rtc_stream_threshold_failed') ||
        normalized.includes('rallar_black_box_rtc_stream_in_flight_limit') ||
        normalized.includes('rallar.bb.rtc.stream_failed') ||
        normalized.includes('maxdroppedframes') ||
        normalized.includes('minsend success ratio') ||
        normalized.includes('stream pacing') ||
        (hasRtcStreamContext && hasInFlightBacklogText);
}

function failureCategory(failure: DistributedRunFailureRow): DistributedFailureExplanation['category'] {
    const code = failure.code ?? '';
    const text = `${code} ${failure.message}`.toLowerCase();
    if (isRtcStreamPerformanceFailureText(text)) {
        return 'rtc-stream-performance';
    }
    if (text.includes('target')) {
        return 'targeting';
    }
    if (text.includes('ack')) {
        return 'readiness';
    }
    if (text.includes('barrier')) {
        return 'barrier';
    }
    if (failure.kind === 'command' || failure.commandId) {
        return 'command';
    }
    return 'unknown';
}

function distributedSnapshotWarnings(
    controlRun: ControlRunSnapshot | undefined,
    bounds: ControlSnapshotBounds | undefined,
): readonly string[] {
    if (!controlRun || !bounds) {
        return [];
    }
    const checks: ReadonlyArray<readonly [keyof ControlSnapshotBounds, number]> = [
        ['commands', controlRun.commands.length],
        ['results', controlRun.results.length],
        ['events', controlRun.events.length],
        ['stats', controlRun.stats.length],
        ['reports', controlRun.reports.length],
        ['heartbeats', controlRun.heartbeats.length],
    ];
    return checks.flatMap(([key, count]) => {
        const bound = bounds[key];
        return bound !== undefined && bound > 0 && count >= bound
            ? [`Loaded ${count} ${key}; evidence may be truncated by the current snapshot bound.`]
            : [];
    });
}

function isDistributedAnalysisTerminal(state: string): boolean {
    return state === 'passed' || state === 'failed' || state === 'timed-out' || state === 'cancelled';
}

function compactStrings(values: readonly (string | undefined)[]): readonly string[] {
    return uniqueValues(values.filter((value): value is string => Boolean(value && value.length > 0)));
}

function uniqueExplanations(
    explanations: readonly DistributedFailureExplanation[],
): readonly DistributedFailureExplanation[] {
    const seen = new Set<string>();
    return explanations.filter(explanation => {
        const key = `${explanation.category}:${explanation.title}:${explanation.evidence.join(',')}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

function distributedRunTimeline(input: Readonly<{
    distributedRun: ControlDistributedRunSnapshot;
    commands: ReadonlyMap<string, ControlCommandSnapshot>;
    results: readonly ControlResultSnapshot[];
    events: readonly DistributedRunEventRow[];
    runtimeDiagnostics: readonly DistributedRunRuntimeDiagnosticRow[];
    failures: readonly DistributedRunFailureRow[];
    artifact: DistributedRunArtifactValidation;
}>): readonly DistributedRunTimelineItem[] {
    const items: DistributedRunTimelineItem[] = [];
    addTimeline(items, {
        id: 'created',
        atEpochMs: input.distributedRun.createdAtEpochMs,
        kind: 'lifecycle',
        label: 'created',
        tone: 'muted',
    });
    addTimeline(items, {
        id: 'staged',
        atEpochMs: input.distributedRun.stagedAtEpochMs,
        kind: 'lifecycle',
        label: 'staged',
        tone: 'active',
    });
    addTimeline(items, {
        id: 'barrier-started',
        atEpochMs: input.distributedRun.barrierStartedAtEpochMs,
        kind: 'lifecycle',
        label: 'barrier started',
        tone: 'active',
    });
    addTimeline(items, {
        id: 'barrier-completed',
        atEpochMs: input.distributedRun.barrierCompletedAtEpochMs,
        kind: 'lifecycle',
        label: 'barrier ready',
        tone: 'good',
    });
    addTimeline(items, {
        id: 'started',
        atEpochMs: input.distributedRun.startedAtEpochMs,
        kind: 'lifecycle',
        label: 'started',
        tone: 'active',
    });
    addTimeline(items, {
        id: 'cancelled',
        atEpochMs: input.distributedRun.cancelledAtEpochMs,
        kind: 'lifecycle',
        label: 'cancelled',
        tone: 'warn',
    });
    addTimeline(items, {
        id: 'completed',
        atEpochMs: input.distributedRun.completedAtEpochMs,
        kind: 'lifecycle',
        label: 'completed',
        tone: distributedRecipeStateTone(input.distributedRun.state),
    });

    input.distributedRun.commandLinks.forEach(link => {
        const command = input.commands.get(link.commandId);
        addTimeline(items, {
            id: `queued-${link.commandId}`,
            atEpochMs: link.queuedAtEpochMs,
            kind: 'command',
            label: `${link.phase} queued`,
            detail: command?.envelope.command.kind,
            tone: 'muted',
            agentId: link.agentId,
            recipeId: link.recipeId,
            commandId: link.commandId,
            phase: link.phase,
        });
        addTimeline(items, {
            id: `dispatched-${link.commandId}`,
            atEpochMs: command?.dispatchedAtEpochMs,
            kind: 'command',
            label: `${link.phase} dispatched`,
            detail: command?.envelope.command.kind,
            tone: 'active',
            agentId: link.agentId,
            recipeId: link.recipeId,
            commandId: link.commandId,
            phase: link.phase,
        });
        addTimeline(items, {
            id: `completed-${link.commandId}`,
            atEpochMs: command?.completedAtEpochMs,
            kind: 'command',
            label: `${link.phase} completed`,
            detail: command?.envelope.command.kind,
            tone: 'good',
            agentId: link.agentId,
            recipeId: link.recipeId,
            commandId: link.commandId,
            phase: link.phase,
        });
    });

    input.results.forEach(result => {
        addTimeline(items, {
            id: `result-${result.commandId}`,
            atEpochMs: result.result?.endedAtEpochMs,
            kind: 'result',
            label: result.ok ? 'result ok' : 'result failed',
            detail: result.result?.kind,
            tone: result.ok ? 'good' : 'bad',
            agentId: result.agentId,
            commandId: result.commandId,
        });
    });

    input.failures.forEach((failure, index) => {
        addTimeline(items, {
            id: `failure-${failure.key}-${index}`,
            atEpochMs: failure.atEpochMs,
            kind: 'failure',
            label: failure.code ?? failure.kind,
            detail: failure.message,
            tone: 'bad',
            agentId: failure.agentId,
            recipeId: failure.recipeId,
            commandId: failure.commandId,
        });
    });

    input.events.forEach(event => {
        addTimeline(items, {
            id: `event-${event.eventId}`,
            atEpochMs: event.atEpochMs,
            kind: 'event',
            label: event.kind,
            detail: event.summary,
            tone: 'muted',
            agentId: event.agentId,
            commandId: event.commandId,
        });
    });

    input.runtimeDiagnostics.forEach(diagnostic => {
        addTimeline(items, {
            id: `diagnostic-${diagnostic.eventId}`,
            atEpochMs: diagnostic.atEpochMs,
            kind: 'diagnostic',
            label: `${diagnostic.transport ?? 'runtime'} ${diagnostic.severity}`,
            detail: diagnostic.message,
            tone: diagnosticSeverityTone(diagnostic.severity),
            agentId: diagnostic.agentId,
            commandId: diagnostic.commandId,
        });
    });

    return items.sort((left, right) => left.atEpochMs - right.atEpochMs || left.id.localeCompare(right.id));
}

function addTimeline(
    items: DistributedRunTimelineItem[],
    item: Omit<DistributedRunTimelineItem, 'atEpochMs'> & { atEpochMs?: number },
): void {
    if (item.atEpochMs === undefined) {
        return;
    }
    items.push(item as DistributedRunTimelineItem);
}

function distributedRunAgentProgress(input: Readonly<{
    distributedRun: ControlDistributedRunSnapshot;
    commands: ReadonlyMap<string, ControlCommandSnapshot>;
    resultsByCommandId: ReadonlyMap<string, ControlResultSnapshot>;
    events: readonly DistributedRunEventRow[];
}>): readonly DistributedRunAgentProgressRow[] {
    const agentIds = new Set([
        ...input.distributedRun.targetAgentIds,
        ...input.distributedRun.commandLinks.map(link => link.agentId),
    ]);
    return [...agentIds].sort().map(agentId => {
        const links = input.distributedRun.commandLinks.filter(link => link.agentId === agentId);
        const stageLinks = links.filter(link => link.phase === 'stage');
        const barrierLinks = links.filter(link => link.phase === 'barrier');
        const startLinks = links.filter(link => link.phase === 'start');
        const linkedResults = links
            .map(link => input.resultsByCommandId.get(link.commandId))
            .filter((result): result is ControlResultSnapshot => result !== undefined);
        const linkedEvents = input.events.filter(event => event.agentId === agentId);
        const latencies = linkedResults
            .map(result => result.result?.durationMs)
            .filter(isFiniteNumber);
        const lastActivityAtEpochMs = maxNumber([
            ...links.map(link => link.queuedAtEpochMs),
            ...links.map(link => input.commands.get(link.commandId)?.dispatchedAtEpochMs),
            ...links.map(link => input.commands.get(link.commandId)?.completedAtEpochMs),
            ...linkedResults.map(result => result.result?.endedAtEpochMs),
            ...linkedEvents.map(event => event.atEpochMs),
        ]);

        return {
            agentId,
            role: agentRole(input.distributedRun, agentId),
            readiness: linkProgressStatus(stageLinks, input.commands, input.resultsByCommandId, 'ready'),
            barrier: linkProgressStatus(barrierLinks, input.commands, input.resultsByCommandId, 'ready'),
            execution: linkProgressStatus(startLinks, input.commands, input.resultsByCommandId, 'passed'),
            stageCommandCount: stageLinks.length,
            barrierCommandCount: barrierLinks.length,
            startCommandCount: startLinks.length,
            completedCommandCount: links.filter(link =>
                input.resultsByCommandId.has(link.commandId) ||
                input.commands.get(link.commandId)?.completedAtEpochMs !== undefined
            ).length,
            failedCommandCount: linkedResults.filter(result => !result.ok).length,
            resultCount: linkedResults.length,
            eventCount: linkedEvents.length,
            averageLatencyMs: average(latencies),
            lastActivityAtEpochMs,
        };
    });
}

function distributedRunRecipeProgress(input: Readonly<{
    distributedRun: ControlDistributedRunSnapshot;
    commands: ReadonlyMap<string, ControlCommandSnapshot>;
    resultsByCommandId: ReadonlyMap<string, ControlResultSnapshot>;
}>): readonly DistributedRunRecipeProgressRow[] {
    return input.distributedRun.manifest.recipes.map((selection, index) => {
        const recipeId = recipeSelectionId(selection, index);
        const links = input.distributedRun.commandLinks.filter(link =>
            link.recipeId === recipeId ||
            (link.recipeId === undefined && input.distributedRun.manifest.recipes.length === 1)
        );
        const startLinks = links.filter(link => link.phase === 'start');
        const progressLinks = startLinks.length > 0 ? startLinks : links.filter(link => link.phase === 'stage');
        const results = progressLinks
            .map(link => input.resultsByCommandId.get(link.commandId))
            .filter((result): result is ControlResultSnapshot => result !== undefined);
        const targetAgentsWithLinks = new Set(progressLinks.map(link => link.agentId));
        const latencies = results.map(result => result.result?.durationMs).filter(isFiniteNumber);

        return {
            recipeId,
            profile: selection.profile,
            role: selection.role,
            required: selection.required !== false,
            targetCount: input.distributedRun.targetAgentIds.length,
            queuedCount: progressLinks.filter(link =>
                input.commands.get(link.commandId)?.dispatchedAtEpochMs === undefined &&
                !input.resultsByCommandId.has(link.commandId)
            ).length,
            runningCount: progressLinks.filter(link =>
                input.commands.get(link.commandId)?.dispatchedAtEpochMs !== undefined &&
                !input.resultsByCommandId.has(link.commandId)
            ).length,
            passedCount: results.filter(result => result.ok).length,
            failedCount: results.filter(result => !result.ok).length,
            missingCount: Math.max(0, input.distributedRun.targetAgentIds.length - targetAgentsWithLinks.size),
            averageLatencyMs: average(latencies),
        };
    });
}

function distributedRunReadiness(input: Readonly<{
    distributedRun: ControlDistributedRunSnapshot;
    commands: ReadonlyMap<string, ControlCommandSnapshot>;
    resultsByCommandId: ReadonlyMap<string, ControlResultSnapshot>;
}>): readonly DistributedRunReadinessRow[] {
    return input.distributedRun.targetAgentIds.map(agentId => {
        const stageLinks = input.distributedRun.commandLinks
            .filter(link => link.phase === 'stage' && link.agentId === agentId);
        if (stageLinks.length === 0) {
            return {
                agentId,
                role: agentRole(input.distributedRun, agentId),
                status: 'missing',
                error: 'No stage command was queued for this target.',
            };
        }
        const failedLink = stageLinks.find(link => input.resultsByCommandId.get(link.commandId)?.ok === false);
        const pendingLink = stageLinks.find(link => !input.resultsByCommandId.has(link.commandId));
        const representative = failedLink ?? pendingLink ?? stageLinks[stageLinks.length - 1];
        const result = input.resultsByCommandId.get(representative.commandId);
        const command = input.commands.get(representative.commandId);
        const latencyMs = result?.result?.durationMs ??
            durationBetween(representative.queuedAtEpochMs, command?.completedAtEpochMs);

        return {
            agentId,
            role: agentRole(input.distributedRun, agentId),
            status: failedLink
                ? 'failed'
                : pendingLink
                ? command?.dispatchedAtEpochMs !== undefined ? 'running' : 'queued'
                : 'ready',
            commandId: representative.commandId,
            queuedAtEpochMs: representative.queuedAtEpochMs,
            completedAtEpochMs: result?.result?.endedAtEpochMs ?? command?.completedAtEpochMs,
            latencyMs,
            error: result?.error?.message ?? result?.result?.error?.message,
        };
    });
}

function linkProgressStatus(
    links: readonly ControlDistributedRunCommandLink[],
    commands: ReadonlyMap<string, ControlCommandSnapshot>,
    resultsByCommandId: ReadonlyMap<string, ControlResultSnapshot>,
    successStatus: DistributedRunProgressStatus,
): DistributedRunProgressStatus {
    if (links.length === 0) {
        return 'missing';
    }
    if (links.some(link => resultsByCommandId.get(link.commandId)?.ok === false)) {
        return 'failed';
    }
    if (links.every(link => resultsByCommandId.get(link.commandId)?.ok === true)) {
        return successStatus;
    }
    if (links.some(link => commands.get(link.commandId)?.dispatchedAtEpochMs !== undefined)) {
        return 'running';
    }
    return 'queued';
}

function summarizeLatencies(values: readonly number[]): DistributedRunLatencySummary {
    if (values.length === 0) {
        return { count: 0 };
    }
    const sorted = [...values].sort((left, right) => left - right);
    return {
        count: sorted.length,
        minMs: sorted[0],
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        maxMs: sorted[sorted.length - 1],
        averageMs: average(sorted),
    };
}

function validateDistributedRunArtifact(
    bundle: ControlDistributedRunArtifactBundle | undefined,
): DistributedRunArtifactValidation {
    if (!bundle) {
        return {
            status: 'not-loaded',
            fileCount: 0,
            message: 'Artifact bundle has not been loaded.',
        };
    }

    const baseRequiredFiles: ReadonlyArray<keyof ControlDistributedRunArtifactBundle['files']> = [
        'distributed-run.json',
        'manifest.json',
        'control-run.json',
    ];
    const v2RequiredFiles: ReadonlyArray<keyof ControlDistributedRunArtifactBundle['files']> = [
        'report.json',
        'failures.json',
        'metadata.json',
    ];
    const requiredFiles = bundle.artifactSchemaVersion >= 2
        ? [...baseRequiredFiles, ...v2RequiredFiles]
        : baseRequiredFiles;
    const missing = requiredFiles.filter(fileName => bundle.files[fileName] === undefined);
    if (missing.length > 0) {
        return {
            status: 'missing-file',
            fileCount: Object.keys(bundle.files).length,
            message: `Missing ${missing.join(', ')}.`,
        };
    }
    try {
        [...baseRequiredFiles, ...(
            bundle.artifactSchemaVersion >= 2
                ? ['report.json', 'failures.json', 'metadata.json'] as const
                : []
        )].forEach(fileName => JSON.parse(bundle.files[fileName] ?? ''));
    } catch (caught) {
        return {
            status: 'invalid-json',
            fileCount: Object.keys(bundle.files).length,
            message: caught instanceof Error ? caught.message : String(caught),
        };
    }
    return {
        status: 'valid',
        fileCount: Object.keys(bundle.files).length,
        message: bundle.artifactSchemaVersion >= 2
            ? 'Distributed artifact v2 analysis files are present and valid.'
            : 'Distributed artifact v1 snapshot files are present and valid JSON.',
    };
}

function recipeSelectionId(
    selection: RallarBlackBoxDistributedRunRecipeSelection,
    index = 0,
): string {
    return selection.recipeId ?? selection.recipe?.recipeId ?? `recipe-${index + 1}`;
}

function agentRole(
    run: ControlDistributedRunSnapshot,
    agentId: string,
): string | undefined {
    const roles = (run.targetResolution?.roleAssignments ?? run.manifest.roleAssignments)
        ?.filter(assignment => assignment.agentId === agentId)
        .map(assignment => assignment.role) ?? [];
    return roles.length > 0 ? roles.join(', ') : undefined;
}

function recipeCompareMap(run: ControlDistributedRunSnapshot): ReadonlyMap<string, string> {
    return new Map(run.manifest.recipes.map((selection, index) => [
        recipeSelectionId(selection, index),
        selection.profile ?? '',
    ]));
}

function distributedRunFailureSignatures(run: ControlDistributedRunSnapshot): readonly string[] {
    const signatures = run.rollup.failures.map(failure =>
        `${failure.kind}:${failure.key}:${failure.state}:${failure.error?.code ?? ''}:${failure.error?.message ?? ''}`
    );
    if (run.error) {
        signatures.push(`run:${run.error.code}:${run.error.message}`);
    }
    return signatures.sort();
}

function distributedRunReceivedMessageSignatures(
    distributedRun: ControlDistributedRunSnapshot,
    controlRun: ControlRunSnapshot | undefined,
): readonly string[] {
    return distributedRunEvents(distributedRun, controlRun)
        .filter(event => {
            const text = `${event.kind} ${event.topic ?? ''} ${event.summary}`.toLowerCase();
            return text.includes('message') || text.includes('received') || text.includes('payload');
        })
        .map(event => `${event.agentId}:${event.commandId ?? event.eventId}:${event.summary}`)
        .sort();
}

function distributedRunMonitorEvidenceText(monitor: DistributedRunMonitor): string {
    return [
        monitor.distributedRunId,
        monitor.state,
        ...monitor.events.flatMap(event => [
            event.eventId,
            event.kind,
            event.agentId,
            event.commandId,
            event.topic,
            event.summary,
            event.payloadSummary,
        ]),
        ...monitor.runtimeDiagnostics.flatMap(diagnostic => [
            diagnostic.eventId,
            diagnostic.agentId,
            diagnostic.commandId,
            diagnostic.transport,
            diagnostic.severity,
            diagnostic.topic,
            diagnostic.diagnosticTypeId,
            diagnostic.message,
            diagnostic.summary,
            diagnostic.payloadSummary,
            diagnostic.groupId,
            diagnostic.roomId,
            diagnostic.laneId,
            diagnostic.expectedLaneId,
            diagnostic.observedLaneId,
            diagnostic.peerId,
            diagnostic.remotePeerId,
            diagnostic.senderId,
            diagnostic.typeId,
            diagnostic.topicId,
            diagnostic.contextId,
            diagnostic.resourceId,
            diagnostic.source,
            ...diagnostic.correlatedFailureKeys,
        ]),
        ...monitor.compositeDrilldowns.flatMap(drilldown => [
            drilldown.key,
            drilldown.commandId,
            drilldown.agentId,
            drilldown.recipeId,
            drilldown.role,
            drilldown.phase,
            drilldown.commandKind,
            drilldown.artifactRef,
            ...drilldown.rows.flatMap(row => [
                row.path,
                row.sourceRecipePath,
                row.commandId,
                row.originalCommandId,
                row.kind,
                row.status,
                row.summary,
                row.detail,
                row.errorSummary,
                row.valueSummary,
                row.groupId,
            ]),
        ]),
        ...monitor.timeline.flatMap(item => [
            item.id,
            item.kind,
            item.label,
            item.detail,
            item.agentId,
            item.recipeId,
            item.commandId,
            item.phase,
        ]),
    ].filter((value): value is string => typeof value === 'string' && value.length > 0)
        .join('\n');
}

function distributedRunDuration(run: ControlDistributedRunSnapshot): number | undefined {
    const start = run.startedAtEpochMs ?? run.stagedAtEpochMs ?? run.createdAtEpochMs;
    const end = run.completedAtEpochMs ?? run.cancelledAtEpochMs ?? run.updatedAtEpochMs;
    return end >= start ? end - start : undefined;
}

function distributedRunMatchesFailureType(
    run: ControlDistributedRunSnapshot,
    failureType: string,
): boolean {
    const failures = [
        ...run.rollup.failures.map(failure =>
            `${failure.kind} ${failure.state} ${failure.error?.code ?? ''} ${failure.error?.message ?? ''}`
        ),
        run.error ? `run ${run.error.code} ${run.error.message}` : '',
    ].join(' ').toLowerCase();
    if (failureType === 'any') {
        return failures.trim().length > 0;
    }
    return failures.includes(failureType);
}

function distributedRunSearchText(run: ControlDistributedRunSnapshot): string {
    return [
        run.distributedRunId,
        run.controlRunId,
        run.state,
        run.manifest.displayName,
        run.manifest.group.applicationId,
        run.manifest.group.workspaceId,
        run.manifest.group.groupId,
        String(run.manifest.metadata?.createdBy ?? ''),
        ...run.targetAgentIds,
        ...run.manifest.recipes.flatMap((selection, index) => [
            recipeSelectionId(selection, index),
            selection.profile,
            selection.role,
        ]),
        ...distributedRunFailureSignatures(run),
    ].filter(Boolean).join(' ').toLowerCase();
}

function payloadReferencesDistributedRun(payload: unknown, distributedRunId: string): boolean {
    if (!payload || !distributedRunId) {
        return false;
    }
    try {
        return JSON.stringify(payload).includes(distributedRunId);
    } catch (_caught) {
        return false;
    }
}

function normalizedRuntimeDiagnosticPayload(
    payload: unknown,
): (RallarBlackBoxRuntimeDiagnosticPayload & Record<string, unknown>) | undefined {
    const envelope = asRecord(payload);
    const nested = asRecord(envelope.payload);
    if (isRuntimeDiagnosticPayload(nested)) {
        return nested as RallarBlackBoxRuntimeDiagnosticPayload & Record<string, unknown>;
    }
    if (isRuntimeDiagnosticPayload(envelope)) {
        return envelope as RallarBlackBoxRuntimeDiagnosticPayload & Record<string, unknown>;
    }
    return undefined;
}

function isRuntimeDiagnosticPayload(value: Record<string, unknown>): boolean {
    return value.diagnosticSchemaVersion === 1 ||
        typeof value.diagnosticTypeId === 'string';
}

function looksLikeTransportDiagnostic(
    topic: string,
    transport: RallarBlackBoxTestTransport | undefined,
    payload: Record<string, unknown>,
): boolean {
    const data = asRecord(payload.data);
    const text = [
        topic,
        payload.diagnosticTypeId,
        payload.message,
        payload.reason,
        data.message,
        data.reason,
    ].filter(Boolean).join(' ').toLowerCase();
    return transport === 'ws' ||
        transport === 'realtime' ||
        transport === 'messages.rtc' ||
        text.includes('websocket') ||
        text.includes('ws ') ||
        text.includes('unhandled ws') ||
        text.includes('rtc') ||
        text.includes('data channel') ||
        text.includes('data-channel');
}

function diagnosticSeverity(
    value: string | undefined,
    eventKind: string,
): RallarBlackBoxTestSeverity {
    if (value === 'debug' || value === 'info' || value === 'warning' || value === 'error') {
        return value;
    }
    return eventKind === 'diagnostic' ? 'warning' : 'info';
}

function diagnosticSeverityTone(severity: RallarBlackBoxTestSeverity): string {
    if (severity === 'error') {
        return 'bad';
    }
    if (severity === 'warning') {
        return 'warn';
    }
    return 'muted';
}

function diagnosticTransport(value: string | undefined): RallarBlackBoxTestTransport | undefined {
    if (value === 'ws' || value === 'http' || value === 'realtime' || value === 'messages.rtc') {
        return value;
    }
    return undefined;
}

function diagnosticSummary(input: Readonly<{
    message: string;
    transport?: RallarBlackBoxTestTransport;
    typeId?: string;
    topicId?: string;
    contextId?: string;
    resourceId?: string;
    expectedLaneId?: string;
    observedLaneId?: string;
    payloadSummary: string;
}>): string {
    const selector = [
        input.typeId ? `type ${input.typeId}` : undefined,
        input.topicId ? `topic ${input.topicId}` : undefined,
        input.contextId ? `context ${input.contextId}` : undefined,
        input.resourceId ? `resource ${input.resourceId}` : undefined,
    ].filter(Boolean).join(' / ');
    const lane = input.expectedLaneId || input.observedLaneId
        ? `lane ${input.expectedLaneId ?? '-'} -> ${input.observedLaneId ?? '-'}`
        : undefined;
    return [
        input.transport,
        input.message,
        selector,
        lane,
        input.payloadSummary,
    ].filter((value): value is string => Boolean(value && value.length > 0)).join(' - ');
}

function payloadTopic(payload: unknown): string | undefined {
    if (!isRecord(payload)) {
        return undefined;
    }
    return stringOrUndefined(payload.topic) ??
        stringOrUndefined(payload.name) ??
        stringOrUndefined(payload.eventTopic);
}

function eventSummary(event: ControlEventSnapshot): string {
    const payload = event.payload;
    if (isRecord(payload)) {
        const direct = stringOrUndefined(payload.message) ??
            stringOrUndefined(payload.status) ??
            stringOrUndefined(payload.name) ??
            stringOrUndefined(payload.kind) ??
            stringOrUndefined(payload.topic);
        if (direct) {
            return direct;
        }
    }
    return safePayloadSummary(payload);
}

function distributedRunEventPayloadSummary(payload: unknown): string {
    const event = asRecord(payload);
    const nestedPayload = asRecord(event.payload);
    const nestedData = asRecord(nestedPayload.data ?? event.data);
    const fields = [
        ['kind', firstString(event.kind)],
        ['topic', firstString(event.topic, nestedPayload.topic, nestedData.topic, payloadTopic(payload))],
        ['transport', firstString(event.transport, nestedPayload.transport)],
        ['messageId', firstString(event.messageId, nestedPayload.messageId, nestedData.messageId)],
        ['distributedRunId', firstString(event.distributedRunId, nestedPayload.distributedRunId, nestedData.distributedRunId)],
        ['groupId', firstString(event.groupId, nestedPayload.groupId, nestedData.groupId)],
        ['roomId', firstString(event.roomId, nestedPayload.roomId, nestedData.roomId)],
        ['typeId', firstString(event.typeId, nestedPayload.typeId, nestedData.typeId)],
        ['topicId', firstString(event.topicId, nestedPayload.topicId, nestedData.topicId)],
        ['contextId', firstString(event.contextId, nestedPayload.contextId, nestedData.contextId)],
        ['resourceId', firstString(event.resourceId, nestedPayload.resourceId, nestedData.resourceId)],
        ['status', firstString(event.status, nestedPayload.status, nestedData.status)],
    ] as const;
    return fields
        .filter(entry => Boolean(entry[1]))
        .map(([key, value]) => `${key}=${value}`)
        .join(', ');
}

function safePayloadSummary(value: unknown): string {
    if (value === undefined) {
        return '';
    }
    if (typeof value === 'string') {
        return value.length > 180 ? `${value.slice(0, 177)}...` : value;
    }
    try {
        const text = JSON.stringify(value);
        return text.length > 180 ? `${text.slice(0, 177)}...` : text;
    } catch (_caught) {
        return String(value);
    }
}

function normalizeFilterText(value: unknown): string {
    return String(value ?? '').trim().toLowerCase();
}

function setDifference(values: readonly string[], right: ReadonlySet<string>): readonly string[] {
    return values.filter(value => !right.has(value)).sort();
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function average(values: readonly number[]): number | undefined {
    if (values.length === 0) {
        return undefined;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sortedValues: readonly number[], quantile: number): number | undefined {
    if (sortedValues.length === 0) {
        return undefined;
    }
    const index = Math.min(
        sortedValues.length - 1,
        Math.max(0, Math.ceil(sortedValues.length * quantile) - 1),
    );
    return sortedValues[index];
}

function maxNumber(values: readonly (number | undefined)[]): number | undefined {
    const finite = values.filter(isFiniteNumber);
    return finite.length > 0 ? Math.max(...finite) : undefined;
}

function durationBetween(start: number | undefined, end: number | undefined): number | undefined {
    return start !== undefined && end !== undefined && end >= start
        ? end - start
        : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function firstString(...values: readonly unknown[]): string | undefined {
    return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function numberOrUndefined(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
