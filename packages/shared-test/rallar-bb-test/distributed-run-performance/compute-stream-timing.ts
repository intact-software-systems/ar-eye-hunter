import type {
    DistributedRunSlowestStreamAgent,
    DistributedRunStreamTiming,
    DistributedRunTimingSummary
} from '../distributed-artifact-analysis.ts';
import type { DistributedRunStreamSummary } from '../distributed-artifact-analysis/decode-distributed-run-stream-summary.ts';
import {
    computeAverage,
    computeMaxNumber,
    computePercentile,
    computeTimingSummary,
    toRoundedMetric
} from './compute-timing-summary.ts';
import { computeStreamInFlightLimitDropCount, type StreamTimingSample } from './to-stream-timing-samples.ts';

type StreamFrameCounter =
    | 'plannedFrames'
    | 'scheduledFrames'
    | 'attemptedFrames'
    | 'completedFrames'
    | 'failedFrames'
    | 'droppedFrames'
    | 'backpressureCount'
    | 'lateFrameCount';

interface TerminalStreamTimingSample extends StreamTimingSample {
    readonly summary: DistributedRunStreamSummary & Readonly<Record<StreamFrameCounter, number>>;
}

const SLOWEST_STREAM_AGENT_LIMIT = 5;
const STREAM_FRAME_COUNTERS: readonly StreamFrameCounter[] = [
    'plannedFrames',
    'scheduledFrames',
    'attemptedFrames',
    'completedFrames',
    'failedFrames',
    'droppedFrames',
    'backpressureCount',
    'lateFrameCount'
];

/**
 * Absent unless every sample is a terminal summary recording every frame counter and the evidence of its in-flight
 * drops, as rtc.stream results do.
 */
export function computeStreamTiming(samples: readonly StreamTimingSample[]): DistributedRunStreamTiming | undefined {
    const terminalSamples = samples.filter(isTerminalStreamTimingSample);
    const inFlightLimitDropCount = computeStreamInFlightLimitDropSum(terminalSamples);
    if (samples.length === 0 || terminalSamples.length !== samples.length || inFlightLimitDropCount === undefined) {
        return undefined;
    }
    const attemptedFrames = computeStreamCounterSum(terminalSamples, 'attemptedFrames');
    const completedFrames = computeStreamCounterSum(terminalSamples, 'completedFrames');
    return {
        streamCount: terminalSamples.length,
        plannedFrames: computeStreamCounterSum(terminalSamples, 'plannedFrames'),
        scheduledFrames: computeStreamCounterSum(terminalSamples, 'scheduledFrames'),
        attemptedFrames,
        completedFrames,
        failedFrames: computeStreamCounterSum(terminalSamples, 'failedFrames'),
        droppedFrames: computeStreamCounterSum(terminalSamples, 'droppedFrames'),
        inFlightLimitDropCount,
        backpressureCount: computeStreamCounterSum(terminalSamples, 'backpressureCount'),
        sendSuccessRatio: attemptedFrames > 0 ? toRoundedMetric(completedFrames / attemptedFrames) : undefined,
        requestedRateHz: computeDefinedAverage(terminalSamples.map((sample) => sample.summary.requestedRateHz)),
        achievedScheduleHz: computeDefinedAverage(terminalSamples.map((sample) => sample.summary.achievedScheduleHz)),
        achievedCompletionHz: computeDefinedAverage(
            terminalSamples.map((sample) => sample.summary.achievedCompletionHz)
        ),
        maxStartDriftMs: computeMaxNumber(terminalSamples.map((sample) => sample.summary.maxStartDriftMs)),
        lateFrameCount: computeStreamCounterSum(terminalSamples, 'lateFrameCount'),
        duration: computeStreamDurationTiming(terminalSamples),
        slowestAgents: computeSlowestStreamAgents(terminalSamples)
    };
}

function isTerminalStreamTimingSample(sample: StreamTimingSample): sample is TerminalStreamTimingSample {
    return sample.completeness === 'terminal' &&
        STREAM_FRAME_COUNTERS.every((counter) => sample.summary[counter] !== undefined);
}

function computeStreamCounterSum(
    samples: readonly TerminalStreamTimingSample[],
    counter: StreamFrameCounter
): number {
    return samples.reduce((sum, sample) => sum + sample.summary[counter], 0);
}

/** Absent when any sample records neither an in-flight drop count nor a frame observation. */
function computeStreamInFlightLimitDropSum(samples: readonly TerminalStreamTimingSample[]): number | undefined {
    const counts = samples.map(computeStreamInFlightLimitDropCount);
    return counts.every((count): count is number => count !== undefined)
        ? counts.reduce((sum, count) => sum + count, 0)
        : undefined;
}

function computeDefinedAverage(values: readonly (number | undefined)[]): number | undefined {
    return computeAverage(values.filter((value): value is number => value !== undefined));
}

/** Observation durations win; a single stream repeats its recorded duration; several combine their statistics. */
function computeStreamDurationTiming(samples: readonly StreamTimingSample[]): DistributedRunTimingSummary {
    const observationDurations = samples.flatMap(toObservationDurations);
    if (observationDurations.length > 0) {
        return computeTimingSummary(undefined, observationDurations);
    }
    if (samples.length === 1) {
        return computeTimingSummary(samples[0].summary.duration, []);
    }
    return computeTimingSummary(undefined, samples.flatMap(toSummaryDurations));
}

function toObservationDurations(sample: StreamTimingSample): readonly number[] {
    return (sample.summary.observations ?? []).flatMap((observation) =>
        !observation.dropped && observation.durationMs !== undefined ? [observation.durationMs] : []
    );
}

function toSummaryDurations(sample: StreamTimingSample): readonly number[] {
    const { duration } = sample.summary;
    return [duration?.minMs, duration?.p50Ms, duration?.p95Ms, duration?.p99Ms, duration?.maxMs]
        .filter((value): value is number => value !== undefined);
}

function computeSlowestStreamAgents(
    samples: readonly TerminalStreamTimingSample[]
): readonly DistributedRunSlowestStreamAgent[] {
    return [...toSamplesByAgent(samples).entries()]
        .map(([agentId, agentSamples]) => {
            const observationDurations = agentSamples.flatMap(toObservationDurations);
            const durations = observationDurations.length > 0
                ? observationDurations
                : agentSamples.flatMap(toSummaryDurations);
            return {
                agentId,
                streamCount: agentSamples.length,
                plannedFrames: computeStreamCounterSum(agentSamples, 'plannedFrames'),
                completedFrames: computeStreamCounterSum(agentSamples, 'completedFrames'),
                averageMs: computeAverage(durations),
                p95Ms: computePercentile(durations, 0.95),
                p99Ms: computePercentile(durations, 0.99),
                maxMs: computeMaxNumber(durations)
            };
        })
        .sort((left, right) =>
            (right.maxMs ?? 0) - (left.maxMs ?? 0) ||
            (right.averageMs ?? 0) - (left.averageMs ?? 0) ||
            right.completedFrames - left.completedFrames ||
            left.agentId.localeCompare(right.agentId)
        )
        .slice(0, SLOWEST_STREAM_AGENT_LIMIT);
}

/** Samples that name no agent belong to no agent's row. */
function toSamplesByAgent(
    samples: readonly TerminalStreamTimingSample[]
): ReadonlyMap<string, readonly TerminalStreamTimingSample[]> {
    const samplesByAgent = new Map<string, TerminalStreamTimingSample[]>();
    for (const sample of samples) {
        if (!sample.agentId) {
            continue;
        }
        const agentSamples = samplesByAgent.get(sample.agentId);
        if (agentSamples) {
            agentSamples.push(sample);
        }
        else {
            samplesByAgent.set(sample.agentId, [sample]);
        }
    }
    return samplesByAgent;
}
