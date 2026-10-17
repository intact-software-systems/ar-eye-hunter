import type { ALCongestionCounters } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type {
    RallarBlackBoxTestAlmUsage,
    RallarBlackBoxTestLoopPacingSummary,
    RallarBlackBoxTestLoopResultValue,
    RallarBlackBoxTestLoopSendSummary,
    RallarBlackBoxTestResult,
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
    readonly eventHistory: RallarBlackBoxTestState['eventHistory'];
    readonly failureCount: number;
}

export function toRuntimeHealth(state: RallarBlackBoxTestState): RallarBlackBoxTestRuntimeHealth {
    return {
        status: state.status,
        configured: state.currentConfig !== undefined,
        loadedRecipeId: state.loadedRecipe?.recipeId,
        activeCommandId: state.activeCommand?.commandId,
        commandCount: state.resultHistory.totalCommands,
        eventCount: state.eventHistory.totalEvents,
        eventHistory: state.eventHistory,
        failureCount: state.resultHistory.totalFailures
    };
}

export function toRuntimeStats(state: RallarBlackBoxTestState, atEpochMs: number): RallarBlackBoxTestStatsSnapshot {
    const events = state.events;
    const config = state.currentConfig;
    const history = state.resultHistory;
    return {
        atEpochMs,
        eventHistory: state.eventHistory,
        runId: config?.runId,
        agentId: config?.agentId,
        status: state.status,
        counters: {
            commands: state.resultHistory.totalCommands,
            events: state.eventHistory.totalEvents,
            failures: state.resultHistory.totalFailures,
            messages: state.eventHistory.countsByKind.message,
            diagnostics: state.eventHistory.countsByKind.diagnostic,
            reconnects: state.eventHistory.reconnects
        },
        resultRetention: { retainedResults: state.commandHistory.length, releasedResults: history.releasedResults },
        lastCommandId: history.lastCommandId,
        lastEventAtEpochMs: events.at(-1)?.atEpochMs,
        commandLatency: {
            count: history.totalCommands,
            minMs: history.minDurationMs,
            maxMs: history.maxDurationMs,
            averageMs: history.totalCommands > 0
                ? Math.round(history.durationSumMs / history.totalCommands)
                : undefined,
            lastMs: history.lastDurationMs
        },
        rallar: toRuntimeConnectionStats(state),
        load: history.load
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

export function toRuntimeLoadResultSummary(
    previous: RallarBlackBoxTestStatsSnapshot['load'],
    result: RallarBlackBoxTestResult
): RallarBlackBoxTestStatsSnapshot['load'] {
    if (result.kind !== 'loop' && result.kind !== 'rtc.stream') {
        return previous;
    }
    const summary = previous ?? { loopCount: 0, streamCount: 0 };
    if (result.kind === 'loop') {
        const value = decodeLoopResultValue(result.value);
        return {
            ...summary,
            loopCount: summary.loopCount + 1,
            latestLoopCommandId: result.commandId,
            latestPacing: toStatsPacingSummary(value?.pacing),
            latestSends: toStatsSendSummary(value?.sends),
            thresholdFailures: value?.thresholdFailures
        };
    }
    return {
        ...summary,
        streamCount: (summary.streamCount ?? 0) + 1,
        latestStreamCommandId: result.commandId,
        latestStream: toStatsStreamSummary(decodeStreamResultValue(result.value))
    };
}

function toRuntimeConnectionStats(state: RallarBlackBoxTestState): RallarBlackBoxTestStatsSnapshot['rallar'] {
    const config = state.currentConfig;
    return {
        connected: state.connection.connected,
        actor: config?.actor,
        sessionId: config?.sessionId,
        roomId: config?.roomId,
        transport: config?.transport,
        peerCount: state.connection.peerCount,
        laneHealth: state.connection.laneHealth
    };
}

/** The page's readings join the runtime's own stats only where the page answered them, so absence stays absence. */
export function toStatsWithPageReadings(
    stats: RallarBlackBoxTestStatsSnapshot,
    alm: RallarBlackBoxTestAlmUsage | undefined,
    congestion: ALCongestionCounters | undefined
): RallarBlackBoxTestStatsSnapshot {
    if (alm === undefined && congestion === undefined) {
        return stats;
    }
    return {
        ...stats,
        rallar: {
            ...stats.rallar,
            ...(alm === undefined ? {} : { alm }),
            ...(congestion === undefined ? {} : { congestion })
        }
    };
}
