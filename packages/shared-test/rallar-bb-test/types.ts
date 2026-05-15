export type RallarBlackBoxTestCommandKind =
    | 'configure'
    | 'recipe.load'
    | 'recipe.run'
    | 'recipe.cancel'
    | 'rtc.connect'
    | 'rtc.send'
    | 'ws.open'
    | 'ws.send'
    | 'ws.close'
    | 'http.request'
    | 'health'
    | 'stats'
    | 'close'
    | 'reset';

export type RallarBlackBoxTestTransport =
    | 'realtime'
    | 'messages.rtc'
    | 'ws'
    | 'http';

export type RallarBlackBoxTestSeverity = 'debug' | 'info' | 'warning' | 'error';

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

export type RallarBlackBoxTestRtcConnectCommand =
    & RallarBlackBoxTestCommandBase<'rtc.connect'>
    & Readonly<{
    connection?: string;
    actor?: string;
    roomId?: string;
    transport?: Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>;
    rallar?: Readonly<Record<string, unknown>>;
}>;

export type RallarBlackBoxTestRtcSendCommand =
    & RallarBlackBoxTestCommandBase<'rtc.send'>
    & Readonly<{
    connection?: string;
    send?: unknown;
    expect?: unknown;
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
