import type {
    RallarBlackBoxTestLoopPacingSummary,
    RallarBlackBoxTestLoopResultValue,
    RallarBlackBoxTestLoopSendSummary,
    RallarBlackBoxTestRtcStreamResultValue,
    RallarBlackBoxTestState,
    RallarBlackBoxTestStatsSnapshot
} from '../rallar-black-box-test-contracts.ts';
import { decodeRecord } from './decode-runtime-result-values.ts';

export interface RallarBlackBoxTestRuntimeHealth {
    readonly status: RallarBlackBoxTestState['status'];
    readonly configured: boolean;
    readonly loadedRecipeId: string | undefined;
    readonly activeCommandId: string | undefined;
    readonly commandCount: number;
    readonly eventCount: number;
    readonly failureCount: number;
}

export function toRuntimeHealth(state: RallarBlackBoxTestState): RallarBlackBoxTestRuntimeHealth {
    return {
        status: state.status,
        configured: state.currentConfig !== undefined,
        loadedRecipeId: state.loadedRecipe?.recipeId,
        activeCommandId: state.activeCommand?.commandId,
        commandCount: state.commandHistory.length,
        eventCount: state.events.length,
        failureCount: state.failures.length
    };
}

export function toRuntimeStats(state: RallarBlackBoxTestState, atEpochMs: number): RallarBlackBoxTestStatsSnapshot {
    const events = state.events;
    const config = state.currentConfig;
    const durations = state.commandHistory.map((result) => result.durationMs);
    return {
        atEpochMs,
        runId: config?.runId,
        agentId: config?.agentId,
        status: state.status,
        counters: {
            commands: state.commandHistory.length,
            events: events.length,
            failures: state.failures.length,
            messages: events.filter((event) => event.kind === 'message').length,
            diagnostics: events.filter((event) => event.kind === 'diagnostic').length,
            reconnects: events.filter((event) => event.topic.toLowerCase().includes('reconnect')).length
        },
        lastCommandId: state.commandHistory.at(-1)?.commandId,
        lastEventAtEpochMs: events.at(-1)?.atEpochMs,
        commandLatency: {
            count: durations.length,
            minMs: durations.length > 0 ? Math.min(...durations) : undefined,
            maxMs: durations.length > 0 ? Math.max(...durations) : undefined,
            averageMs: durations.length > 0
                ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
                : undefined,
            lastMs: durations.at(-1)
        },
        rallar: toRuntimeConnectionStats(state),
        load: toRuntimeLoadStats(state)
    };
}

function decodeLoopResultValue(value: unknown): RallarBlackBoxTestLoopResultValue | undefined {
    const record = decodeRecord(value);
    return typeof record.commandId === 'string' && record.pacing !== undefined
        ? value as RallarBlackBoxTestLoopResultValue
        : undefined;
}

function decodeStreamResultValue(value: unknown): RallarBlackBoxTestRtcStreamResultValue | undefined {
    const record = decodeRecord(value);
    return typeof record.commandId === 'string' &&
            typeof record.plannedFrames === 'number' &&
            record.pacing !== undefined &&
            record.duration !== undefined
        ? value as RallarBlackBoxTestRtcStreamResultValue
        : undefined;
}

function toStatsPacingSummary(
    pacing: RallarBlackBoxTestLoopPacingSummary | undefined
): Omit<RallarBlackBoxTestLoopPacingSummary, 'iterations'> | undefined {
    if (!pacing) {
        return undefined;
    }

    return {
        requestedIntervalMs: pacing.requestedIntervalMs,
        requestedRateHz: pacing.requestedRateHz,
        plannedIterations: pacing.plannedIterations,
        completedIterations: pacing.completedIterations,
        skippedIterations: pacing.skippedIterations,
        cancelledIterations: pacing.cancelledIterations,
        startedAtEpochMs: pacing.startedAtEpochMs,
        endedAtEpochMs: pacing.endedAtEpochMs,
        elapsedMs: pacing.elapsedMs,
        targetElapsedMs: pacing.targetElapsedMs,
        achievedRateHz: pacing.achievedRateHz,
        averageIterationDurationMs: pacing.averageIterationDurationMs,
        minStartDriftMs: pacing.minStartDriftMs,
        maxStartDriftMs: pacing.maxStartDriftMs,
        averageStartDriftMs: pacing.averageStartDriftMs,
        maxJitterMs: pacing.maxJitterMs,
        averageJitterMs: pacing.averageJitterMs,
        lateIterationCount: pacing.lateIterationCount,
        lateThresholdMs: pacing.lateThresholdMs
    };
}

function toStatsSendSummary(
    sends: RallarBlackBoxTestLoopSendSummary | undefined
): Omit<RallarBlackBoxTestLoopSendSummary, 'observations'> | undefined {
    if (!sends) {
        return undefined;
    }

    return {
        sendCount: sends.sendCount,
        succeeded: sends.succeeded,
        failed: sends.failed,
        successRatio: sends.successRatio,
        duration: sends.duration,
        queuedCount: sends.queuedCount,
        enqueuedCount: sends.enqueuedCount,
        backpressureCount: sends.backpressureCount,
        droppedPayloadCount: sends.droppedPayloadCount,
        replacedPayloadCount: sends.replacedPayloadCount,
        perTransportFailureCounts: sends.perTransportFailureCounts
    };
}

function toStatsStreamSummary(
    stream: RallarBlackBoxTestRtcStreamResultValue | undefined
): Omit<RallarBlackBoxTestRtcStreamResultValue, 'observations'> | undefined {
    if (!stream) {
        return undefined;
    }

    return {
        commandId: stream.commandId,
        transport: stream.transport,
        plannedFrames: stream.plannedFrames,
        scheduledFrames: stream.scheduledFrames,
        attemptedFrames: stream.attemptedFrames,
        completedFrames: stream.completedFrames,
        failedFrames: stream.failedFrames,
        droppedFrames: stream.droppedFrames,
        backpressureCount: stream.backpressureCount,
        startedAtEpochMs: stream.startedAtEpochMs,
        endedAtEpochMs: stream.endedAtEpochMs,
        elapsedMs: stream.elapsedMs,
        requestedRateHz: stream.requestedRateHz,
        achievedScheduleHz: stream.achievedScheduleHz,
        achievedCompletionHz: stream.achievedCompletionHz,
        pacing: stream.pacing,
        duration: stream.duration,
        thresholdFailures: stream.thresholdFailures
    };
}

function toRuntimeLoadStats(state: RallarBlackBoxTestState): RallarBlackBoxTestStatsSnapshot['load'] {
    const loopResults = state.commandHistory.filter((result) => result.kind === 'loop');
    const latestLoopResult = loopResults.at(-1);
    const latestLoopValue = decodeLoopResultValue(latestLoopResult?.value);
    const streamResults = state.commandHistory.filter((result) => result.kind === 'rtc.stream');
    const latestStreamResult = streamResults.at(-1);
    const latestStreamValue = decodeStreamResultValue(latestStreamResult?.value);
    return loopResults.length > 0 || streamResults.length > 0
        ? {
            loopCount: loopResults.length,
            latestLoopCommandId: latestLoopResult?.commandId,
            latestPacing: toStatsPacingSummary(latestLoopValue?.pacing),
            latestSends: toStatsSendSummary(latestLoopValue?.sends),
            thresholdFailures: latestLoopValue?.thresholdFailures,
            streamCount: streamResults.length,
            latestStreamCommandId: latestStreamResult?.commandId,
            latestStream: toStatsStreamSummary(latestStreamValue)
        }
        : undefined;
}

function toRuntimeConnectionStats(state: RallarBlackBoxTestState): RallarBlackBoxTestStatsSnapshot['rallar'] {
    const events = state.events;
    const config = state.currentConfig;
    const lastRallarDiagnostic = events
        .filter((event) =>
            event.topic.includes('rtc.connected') ||
            event.topic.includes('rallar.bb.fake.rtc.connected') ||
            event.topic.includes('rallar.browser.connect_completed')
        )
        .at(-1);
    const lastRallarPayload = decodeRecord(lastRallarDiagnostic?.payload);
    return {
        connected: lastRallarDiagnostic !== undefined,
        actor: config?.actor,
        sessionId: config?.sessionId,
        roomId: config?.roomId,
        transport: config?.transport,
        peerCount: typeof lastRallarPayload.peerCount === 'number'
            ? lastRallarPayload.peerCount
            : undefined,
        laneHealth: lastRallarPayload.laneHealth
    };
}
