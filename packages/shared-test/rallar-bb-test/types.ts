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
    'ws.open',
    'ws.send',
    'ws.close',
    'http.request',
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
}>;

export type RallarBlackBoxTestRtcSendCommand =
    & RallarBlackBoxTestCommandBase<'rtc.send'>
    & Readonly<{
    connection?: string;
    send?: unknown;
    expect?: unknown;
    applicationId?: string;
    workspaceId?: string;
    scope?: Readonly<Record<string, unknown>>;
    roomRef?: Readonly<Record<string, unknown>>;
    minSnapshotVersion?: number;
    transport?: Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>;
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
    }>;
}>;

export type RallarBlackBoxTestSimpleCommand =
    | RallarBlackBoxTestCommandBase<'health'>
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
    | RallarBlackBoxTestWsOpenCommand
    | RallarBlackBoxTestWsSendCommand
    | RallarBlackBoxTestWsCloseCommand
    | RallarBlackBoxTestHttpRequestCommand
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

export type RallarBlackBoxTestLoopResultValue = Readonly<{
    commandId: string;
    iterations: number;
    childResultCount: number;
    passed: number;
    failed: number;
    cancelled: boolean;
    results: readonly RallarBlackBoxTestCompositeChildResult[];
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

export type RallarBlackBoxTestRuntime = Readonly<{
    execute(command: RallarBlackBoxTestCommand): Promise<RallarBlackBoxTestResult>;
    state(): RallarBlackBoxTestState;
    recordEvent(event: RallarBlackBoxTestRuntimeEventInput): void;
    subscribe(listener: RallarBlackBoxTestStateListener): () => void;
}>;
