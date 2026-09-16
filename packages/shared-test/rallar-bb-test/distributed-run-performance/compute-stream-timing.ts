import type {
    DistributedRunSlowestStreamAgent,
    DistributedRunStreamTiming,
    DistributedRunTimingSummary
} from '../distributed-artifact-analysis.ts';
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
    | 'backpressureCount';

const SLOWEST_STREAM_AGENT_LIMIT = 5;

/** Absent unless every sample is a terminal summary with planned, completed, failed and dropped frame counts. */
export function computeStreamTiming(samples: readonly StreamTimingSample[]): DistributedRunStreamTiming | undefined {
    if (samples.length === 0 || !samples.every(hasCompleteStreamTimingEvidence)) {
        return undefined;
    }
    const attemptedFrames = computeStreamCounterSum(samples, 'attemptedFrames');
    const completedFrames = computeStreamCounterSum(samples, 'completedFrames');
    return {
        streamCount: samples.length,
        plannedFrames: computeStreamCounterSum(samples, 'plannedFrames'),
        scheduledFrames: computeStreamCounterSum(samples, 'scheduledFrames'),
        attemptedFrames,
        completedFrames,
        failedFrames: computeStreamCounterSum(samples, 'failedFrames'),
        droppedFrames: computeStreamCounterSum(samples, 'droppedFrames'),
        inFlightLimitDropCount: samples.reduce((sum, sample) => sum + computeStreamInFlightLimitDropCount(sample), 0),
        backpressureCount: computeStreamCounterSum(samples, 'backpressureCount'),
        sendSuccessRatio: attemptedFrames > 0 ? toRoundedMetric(completedFrames / attemptedFrames) : undefined,
        requestedRateHz: computeDefinedAverage(samples.map((sample) => sample.summary.requestedRateHz)),
        achievedScheduleHz: computeDefinedAverage(samples.map((sample) => sample.summary.achievedScheduleHz)),
        achievedCompletionHz: computeDefinedAverage(samples.map((sample) => sample.summary.achievedCompletionHz)),
        maxStartDriftMs: computeMaxNumber(samples.map((sample) => sample.summary.maxStartDriftMs)),
        lateFrameCount: samples.reduce((sum, sample) => sum + (sample.summary.lateFrameCount ?? 0), 0),
        duration: computeStreamDurationTiming(samples),
        slowestAgents: computeSlowestStreamAgents(samples)
    };
}

function hasCompleteStreamTimingEvidence(sample: StreamTimingSample): boolean {
    const { summary } = sample;
    return sample.completeness === 'terminal' &&
        summary.plannedFrames !== undefined &&
        summary.completedFrames !== undefined &&
        summary.failedFrames !== undefined &&
        summary.droppedFrames !== undefined;
}

function computeStreamCounterSum(samples: readonly StreamTimingSample[], counter: StreamFrameCounter): number {
    return samples.reduce((sum, sample) => sum + (sample.summary[counter] ?? 0), 0);
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
    return sample.summary.observations.flatMap((observation) =>
        !observation.dropped && observation.durationMs !== undefined ? [observation.durationMs] : []
    );
}

function toSummaryDurations(sample: StreamTimingSample): readonly number[] {
    const { duration } = sample.summary;
    return [duration?.minMs, duration?.p50Ms, duration?.p95Ms, duration?.p99Ms, duration?.maxMs]
        .filter((value): value is number => value !== undefined);
}

function computeSlowestStreamAgents(
    samples: readonly StreamTimingSample[]
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
function toSamplesByAgent(samples: readonly StreamTimingSample[]): ReadonlyMap<string, readonly StreamTimingSample[]> {
    const samplesByAgent = new Map<string, StreamTimingSample[]>();
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
