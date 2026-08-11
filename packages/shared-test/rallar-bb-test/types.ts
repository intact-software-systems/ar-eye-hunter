export const RALLAR_BLACK_BOX_TEST_COMMAND_KINDS = [
    'configure',
    'recipe.load',
    'recipe.run',
    'recipe.cancel',
    'loop',
    'parallel',
    'wait',
    'assert',
    'rtc.connect',
    'rtc.send',
    'rtc.stream',
    'ws.open',
    'ws.send',
    'ws.close',
    'http.request',
    'crdt.open',
    'crdt.apply',
    'crdt.read',
    'crdt.sync',
    'crdt.health',
    'crdt.wait',
    'crdt.undo',
    'crdt.redo',
    'crdt.close',
    'crdt.destroy',
    'director.appoint',
    'director.resign',
    'director.status',
    'director.relay.start',
    'director.intent',
    'director.sync.request',
    'director.relay.stop',
    'health',
    'stats',
    'close',
    'reset',
] as const;

export type RallarBlackBoxTestCommandKind =
    typeof RALLAR_BLACK_BOX_TEST_COMMAND_KINDS[number];

export type RallarBlackBoxTestTransport =
    | 'realtime'
    | 'messages.rtc'
    | 'ws'
    | 'http';

export type RallarBlackBoxTestCrdtTransport =
    | 'local-only'
    | 'ws'
    | 'rtc'
    | 'ws-then-rtc'
    | 'rtc-with-ws-fallback';

export type RallarBlackBoxTestSeverity = 'debug' | 'info' | 'warning' | 'error';

export const RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS = {
    maxDepth: 4,
    maxExpandedCommands: 2_000,
    maxParallelConcurrency: 8,
    maxLoopCount: 10_000,
    maxLoopDurationMs: 3_600_000,
} as const;

export type RallarBlackBoxTestRuntimeStatus =
    | 'idle'
    | 'configured'
    | 'loaded'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled';

export type RallarBlackBoxTestConfig = Readonly<{
    runId?: string;
    agentId?: string;
    environment?: string;
    apiBaseUrl?: string;
    actor?: string;
    sessionId?: string;
    roomId?: string;
    transport?: RallarBlackBoxTestTransport;
    rallar?: Readonly<Record<string, unknown>>;
    browser?: Readonly<Record<string, unknown>>;
    control?: Readonly<Record<string, unknown>>;
    defaults?: Readonly<Record<string, unknown>>;
    fleet?: Readonly<Record<string, unknown>>;
    redaction?: RallarBlackBoxTestRedactionOptions;
}>;

export type RallarBlackBoxTestRedactionOptions = Readonly<{
    keys?: readonly string[];
    keySubstrings?: readonly string[];
    secretValues?: readonly string[];
    replacement?: string;
}>;

export type RallarBlackBoxTestCommandBase<K extends RallarBlackBoxTestCommandKind> = Readonly<{
    kind: K;
    commandId?: string;
    label?: string;
    deadlineEpochMs?: number;
    timeoutMs?: number;
    metadata?: Readonly<Record<string, unknown>>;
}>;

export type RallarBlackBoxTestConfigureCommand =
    & RallarBlackBoxTestCommandBase<'configure'>
    & Readonly<{
    config: RallarBlackBoxTestConfig;
}>;

export type RallarBlackBoxTestRecipe = Readonly<{
    schemaVersion?: 1;
    recipeId: string;
    name?: string;
    description?: string;
    continueOnFailure?: boolean;
    commands: readonly RallarBlackBoxTestCommand[];
    metadata?: Readonly<Record<string, unknown>>;
}>;

export type RallarBlackBoxTestRecipeLoadCommand =
    & RallarBlackBoxTestCommandBase<'recipe.load'>
    & Readonly<{
    recipe: RallarBlackBoxTestRecipe;
}>;

export type RallarBlackBoxTestRecipeRunCommand =
    & RallarBlackBoxTestCommandBase<'recipe.run'>
    & Readonly<{
    recipe?: RallarBlackBoxTestRecipe;
}>;

export type RallarBlackBoxTestLoopThresholds = Readonly<{
    minAchievedRateHz?: number;
    maxAverageStartDriftMs?: number;
    maxStartDriftMs?: number;
    maxJitterMs?: number;
    minSendSuccessRatio?: number;
    failOnBackpressure?: boolean;
}>;

export type RallarBlackBoxTestRecipeCancelCommand =
    & RallarBlackBoxTestCommandBase<'recipe.cancel'>
    & Readonly<{
    reason?: string;
}>;

export type RallarBlackBoxTestLoopCommand =
    & RallarBlackBoxTestCommandBase<'loop'>
    & Readonly<{
    commands: readonly RallarBlackBoxTestCommand[];
    count?: number;
    durationMs?: number;
    intervalMs?: number;
    delayMs?: number;
    continueOnFailure?: boolean;
    maxCommands?: number;
    thresholds?: RallarBlackBoxTestLoopThresholds;
}>;

export type RallarBlackBoxTestParallelGroup = Readonly<{
    groupId?: string;
    label?: string;
    commands: readonly RallarBlackBoxTestCommand[];
    metadata?: Readonly<Record<string, unknown>>;
}>;

export type RallarBlackBoxTestParallelCommand =
    & RallarBlackBoxTestCommandBase<'parallel'>
    & Readonly<{
    groups: readonly RallarBlackBoxTestParallelGroup[];
    maxConcurrency?: number;
    failFast?: boolean;
    continueOnFailure?: boolean;
}>;

export type RallarBlackBoxTestWaitMatch = Readonly<{
    kind?: RallarBlackBoxTestEventKind;
    topic?: string;
    commandId?: string;
    connection?: string;
    transport?: RallarBlackBoxTestTransport;
    severity?: RallarBlackBoxTestSeverity;
    payloadPath?: string;
    equals?: unknown;
    contains?: string;
    exists?: boolean;
}>;

export type RallarBlackBoxTestWaitCommand =
    & RallarBlackBoxTestCommandBase<'wait'>
    & Readonly<{
    match: RallarBlackBoxTestWaitMatch;
    absent?: true;
}>;

export type RallarBlackBoxTestAssertOperator =
    | 'equals'
    | 'notEquals'
    | 'contains'
    | 'exists'
    | 'gte'
    | 'lte';

export type RallarBlackBoxTestAssertCommand =
    & RallarBlackBoxTestCommandBase<'assert'>
    & Readonly<{
    source: string;
    operator: RallarBlackBoxTestAssertOperator;
    expected?: unknown;
}>;

export type RallarBlackBoxTestRtcConnectReadiness = Readonly<{
    minReadyPeers?: number;
    timeoutMs?: number;
    intervalMs?: number;
}>;

export type RallarBlackBoxTestRtcConnectCommand =
    & RallarBlackBoxTestCommandBase<'rtc.connect'>
    & Readonly<{
    connection?: string;
    actor?: string;
    roomId?: string;
    applicationId?: string;
    workspaceId?: string;
    scope?: Readonly<Record<string, unknown>>;
    roomRef?: Readonly<Record<string, unknown>>;
    minSnapshotVersion?: number;
    transport?: Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>;
    rallar?: Readonly<Record<string, unknown>>;
    readiness?: RallarBlackBoxTestRtcConnectReadiness;
}>;

export type RallarBlackBoxTestRtcSendCommand =
    & RallarBlackBoxTestCommandBase<'rtc.send'>
    & Readonly<{
    connection?: string;
    send?: unknown;
    expect?: unknown; // black-box-runner-adapter in-process only; control validators reject it
    applicationId?: string;
    workspaceId?: string;
    scope?: Readonly<Record<string, unknown>>;
    roomRef?: Readonly<Record<string, unknown>>;
    minSnapshotVersion?: number;
    transport?: Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>;
}>;

export type RallarBlackBoxTestRtcStreamThresholds = Readonly<{
    minSendSuccessRatio?: number;
    maxDroppedFrames?: number;
    maxBackpressureCount?: number;
    maxP95SendDurationMs?: number;
    maxP99SendDurationMs?: number;
    maxAverageStartDriftMs?: number;
    maxStartDriftMs?: number;
    maxJitterMs?: number;
}>;

export type RallarBlackBoxTestRtcStreamCommand =
    & RallarBlackBoxTestCommandBase<'rtc.stream'>
    & Readonly<{
    connection?: string;
    actor?: string;
    roomId?: string;
    applicationId?: string;
    workspaceId?: string;
    scope?: Readonly<Record<string, unknown>>;
    roomRef?: Readonly<Record<string, unknown>>;
    minSnapshotVersion?: number;
    transport?: Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>;
    send: unknown;
    count?: number;
    durationMs?: number;
    intervalMs?: number;
    rateHz?: number;
    maxInFlight?: number;
    drainTimeoutMs?: number;
    continueOnSendFailure?: boolean;
    progressEveryMs?: number;
    sampleEvery?: number;
    thresholds?: RallarBlackBoxTestRtcStreamThresholds;
}>;

export type RallarBlackBoxTestWsOpenCommand =
    & RallarBlackBoxTestCommandBase<'ws.open'>
    & Readonly<{
    connection?: string;
    url?: string;
    protocols?: string | readonly string[];
    headers?: Readonly<Record<string, string>>;
}>;

export type RallarBlackBoxTestWsSendCommand =
    & RallarBlackBoxTestCommandBase<'ws.send'>
    & Readonly<{
    connection?: string;
    data?: unknown;
}>;

export type RallarBlackBoxTestWsCloseCommand =
    & RallarBlackBoxTestCommandBase<'ws.close'>
    & Readonly<{
    connection?: string;
    code?: number;
    reason?: string;
}>;

export type RallarBlackBoxTestHttpRequestCommand =
    & RallarBlackBoxTestCommandBase<'http.request'>
    & Readonly<{
    request: Readonly<{
        url?: string;
        path?: string;
        method?: string;
        headers?: Readonly<Record<string, string>>;
        body?: unknown;
        credentials?: RequestCredentials;
        mode?: RequestMode;
    }>;
    response?: Readonly<{
        body?: 'none' | 'text' | 'json';
        maxBodyChars?: number;
        acceptedStatusCodes?: readonly number[];
    }>;
}>;

export type RallarBlackBoxTestCrdtOpenCommand =
    & RallarBlackBoxTestCommandBase<'crdt.open'>
    & Readonly<{
    handle?: string;
    name: string;
    applicationId?: string;
    workspaceId?: string;
    documentId?: string;
    documentType?: string;
    scope?: Readonly<Record<string, unknown>>;
    roomRef?: Readonly<Record<string, unknown>>;
    principalId?: string;
    customScope?: string;
    transport?: RallarBlackBoxTestCrdtTransport;
    persist?: boolean;
    tabSync?: boolean;
    initialValue?: unknown;
    policies?: readonly Readonly<Record<string, unknown>>[];
    validation?: Readonly<Record<string, unknown>>;
    encryption?: Readonly<Record<string, unknown>>;
    durableCatchUp?: false | 'http';
}>;

export type RallarBlackBoxTestCrdtApplyCommand =
    & RallarBlackBoxTestCommandBase<'crdt.apply'>
    & Readonly<{
    handle: string;
    batch: Readonly<Record<string, unknown>>;
}>;

export type RallarBlackBoxTestCrdtReadCommand =
    & RallarBlackBoxTestCommandBase<'crdt.read'>
    & Readonly<{
    handle: string;
}>;

export type RallarBlackBoxTestCrdtSyncCommand =
    & RallarBlackBoxTestCommandBase<'crdt.sync'>
    & Readonly<{
    handle: string;
    reason?: string;
    transport?: RallarBlackBoxTestCrdtTransport;
}>;

export type RallarBlackBoxTestCrdtHealthCommand =
    & RallarBlackBoxTestCommandBase<'crdt.health'>
    & Readonly<{
    handle: string;
}>;

export type RallarBlackBoxTestCrdtWaitConditionSource = 'value' | 'health';

export type RallarBlackBoxTestCrdtWaitOperator =
    | 'equals'
    | 'notEquals'
    | 'contains'
    | 'exists'
    | 'gte'
    | 'lte';

export type RallarBlackBoxTestCrdtWaitCondition = Readonly<{
    source: RallarBlackBoxTestCrdtWaitConditionSource;
    path?: string;
    operator: RallarBlackBoxTestCrdtWaitOperator;
    expected?: unknown;
}>;

export type RallarBlackBoxTestCrdtWaitCommand =
    & RallarBlackBoxTestCommandBase<'crdt.wait'>
    & Readonly<{
    handle: string;
    intervalMs?: number;
    stableForMs?: number;
    sync?: false | Readonly<{
        reason?: string;
        transport?: RallarBlackBoxTestCrdtTransport;
    }>;
    conditions: readonly RallarBlackBoxTestCrdtWaitCondition[];
}>;

export type RallarBlackBoxTestCrdtUndoRedoCommand =
    & RallarBlackBoxTestCommandBase<'crdt.undo' | 'crdt.redo'>
    & Readonly<{
    handle: string;
    targetOperationGroupId: string;
    operations: readonly Readonly<Record<string, unknown>>[];
    operationGroupId?: string;
}>;

export type RallarBlackBoxTestCrdtCloseDestroyCommand =
    & RallarBlackBoxTestCommandBase<'crdt.close' | 'crdt.destroy'>
    & Readonly<{
    handle: string;
}>;

export type RallarBlackBoxTestCrdtCommand =
    | RallarBlackBoxTestCrdtOpenCommand
    | RallarBlackBoxTestCrdtApplyCommand
    | RallarBlackBoxTestCrdtReadCommand
    | RallarBlackBoxTestCrdtSyncCommand
    | RallarBlackBoxTestCrdtHealthCommand
    | RallarBlackBoxTestCrdtWaitCommand
    | RallarBlackBoxTestCrdtUndoRedoCommand
    | RallarBlackBoxTestCrdtCloseDestroyCommand;

export type RallarBlackBoxTestDirectorRoomFields = Readonly<{
    roomId?: string;
    applicationId?: string;
    workspaceId?: string;
    scope?: Readonly<Record<string, unknown>>;
    roomRef?: Readonly<Record<string, unknown>>;
}>;

export type RallarBlackBoxTestDirectorAppointCommand =
    & RallarBlackBoxTestCommandBase<'director.appoint'>
    & RallarBlackBoxTestDirectorRoomFields
    & Readonly<{
    heartbeatTtlMs?: number;
}>;

export type RallarBlackBoxTestDirectorResignCommand =
    & RallarBlackBoxTestCommandBase<'director.resign'>
    & RallarBlackBoxTestDirectorRoomFields;

export type RallarBlackBoxTestDirectorStatusCommand =
    & RallarBlackBoxTestCommandBase<'director.status'>
    & RallarBlackBoxTestDirectorRoomFields
    & Readonly<{
    refresh?: boolean;
    now?: number;
}>;

export type RallarBlackBoxTestDirectorRelayStartCommand =
    & RallarBlackBoxTestCommandBase<'director.relay.start'>
    & RallarBlackBoxTestDirectorRoomFields
    & Readonly<{
    handle: string;
    laneId?: string;
    topicId?: string;
    intentTypeId: string;
    outputTypeId: string;
    heartbeatTypeId?: string;
    snapshotTypeId?: string;
    syncRequestTypeId?: string;
    heartbeatIntervalMs?: number;
    snapshotIntervalMs?: number;
    snapshot?: unknown;
}>;

export type RallarBlackBoxTestDirectorIntentCommand =
    & RallarBlackBoxTestCommandBase<'director.intent'>
    & Readonly<{
    handle: string;
    intent: unknown;
}>;

export type RallarBlackBoxTestDirectorSyncRequestCommand =
    & RallarBlackBoxTestCommandBase<'director.sync.request'>
    & Readonly<{
    handle: string;
    payload?: unknown;
}>;

export type RallarBlackBoxTestDirectorRelayStopCommand =
    & RallarBlackBoxTestCommandBase<'director.relay.stop'>
    & Readonly<{
    handle: string;
}>;

export type RallarBlackBoxTestDirectorCommand =
    | RallarBlackBoxTestDirectorAppointCommand
    | RallarBlackBoxTestDirectorResignCommand
    | RallarBlackBoxTestDirectorStatusCommand
    | RallarBlackBoxTestDirectorRelayStartCommand
    | RallarBlackBoxTestDirectorIntentCommand
    | RallarBlackBoxTestDirectorSyncRequestCommand
    | RallarBlackBoxTestDirectorRelayStopCommand;

export type RallarBlackBoxTestHealthCommand =
    & RallarBlackBoxTestCommandBase<'health'>
    & Readonly<{
    includeRtcDiagnostics?: boolean;
}>;

export type RallarBlackBoxTestSimpleCommand =
    | RallarBlackBoxTestHealthCommand
    | RallarBlackBoxTestCommandBase<'stats'>
    | RallarBlackBoxTestCommandBase<'close'>
    | RallarBlackBoxTestCommandBase<'reset'>;

export type RallarBlackBoxTestCommand =
    | RallarBlackBoxTestConfigureCommand
    | RallarBlackBoxTestRecipeLoadCommand
    | RallarBlackBoxTestRecipeRunCommand
    | RallarBlackBoxTestRecipeCancelCommand
    | RallarBlackBoxTestLoopCommand
    | RallarBlackBoxTestParallelCommand
    | RallarBlackBoxTestWaitCommand
    | RallarBlackBoxTestAssertCommand
    | RallarBlackBoxTestRtcConnectCommand
    | RallarBlackBoxTestRtcSendCommand
    | RallarBlackBoxTestRtcStreamCommand
    | RallarBlackBoxTestWsOpenCommand
    | RallarBlackBoxTestWsSendCommand
    | RallarBlackBoxTestWsCloseCommand
    | RallarBlackBoxTestHttpRequestCommand
    | RallarBlackBoxTestCrdtCommand
    | RallarBlackBoxTestDirectorCommand
    | RallarBlackBoxTestSimpleCommand;

export type RallarBlackBoxTestResultStatus = 'ok' | 'failed' | 'cancelled' | 'skipped';

export type RallarBlackBoxTestError = Readonly<{
    code: string;
    message: string;
    details?: unknown;
}>;

export type RallarBlackBoxTestResult<T = unknown> = Readonly<{
    commandId: string;
    kind: RallarBlackBoxTestCommandKind;
    status: RallarBlackBoxTestResultStatus;
    ok: boolean;
    startedAtEpochMs: number;
    endedAtEpochMs: number;
    durationMs: number;
    value?: T;
    error?: RallarBlackBoxTestError;
    replayed?: boolean;
}>;

export type RallarBlackBoxTestCompositeChildResult = Readonly<{
    commandId: string;
    originalCommandId?: string;
    parentCommandId?: string;
    path?: string;
    sourceRecipePath?: string;
    childIndex?: number;
    commandIndex: number;
    iteration?: number;
    groupId?: string;
    groupIndex?: number;
    result: RallarBlackBoxTestResult;
}>;

export type RallarBlackBoxTestLoopPacingIteration = Readonly<{
    iteration: number;
    scheduledAtEpochMs: number;
    startedAtEpochMs: number;
    endedAtEpochMs: number;
    durationMs: number;
    startDriftMs: number;
    commandCount: number;
    passed: number;
    failed: number;
    cancelled: boolean;
}>;

export type RallarBlackBoxTestLoopPacingSummary = Readonly<{
    requestedIntervalMs: number;
    requestedRateHz?: number;
    plannedIterations: number;
    completedIterations: number;
    skippedIterations: number;
    cancelledIterations: number;
    startedAtEpochMs: number;
    endedAtEpochMs: number;
    elapsedMs: number;
    targetElapsedMs: number;
    achievedRateHz?: number;
    averageIterationDurationMs?: number;
    minStartDriftMs?: number;
    maxStartDriftMs?: number;
    averageStartDriftMs?: number;
    maxJitterMs?: number;
    averageJitterMs?: number;
    lateIterationCount: number;
    lateThresholdMs: number;
    iterations: readonly RallarBlackBoxTestLoopPacingIteration[];
}>;

export type RallarBlackBoxTestSendObservation = Readonly<{
    commandId: string;
    kind: Extract<RallarBlackBoxTestCommandKind, 'rtc.send' | 'ws.send'>;
    transport?: RallarBlackBoxTestTransport;
    durationMs: number;
    ok: boolean;
    status?: string;
    queued?: boolean;
    enqueued?: boolean;
    backpressured?: boolean;
    droppedPayloadCount?: number;
    replacedPayloadCount?: number;
    errorCode?: string;
}>;

export type RallarBlackBoxTestLoopSendSummary = Readonly<{
    sendCount: number;
    succeeded: number;
    failed: number;
    successRatio?: number;
    duration?: Readonly<{
        minMs?: number;
        maxMs?: number;
        averageMs?: number;
        totalMs: number;
    }>;
    queuedCount: number;
    enqueuedCount: number;
    backpressureCount: number;
    droppedPayloadCount: number;
    replacedPayloadCount: number;
    perTransportFailureCounts: Readonly<Record<string, number>>;
    observations: readonly RallarBlackBoxTestSendObservation[];
}>;

export type RallarBlackBoxTestLoopThresholdFailure = Readonly<{
    name: keyof RallarBlackBoxTestLoopThresholds;
    category: 'pacing' | 'delivery' | 'backpressure';
    threshold: number | boolean;
    actual?: number | boolean;
    message: string;
}>;

export type RallarBlackBoxTestLoopResultValue = Readonly<{
    commandId: string;
    iterations: number;
    childResultCount: number;
    passed: number;
    failed: number;
    cancelled: boolean;
    pacing?: RallarBlackBoxTestLoopPacingSummary;
    sends?: RallarBlackBoxTestLoopSendSummary;
    thresholdFailures?: readonly RallarBlackBoxTestLoopThresholdFailure[];
    results: readonly RallarBlackBoxTestCompositeChildResult[];
}>;

export type RallarBlackBoxTestRtcStreamFrameObservation = Readonly<{
    index: number;
    iteration: number;
    commandId: string;
    scheduledAtEpochMs: number;
    startedAtEpochMs?: number;
    completedAtEpochMs?: number;
    startDriftMs?: number;
    durationMs?: number;
    ok: boolean;
    dropped?: boolean;
    backpressured?: boolean;
    status?: string;
    errorCode?: string;
}>;

export type RallarBlackBoxTestRtcStreamThresholdFailure = Readonly<{
    name: keyof RallarBlackBoxTestRtcStreamThresholds;
    category: 'pacing' | 'delivery' | 'backpressure';
    threshold: number | boolean;
    actual?: number | boolean;
    message: string;
}>;

export type RallarBlackBoxTestRtcStreamResultValue = Readonly<{
    commandId: string;
    transport?: Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>;
    plannedFrames: number;
    scheduledFrames: number;
    attemptedFrames: number;
    completedFrames: number;
    failedFrames: number;
    droppedFrames: number;
    backpressureCount: number;
    startedAtEpochMs: number;
    endedAtEpochMs: number;
    elapsedMs: number;
    requestedRateHz?: number;
    achievedScheduleHz?: number;
    achievedCompletionHz?: number;
    pacing: Readonly<{
        intervalMs: number;
        maxStartDriftMs?: number;
        averageStartDriftMs?: number;
        maxJitterMs?: number;
        lateFrameCount: number;
    }>;
    duration: Readonly<{
        minMs?: number;
        p50Ms?: number;
        p95Ms?: number;
        p99Ms?: number;
        maxMs?: number;
        averageMs?: number;
    }>;
    thresholdFailures: readonly RallarBlackBoxTestRtcStreamThresholdFailure[];
    observations: readonly RallarBlackBoxTestRtcStreamFrameObservation[];
}>;

export type RallarBlackBoxTestParallelGroupResult = Readonly<{
    groupId: string;
    commandCount: number;
    passed: number;
    failed: number;
    cancelled: boolean;
    durationMs: number;
    results: readonly RallarBlackBoxTestCompositeChildResult[];
}>;

export type RallarBlackBoxTestParallelResultValue = Readonly<{
    commandId: string;
    groupCount: number;
    maxConcurrency: number;
    passed: number;
    failed: number;
    cancelled: boolean;
    groups: readonly RallarBlackBoxTestParallelGroupResult[];
}>;

export type RallarBlackBoxTestWaitResultValue = Readonly<{
    commandId: string;
    matched: boolean;
    absent?: true;
    timedOut?: boolean;
    cancelled?: boolean;
    match: RallarBlackBoxTestWaitMatch;
    event?: RallarBlackBoxTestEvent;
}>;

export type RallarBlackBoxTestAssertResultValue = Readonly<{
    commandId: string;
    source: string;
    operator: RallarBlackBoxTestAssertOperator;
    expected?: unknown;
    actual?: unknown;
    exists: boolean;
    passed: boolean;
}>;

export type RallarBlackBoxTestEventKind =
    | 'event'
    | 'diagnostic'
    | 'message'
    | 'stats'
    | 'report'
    | 'result'
    | 'state';

export type RallarBlackBoxTestEvent<T = unknown> = Readonly<{
    eventId: string;
    kind: RallarBlackBoxTestEventKind;
    topic: string;
    atEpochMs: number;
    commandId?: string;
    connection?: string;
    actor?: string;
    transport?: RallarBlackBoxTestTransport;
    severity?: RallarBlackBoxTestSeverity;
    payload?: T;
}>;

export type RallarBlackBoxTestRuntimeEventInput =
    Omit<RallarBlackBoxTestEvent, 'eventId' | 'atEpochMs'>;

export type RallarBlackBoxTestStatsSnapshot = Readonly<{
    atEpochMs: number;
    runId?: string;
    agentId?: string;
    status: RallarBlackBoxTestRuntimeStatus;
    counters: Readonly<{
        commands: number;
        events: number;
        failures: number;
        messages: number;
        diagnostics: number;
        reconnects?: number;
    }>;
    lastCommandId?: string;
    lastEventAtEpochMs?: number;
    commandLatency?: Readonly<{
        count: number;
        minMs?: number;
        maxMs?: number;
        averageMs?: number;
        lastMs?: number;
    }>;
    rallar?: Readonly<{
        connected?: boolean;
        actor?: string;
        sessionId?: string;
        roomId?: string;
        transport?: RallarBlackBoxTestTransport;
        peerCount?: number;
        laneHealth?: unknown;
    }>;
    load?: Readonly<{
        loopCount: number;
        latestLoopCommandId?: string;
        latestPacing?: Omit<RallarBlackBoxTestLoopPacingSummary, 'iterations'>;
        latestSends?: Omit<RallarBlackBoxTestLoopSendSummary, 'observations'>;
        thresholdFailures?: readonly RallarBlackBoxTestLoopThresholdFailure[];
        streamCount?: number;
        latestStreamCommandId?: string;
        latestStream?: Omit<RallarBlackBoxTestRtcStreamResultValue, 'observations'>;
    }>;
}>;

export type RallarBlackBoxTestReportFragment = Readonly<{
    reportId: string;
    runId?: string;
    agentId?: string;
    atEpochMs: number;
    summary?: unknown;
    results?: readonly RallarBlackBoxTestResult[];
    events?: readonly RallarBlackBoxTestEvent[];
    stats?: RallarBlackBoxTestStatsSnapshot;
}>;

export type RallarBlackBoxTestState = Readonly<{
    status: RallarBlackBoxTestRuntimeStatus;
    currentConfig?: RallarBlackBoxTestConfig;
    loadedRecipe?: RallarBlackBoxTestRecipe;
    activeCommand?: RallarBlackBoxTestCommand & Readonly<{ commandId: string }>;
    activeCommandStartedAtEpochMs?: number;
    commandHistory: readonly RallarBlackBoxTestResult[];
    events: readonly RallarBlackBoxTestEvent[];
    latestStats?: RallarBlackBoxTestStatsSnapshot;
    failures: readonly RallarBlackBoxTestResult[];
    resultCache: Readonly<Record<string, RallarBlackBoxTestResult>>;
}>;

export type RallarBlackBoxTestStateListener = (
    state: RallarBlackBoxTestState,
) => void | Promise<void>;

export type RallarBlackBoxTestCommandOutcome = Readonly<{
    status: RallarBlackBoxTestResultStatus;
    value?: unknown;
    error?: RallarBlackBoxTestError;
    nextStatus?: RallarBlackBoxTestRuntimeStatus;
}>;

export type RallarBlackBoxTestCommandContext = Readonly<{
    state(): RallarBlackBoxTestState;
    config(): RallarBlackBoxTestConfig | undefined;
    abortSignal?(): AbortSignal | undefined;
    recordEvent(event: RallarBlackBoxTestRuntimeEventInput): void;
    updateStats(commandId?: string): RallarBlackBoxTestStatsSnapshot;
}>;

export type RallarBlackBoxTestCommandExecutor = (
    command: RallarBlackBoxTestCommand & Readonly<{ commandId: string }>,
    context: RallarBlackBoxTestCommandContext,
) =>
    | RallarBlackBoxTestCommandOutcome
    | undefined
    | Promise<RallarBlackBoxTestCommandOutcome | undefined>;

export type RallarBlackBoxTestCleanupReason =
    | 'cancelled'
    | 'failed'
    | 'timed-out';

export type RallarBlackBoxTestCleanupInput = Readonly<{
    reason: RallarBlackBoxTestCleanupReason;
    commandId?: string;
    recipeId?: string;
    status?: RallarBlackBoxTestResultStatus;
    error?: RallarBlackBoxTestError;
}>;

export type RallarBlackBoxTestRuntimeCleanup = (
    input: RallarBlackBoxTestCleanupInput,
    context: RallarBlackBoxTestCommandContext,
) => void | Promise<void>;

export type RallarBlackBoxTestRuntime = Readonly<{
    execute(command: RallarBlackBoxTestCommand): Promise<RallarBlackBoxTestResult>;
    state(): RallarBlackBoxTestState;
    recordEvent(event: RallarBlackBoxTestRuntimeEventInput): void;
    subscribe(listener: RallarBlackBoxTestStateListener): () => void;
}>;
