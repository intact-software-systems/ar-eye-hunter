import type { ALDeliveryState } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
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
    'messages.send',
    'messages.observe',
    'messages.cancel',
    'messages.received',
    'messages.receipts',
    'fault.inject',
    'storage.counters',
    'agent.reload',
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
    'formation.command',
    'formation.readiness',
    'health',
    'stats',
    'close',
    'reset'
] as const;

export type RallarBlackBoxTestCommandKind = typeof RALLAR_BLACK_BOX_TEST_COMMAND_KINDS[number];

/** An object a command carries verbatim to the runtime; the boundary decoders narrow it. */
export type RallarBlackBoxTestRecord = Readonly<Record<string, unknown>>;

/** The JSON a command carries as a message payload. */
export type RallarBlackBoxTestJsonValue =
    | RallarBlackBoxTestRecord
    | readonly RallarBlackBoxTestJsonValue[]
    | string
    | number
    | boolean
    | null;

export type RallarBlackBoxTestTransport =
    | 'realtime'
    | 'messages.rtc'
    | 'messages.ws'
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
    maxLoopDurationMs: 3_600_000
} as const;

export type RallarBlackBoxTestRuntimeStatus =
    | 'idle'
    | 'configured'
    | 'loaded'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled';

export interface RallarBlackBoxTestConfig {
    readonly runId?: string;
    readonly agentId?: string;
    readonly environment?: string;
    readonly apiBaseUrl?: string;
    readonly actor?: string;
    readonly sessionId?: string;
    readonly roomId?: string;
    readonly transport?: RallarBlackBoxTestTransport;
    readonly rallar?: RallarBlackBoxTestRecord;
    readonly browser?: RallarBlackBoxTestRecord;
    readonly control?: RallarBlackBoxTestRecord;
    readonly defaults?: RallarBlackBoxTestRecord;
    readonly fleet?: RallarBlackBoxTestRecord;
    readonly redaction?: RallarBlackBoxTestRedactionOptions;
}

export interface RallarBlackBoxTestRedactionOptions {
    readonly keys?: readonly string[];
    readonly keySubstrings?: readonly string[];
    readonly secretValues?: readonly string[];
    readonly replacement?: string;
}

export type RallarBlackBoxTestCommandBase<K extends RallarBlackBoxTestCommandKind> = Readonly<{
    kind: K;
    commandId?: string;
    label?: string;
    deadlineEpochMs?: number;
    timeoutMs?: number;
    metadata?: RallarBlackBoxTestRecord;
}>;

export type RallarBlackBoxTestConfigureCommand =
    & RallarBlackBoxTestCommandBase<'configure'>
    & Readonly<{
        config: RallarBlackBoxTestConfig;
    }>;

export interface RallarBlackBoxTestRecipe {
    readonly schemaVersion: 1;
    readonly recipeId: string;
    readonly name?: string;
    readonly description?: string;
    readonly continueOnFailure?: boolean;
    readonly commands: readonly RallarBlackBoxTestCommand[];
    readonly metadata?: RallarBlackBoxTestRecord;
}

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

export interface RallarBlackBoxTestLoopThresholds {
    readonly minAchievedRateHz?: number;
    readonly maxAverageStartDriftMs?: number;
    readonly maxStartDriftMs?: number;
    readonly maxJitterMs?: number;
    readonly minSendSuccessRatio?: number;
}

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
        until?: 'first-success';
        backoffMultiplier?: number;
        maxCommands?: number;
        thresholds?: RallarBlackBoxTestLoopThresholds;
    }>;

export interface RallarBlackBoxTestParallelGroup {
    readonly groupId?: string;
    readonly label?: string;
    readonly commands: readonly RallarBlackBoxTestCommand[];
    readonly metadata?: RallarBlackBoxTestRecord;
}

export type RallarBlackBoxTestParallelCommand =
    & RallarBlackBoxTestCommandBase<'parallel'>
    & Readonly<{
        groups: readonly RallarBlackBoxTestParallelGroup[];
        maxConcurrency?: number;
        failFast?: boolean;
        continueOnFailure?: boolean;
    }>;

export interface RallarBlackBoxTestWaitMatch {
    readonly kind?: RallarBlackBoxTestEventKind;
    readonly topic?: string;
    readonly commandId?: string;
    readonly connection?: string;
    readonly transport?: RallarBlackBoxTestTransport;
    readonly severity?: RallarBlackBoxTestSeverity;
    readonly payloadPath?: string;
    readonly equals?: unknown;
    readonly contains?: string;
    readonly exists?: boolean;
    readonly sinceEpochMs?: number;
}

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
    | 'lte'
    | 'gt'
    | 'lt'
    | 'between'
    | 'length'
    | 'matches'
    | 'matchesShape'
    | 'matchesShapeComplete';

export type RallarBlackBoxTestAssertCommand =
    & RallarBlackBoxTestCommandBase<'assert'>
    & Readonly<{
        source: string;
        operator: RallarBlackBoxTestAssertOperator;
        expected?: unknown;
    }>;

export interface RallarBlackBoxTestRtcConnectReadiness {
    readonly minReadyPeers?: number;
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
}

export type RallarBlackBoxTestRtcConnectCommand =
    & RallarBlackBoxTestCommandBase<'rtc.connect'>
    & Readonly<{
        connection?: string;
        actor?: string;
        roomId?: string;
        applicationId?: string;
        workspaceId?: string;
        scope?: RallarBlackBoxTestRecord;
        roomRef?: RallarBlackBoxTestRecord;
        minSnapshotVersion?: number;
        // Only a connect names messages.ws: it subscribes the typed inbound channel with no RTC lane.
        transport?: Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc' | 'messages.ws'>;
        rallar?: RallarBlackBoxTestRecord;
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
        scope?: RallarBlackBoxTestRecord;
        roomRef?: RallarBlackBoxTestRecord;
        minSnapshotVersion?: number;
        transport?: Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>;
    }>;

export type RallarBlackBoxTestMessagesCarrier = 'ws' | 'rtc' | 'rtc-with-ws-fallback';

export type RallarBlackBoxTestMessagesSendCommand =
    & RallarBlackBoxTestCommandBase<'messages.send'>
    & Readonly<{
        connection?: string;
        carrier: RallarBlackBoxTestMessagesCarrier;
        typeId: string;
        topicId?: string;
        payload: RallarBlackBoxTestJsonValue;
        roomRef?: RallarBlackBoxTestRecord;
        scope?: 'room' | 'world' | 'all';
        reliability?: 'best-effort' | 'at-least-once';
        ack?: 'none' | 'receiver' | 'all-logical-recipients' | 'group-leader';
        ttlMs?: number;
        orderingKey?: string;
        seq?: number;
        handleId?: string;
    }>;

export type RallarBlackBoxTestMessagesObserveCommand =
    & RallarBlackBoxTestCommandBase<'messages.observe'>
    & Readonly<{
        connection?: string;
        handleId: string;
        state: readonly ALDeliveryState[];
    }>;

export type RallarBlackBoxTestMessagesCancelCommand =
    & RallarBlackBoxTestCommandBase<'messages.cancel'>
    & Readonly<{ connection?: string; handleId: string; }>;

export type RallarBlackBoxTestMessagesReceivedCommand =
    & RallarBlackBoxTestCommandBase<'messages.received'>
    & Readonly<{
        connection?: string;
        typeId: string;
        msgId?: string;
        count: number;
        absent?: boolean;
        windowMs: number;
    }>;

export type RallarBlackBoxTestMessagesReceiptsCommand =
    & RallarBlackBoxTestCommandBase<'messages.receipts'>
    & Readonly<{ connection?: string; handleId: string; }>;

export type RallarBlackBoxTestFaultInjectCommand =
    & RallarBlackBoxTestCommandBase<'fault.inject'>
    & Readonly<{
        faultId: string;
        carrier: 'ws' | 'rtc';
        match: Readonly<{ controlType?: 'ack' | 'nack' | 'repair'; typeId?: string; msgId?: string; }>;
        action: 'drop' | Readonly<{ delayMs: number; }>;
        remaining: number;
    }>;

export type RallarBlackBoxTestStorageCountersCommand =
    & RallarBlackBoxTestCommandBase<'storage.counters'>
    & Readonly<{ reset?: boolean; }>;

export type RallarBlackBoxTestAgentReloadCommand =
    & RallarBlackBoxTestCommandBase<'agent.reload'>
    & Readonly<{ readyTimeoutMs: number; }>;

export interface RallarBlackBoxTestRtcStreamThresholds {
    readonly minSendSuccessRatio?: number;
    readonly maxDroppedFrames?: number;
    readonly maxP95SendDurationMs?: number;
    readonly maxP99SendDurationMs?: number;
    readonly maxAverageStartDriftMs?: number;
    readonly maxStartDriftMs?: number;
    readonly maxJitterMs?: number;
}

export type RallarBlackBoxTestRtcStreamCommand =
    & RallarBlackBoxTestCommandBase<'rtc.stream'>
    & Readonly<{
        connection?: string;
        actor?: string;
        roomId?: string;
        applicationId?: string;
        workspaceId?: string;
        scope?: RallarBlackBoxTestRecord;
        roomRef?: RallarBlackBoxTestRecord;
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
        data: unknown;
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
        scope?: RallarBlackBoxTestRecord;
        roomRef?: RallarBlackBoxTestRecord;
        principalId?: string;
        customScope?: string;
        transport?: RallarBlackBoxTestCrdtTransport;
        persist?: boolean;
        tabSync?: boolean;
        initialValue?: unknown;
        policies?: readonly RallarBlackBoxTestRecord[];
        validation?: RallarBlackBoxTestRecord;
        encryption?: RallarBlackBoxTestRecord;
        durableCatchUp?: false | 'http';
    }>;

export type RallarBlackBoxTestCrdtApplyCommand =
    & RallarBlackBoxTestCommandBase<'crdt.apply'>
    & Readonly<{
        handle: string;
        batch: RallarBlackBoxTestRecord;
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

export interface RallarBlackBoxTestCrdtWaitCondition {
    readonly source: RallarBlackBoxTestCrdtWaitConditionSource;
    readonly path?: string;
    readonly operator: RallarBlackBoxTestCrdtWaitOperator;
    readonly expected?: unknown;
}

export type RallarBlackBoxTestCrdtWaitCommand =
    & RallarBlackBoxTestCommandBase<'crdt.wait'>
    & Readonly<{
        handle: string;
        intervalMs?: number;
        stableForMs?: number;
        sync?:
            | false
            | Readonly<{
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
        operations: readonly RallarBlackBoxTestRecord[];
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

export interface RallarBlackBoxTestRoomFields {
    readonly roomId?: string;
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly scope?: RallarBlackBoxTestRecord;
    readonly roomRef?: RallarBlackBoxTestRecord;
}

export type RallarBlackBoxTestDirectorAppointCommand =
    & RallarBlackBoxTestCommandBase<'director.appoint'>
    & RallarBlackBoxTestRoomFields
    & Readonly<{
        heartbeatTtlMs?: number;
    }>;

export type RallarBlackBoxTestDirectorResignCommand =
    & RallarBlackBoxTestCommandBase<'director.resign'>
    & RallarBlackBoxTestRoomFields;

export type RallarBlackBoxTestDirectorStatusCommand =
    & RallarBlackBoxTestCommandBase<'director.status'>
    & RallarBlackBoxTestRoomFields
    & Readonly<{
        refresh?: boolean;
        now?: number;
    }>;

export type RallarBlackBoxTestDirectorRelayStartCommand =
    & RallarBlackBoxTestCommandBase<'director.relay.start'>
    & RallarBlackBoxTestRoomFields
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

export type RallarBlackBoxTestFormationCommandCommand =
    & RallarBlackBoxTestCommandBase<'formation.command'>
    & RallarBlackBoxTestRoomFields
    & Readonly<{
        command: string;
        layout?: RallarBlackBoxTestRecord;
        landing?: string;
        reason?: string;
    }>;

export type RallarBlackBoxTestFormationReadinessCommand =
    & RallarBlackBoxTestCommandBase<'formation.readiness'>
    & RallarBlackBoxTestRoomFields;

export type RallarBlackBoxTestFormationCommand =
    | RallarBlackBoxTestFormationCommandCommand
    | RallarBlackBoxTestFormationReadinessCommand;

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
    | RallarBlackBoxTestMessagesSendCommand
    | RallarBlackBoxTestMessagesObserveCommand
    | RallarBlackBoxTestMessagesCancelCommand
    | RallarBlackBoxTestMessagesReceivedCommand
    | RallarBlackBoxTestMessagesReceiptsCommand
    | RallarBlackBoxTestFaultInjectCommand
    | RallarBlackBoxTestStorageCountersCommand
    | RallarBlackBoxTestAgentReloadCommand
    | RallarBlackBoxTestWsOpenCommand
    | RallarBlackBoxTestWsSendCommand
    | RallarBlackBoxTestWsCloseCommand
    | RallarBlackBoxTestHttpRequestCommand
    | RallarBlackBoxTestCrdtCommand
    | RallarBlackBoxTestDirectorCommand
    | RallarBlackBoxTestFormationCommand
    | RallarBlackBoxTestSimpleCommand;

export type RallarBlackBoxTestResultStatus = 'ok' | 'failed' | 'cancelled' | 'skipped';

export interface RallarBlackBoxTestError {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
}

export interface RallarBlackBoxTestResult<T = unknown> {
    readonly commandId: string;
    readonly kind: RallarBlackBoxTestCommandKind;
    readonly status: RallarBlackBoxTestResultStatus;
    readonly ok: boolean;
    readonly startedAtEpochMs: number;
    readonly endedAtEpochMs: number;
    readonly durationMs: number;
    readonly value?: T;
    readonly error?: RallarBlackBoxTestError;
    readonly replayed?: boolean;
}

export interface RallarBlackBoxTestCompositeChildResult {
    readonly commandId: string;
    readonly originalCommandId?: string;
    readonly parentCommandId?: string;
    readonly path?: string;
    readonly sourceRecipePath?: string;
    readonly childIndex?: number;
    readonly commandIndex: number;
    readonly iteration?: number;
    readonly groupId?: string;
    readonly groupIndex?: number;
    readonly result: RallarBlackBoxTestResult;
}

export interface RallarBlackBoxTestLoopPacingIteration {
    readonly iteration: number;
    readonly scheduledAtEpochMs: number;
    readonly startedAtEpochMs: number;
    readonly endedAtEpochMs: number;
    readonly durationMs: number;
    readonly startDriftMs: number;
    readonly commandCount: number;
    readonly passed: number;
    readonly failed: number;
    readonly cancelled: boolean;
}

export interface RallarBlackBoxTestLoopPacingSummary {
    readonly requestedIntervalMs: number;
    readonly requestedRateHz?: number;
    readonly plannedIterations: number;
    readonly completedIterations: number;
    readonly skippedIterations: number;
    readonly cancelledIterations: number;
    readonly startedAtEpochMs: number;
    readonly endedAtEpochMs: number;
    readonly elapsedMs: number;
    readonly targetElapsedMs: number;
    readonly achievedRateHz?: number;
    readonly averageIterationDurationMs?: number;
    readonly minStartDriftMs?: number;
    readonly maxStartDriftMs?: number;
    readonly averageStartDriftMs?: number;
    readonly maxJitterMs?: number;
    readonly averageJitterMs?: number;
    readonly lateIterationCount: number;
    readonly lateThresholdMs: number;
    readonly iterations: readonly RallarBlackBoxTestLoopPacingIteration[];
}

export interface RallarBlackBoxTestSendObservation {
    readonly commandId: string;
    readonly kind: Extract<RallarBlackBoxTestCommandKind, 'rtc.send' | 'ws.send'>;
    readonly transport?: RallarBlackBoxTestTransport;
    readonly durationMs: number;
    readonly ok: boolean;
    readonly status?: string;
    readonly queued?: boolean;
    readonly droppedPayloadCount?: number;
    readonly replacedPayloadCount?: number;
    readonly errorCode?: string;
}

export interface RallarBlackBoxTestLoopSendSummary {
    readonly sendCount: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly successRatio?: number;
    readonly duration?: Readonly<{
        minMs?: number;
        maxMs?: number;
        averageMs?: number;
        totalMs: number;
    }>;
    readonly queuedCount: number;
    readonly droppedPayloadCount: number;
    readonly replacedPayloadCount: number;
    readonly perTransportFailureCounts: Readonly<Record<string, number>>;
    readonly observations: readonly RallarBlackBoxTestSendObservation[];
}

export interface RallarBlackBoxTestLoopThresholdFailure {
    readonly name: keyof RallarBlackBoxTestLoopThresholds;
    readonly category: 'pacing' | 'delivery';
    readonly threshold: number;
    readonly actual?: number;
    readonly message: string;
}

export interface RallarBlackBoxTestLoopResultValue {
    readonly commandId: string;
    readonly iterations: number;
    readonly childResultCount: number;
    readonly passed: number;
    readonly failed: number;
    readonly cancelled: boolean;
    readonly pacing?: RallarBlackBoxTestLoopPacingSummary;
    readonly sends?: RallarBlackBoxTestLoopSendSummary;
    readonly thresholdFailures?: readonly RallarBlackBoxTestLoopThresholdFailure[];
    readonly results: readonly RallarBlackBoxTestCompositeChildResult[];
}

export interface RallarBlackBoxTestRtcStreamFrameObservation {
    readonly index: number;
    readonly iteration: number;
    readonly commandId: string;
    readonly scheduledAtEpochMs: number;
    readonly startedAtEpochMs?: number;
    readonly completedAtEpochMs?: number;
    readonly startDriftMs?: number;
    readonly durationMs?: number;
    readonly ok: boolean;
    readonly dropped?: boolean;
    readonly status?: string;
    readonly errorCode?: string;
}

export interface RallarBlackBoxTestRtcStreamThresholdFailure {
    readonly name: keyof RallarBlackBoxTestRtcStreamThresholds;
    readonly category: 'pacing' | 'delivery';
    readonly threshold: number;
    readonly actual?: number;
    readonly message: string;
}

export interface RallarBlackBoxTestRtcStreamResultValue {
    readonly commandId: string;
    readonly transport?: Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>;
    readonly plannedFrames: number;
    readonly scheduledFrames: number;
    readonly attemptedFrames: number;
    readonly completedFrames: number;
    readonly failedFrames: number;
    readonly droppedFrames: number;
    readonly startedAtEpochMs: number;
    readonly endedAtEpochMs: number;
    readonly elapsedMs: number;
    readonly requestedRateHz?: number;
    readonly achievedScheduleHz?: number;
    readonly achievedCompletionHz?: number;
    readonly pacing: Readonly<{
        intervalMs: number;
        maxStartDriftMs?: number;
        averageStartDriftMs?: number;
        maxJitterMs?: number;
        lateFrameCount: number;
    }>;
    readonly duration: Readonly<{
        minMs?: number;
        p50Ms?: number;
        p95Ms?: number;
        p99Ms?: number;
        maxMs?: number;
        averageMs?: number;
    }>;
    readonly thresholdFailures: readonly RallarBlackBoxTestRtcStreamThresholdFailure[];
    readonly observations: readonly RallarBlackBoxTestRtcStreamFrameObservation[];
}

export interface RallarBlackBoxTestParallelGroupResult {
    readonly groupId: string;
    readonly commandCount: number;
    readonly passed: number;
    readonly failed: number;
    readonly cancelled: boolean;
    readonly durationMs: number;
    readonly results: readonly RallarBlackBoxTestCompositeChildResult[];
}

export interface RallarBlackBoxTestParallelResultValue {
    readonly commandId: string;
    readonly groupCount: number;
    readonly maxConcurrency: number;
    readonly passed: number;
    readonly failed: number;
    readonly cancelled: boolean;
    readonly groups: readonly RallarBlackBoxTestParallelGroupResult[];
}

export interface RallarBlackBoxTestWaitResultValue {
    readonly commandId: string;
    readonly matched: boolean;
    readonly absent?: true;
    readonly timedOut?: boolean;
    readonly cancelled?: boolean;
    readonly match: RallarBlackBoxTestWaitMatch;
    readonly event?: RallarBlackBoxTestEvent;
}

export interface RallarBlackBoxTestAssertResultValue {
    readonly commandId: string;
    readonly source: string;
    readonly operator: RallarBlackBoxTestAssertOperator;
    readonly expected?: unknown;
    readonly actual?: unknown;
    readonly exists: boolean;
    readonly passed: boolean;
}

export interface RallarBlackBoxTestMessagesSendResultValue {
    readonly handleId: string;
    readonly msgId?: string;
    readonly carrier: RallarBlackBoxTestMessagesCarrier;
    readonly status: ALDeliveryState;
    readonly reason?: string;
}

export interface RallarBlackBoxTestMessagesObserveResultValue {
    readonly handleId: string;
    readonly state: ALDeliveryState;
    readonly submitted: boolean;
    readonly confirmedHopPeerIds: readonly string[];
    readonly unconfirmedHopPeerIds: readonly string[];
    readonly attempts: number;
    readonly reason: string | undefined;
}

export interface RallarBlackBoxTestStorageCountersResultValue {
    readonly total: number;
    readonly byOwner: Readonly<Record<'al-admission' | 'al-work', number>>;
    readonly byKind: Readonly<Record<string, number>>;
}

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

export type RallarBlackBoxTestRuntimeEventInput = Omit<RallarBlackBoxTestEvent, 'eventId' | 'atEpochMs'>;

export interface RallarBlackBoxTestStatsSnapshot {
    readonly atEpochMs: number;
    readonly runId?: string;
    readonly agentId?: string;
    readonly status: RallarBlackBoxTestRuntimeStatus;
    readonly counters: Readonly<{
        commands: number;
        events: number;
        failures: number;
        messages: number;
        diagnostics: number;
        reconnects?: number;
    }>;
    readonly lastCommandId?: string;
    readonly lastEventAtEpochMs?: number;
    readonly commandLatency?: Readonly<{
        count: number;
        minMs?: number;
        maxMs?: number;
        averageMs?: number;
        lastMs?: number;
    }>;
    readonly rallar?: Readonly<{
        connected?: boolean;
        actor?: string;
        sessionId?: string;
        roomId?: string;
        transport?: RallarBlackBoxTestTransport;
        peerCount?: number;
        laneHealth?: unknown;
    }>;
    readonly load?: Readonly<{
        loopCount: number;
        latestLoopCommandId?: string;
        latestPacing?: Omit<RallarBlackBoxTestLoopPacingSummary, 'iterations'>;
        latestSends?: Omit<RallarBlackBoxTestLoopSendSummary, 'observations'>;
        thresholdFailures?: readonly RallarBlackBoxTestLoopThresholdFailure[];
        streamCount?: number;
        latestStreamCommandId?: string;
        latestStream?: Omit<RallarBlackBoxTestRtcStreamResultValue, 'observations'>;
    }>;
}

export interface RallarBlackBoxTestReportFragment {
    readonly reportId: string;
    readonly runId?: string;
    readonly agentId?: string;
    readonly atEpochMs: number;
    readonly summary?: unknown;
    readonly results?: readonly RallarBlackBoxTestResult[];
    readonly events?: readonly RallarBlackBoxTestEvent[];
    readonly stats?: RallarBlackBoxTestStatsSnapshot;
}

export interface RallarBlackBoxTestState {
    readonly status: RallarBlackBoxTestRuntimeStatus;
    readonly currentConfig?: RallarBlackBoxTestConfig;
    readonly loadedRecipe?: RallarBlackBoxTestRecipe;
    readonly activeCommand?: RallarBlackBoxTestCommand & Readonly<{ commandId: string; }>;
    readonly activeCommandStartedAtEpochMs?: number;
    readonly commandHistory: readonly RallarBlackBoxTestResult[];
    readonly events: readonly RallarBlackBoxTestEvent[];
    readonly latestStats?: RallarBlackBoxTestStatsSnapshot;
    readonly failures: readonly RallarBlackBoxTestResult[];
    readonly resultCache: Readonly<Record<string, RallarBlackBoxTestResult>>;
}

export type RallarBlackBoxTestStateListener = (
    state: RallarBlackBoxTestState
) => void | Promise<void>;

export interface RallarBlackBoxTestCommandOutcome {
    readonly status: RallarBlackBoxTestResultStatus;
    readonly value?: unknown;
    readonly error?: RallarBlackBoxTestError;
    readonly nextStatus?: RallarBlackBoxTestRuntimeStatus;
}

export interface RallarBlackBoxTestCommandContext {
    state(): RallarBlackBoxTestState;
    config(): RallarBlackBoxTestConfig | undefined;
    abortSignal?(): AbortSignal | undefined;
    recordEvent(event: RallarBlackBoxTestRuntimeEventInput): void;
    updateStats(commandId?: string): RallarBlackBoxTestStatsSnapshot;
}

export type RallarBlackBoxTestCommandExecutor = (
    command: RallarBlackBoxTestCommand & Readonly<{ commandId: string; }>,
    context: RallarBlackBoxTestCommandContext
) =>
    | RallarBlackBoxTestCommandOutcome
    | undefined
    | Promise<RallarBlackBoxTestCommandOutcome | undefined>;

export type RallarBlackBoxTestCleanupReason =
    | 'cancelled'
    | 'failed'
    | 'timed-out';

export interface RallarBlackBoxTestCleanupInput {
    readonly reason: RallarBlackBoxTestCleanupReason;
    readonly commandId?: string;
    readonly recipeId?: string;
    readonly status?: RallarBlackBoxTestResultStatus;
    readonly error?: RallarBlackBoxTestError;
}

export type RallarBlackBoxTestRuntimeCleanup = (
    input: RallarBlackBoxTestCleanupInput,
    context: RallarBlackBoxTestCommandContext
) => void | Promise<void>;

export interface RallarBlackBoxTestRuntime {
    execute(command: RallarBlackBoxTestCommand): Promise<RallarBlackBoxTestResult>;
    state(): RallarBlackBoxTestState;
    recordEvent(event: RallarBlackBoxTestRuntimeEventInput): void;
    subscribe(listener: RallarBlackBoxTestStateListener): () => void;
}
export type RallarBlackBoxCommandProviderMode =
    | 'simulated'
    | 'browser-rallar'
    | 'rallar-browser'
    | 'rallar-remote-browser'
    | 'rallar-memory'
    | 'rallar-server'
    | 'mixed';
export type RallarBlackBoxCommandRuntimeSurface =
    | 'spa-local'
    | 'control-agent'
    | 'control-server'
    | 'black-box-runner-adapter';
export interface RallarBlackBoxCommandCapability {
    readonly kind: typeof RALLAR_BLACK_BOX_TEST_COMMAND_KINDS[number];
    readonly title: string;
    readonly description: string;
    readonly requiredFields: readonly string[];
    readonly optionalFields: readonly string[];
    readonly supportedProviderModes: readonly RallarBlackBoxCommandProviderMode[];
    readonly runtimeSurfaces: readonly RallarBlackBoxCommandRuntimeSurface[];
    readonly liveServiceRequirements: readonly string[];
    readonly artifactExpectations: readonly string[];
    readonly example: RallarBlackBoxTestCommand;
}
