import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import { isFiniteNumber } from './artifact-json-value-guards.ts';
import { decodeNumber, decodeRecordItems, decodeText } from './decode-artifact-json-values.ts';

/** A recorded timing record; each statistic is absent when the record does not carry it as a finite number. */
export interface DistributedRunTimingRecord {
    readonly count?: number;
    readonly minMs?: number;
    readonly p50Ms?: number;
    readonly p95Ms?: number;
    readonly p99Ms?: number;
    readonly maxMs?: number;
    readonly averageMs?: number;
    readonly outlierCount?: number;
}

export interface DistributedRunStreamObservation {
    readonly dropped: boolean;
    /** Absent when the observation records no finite duration. */
    readonly durationMs?: number;
    /** Absent when the observation records neither errorCode nor code. */
    readonly errorCode?: string;
}

/** A recorded rtc.stream summary; each counter and rate is absent when the summary does not record it. */
export interface DistributedRunStreamSummary {
    readonly commandId?: string;
    readonly plannedFrames?: number;
    readonly scheduledFrames?: number;
    readonly attemptedFrames?: number;
    readonly completedFrames?: number;
    readonly failedFrames?: number;
    readonly droppedFrames?: number;
    readonly inFlightLimitDropCount?: number;
    readonly backpressureCount?: number;
    readonly requestedRateHz?: number;
    readonly achievedScheduleHz?: number;
    readonly achievedCompletionHz?: number;
    readonly maxStartDriftMs?: number;
    readonly lateFrameCount?: number;
    readonly duration: DistributedRunTimingRecord;
    readonly thresholdFailureCount: number;
    readonly observations: readonly DistributedRunStreamObservation[];
    /** The recorded duration, threshold failures and observations as JSON text; they tell stream executions apart. */
    readonly fingerprintText: DistributedRunStreamFingerprintText;
}

export interface DistributedRunStreamFingerprintText {
    readonly duration: string;
    readonly thresholdFailures: string;
    readonly observations: string;
}

export function decodeDistributedRunTimingRecord(value: unknown): DistributedRunTimingRecord {
    if (!isJsonRecordValue(value)) {
        return {};
    }
    return {
        count: decodeNumber(value.count),
        minMs: decodeNumber(value.minMs),
        p50Ms: decodeNumber(value.p50Ms),
        p95Ms: decodeNumber(value.p95Ms),
        p99Ms: decodeNumber(value.p99Ms),
        maxMs: decodeNumber(value.maxMs),
        averageMs: decodeNumber(value.averageMs),
        outlierCount: decodeNumber(value.outlierCount)
    };
}

/** A JSON object is a stream summary when it records a frame count or a non-empty duration record. */
export function decodeDistributedRunStreamSummary(value: unknown): DistributedRunStreamSummary | undefined {
    if (!isJsonRecordValue(value)) {
        return undefined;
    }
    const duration = isJsonRecordValue(value.duration) ? value.duration : {};
    const isSummary = isFiniteNumber(value.plannedFrames) ||
        isFiniteNumber(value.completedFrames) ||
        isFiniteNumber(value.scheduledFrames) ||
        Object.keys(duration).length > 0;
    if (!isSummary) {
        return undefined;
    }
    const pacing = isJsonRecordValue(value.pacing) ? value.pacing : undefined;
    const thresholdFailures = Array.isArray(value.thresholdFailures)
        ? value.thresholdFailures.map((item) => isJsonRecordValue(item) ? item : {})
        : [];
    const observations = Array.isArray(value.observations)
        ? value.observations.map((item) => isJsonRecordValue(item) ? item : {})
        : [];
    return {
        commandId: decodeText(value.commandId),
        plannedFrames: decodeNumber(value.plannedFrames),
        scheduledFrames: decodeNumber(value.scheduledFrames),
        attemptedFrames: decodeNumber(value.attemptedFrames),
        completedFrames: decodeNumber(value.completedFrames),
        failedFrames: decodeNumber(value.failedFrames),
        droppedFrames: decodeNumber(value.droppedFrames),
        inFlightLimitDropCount: decodeNumber(value.inFlightLimitDropCount),
        backpressureCount: decodeNumber(value.backpressureCount),
        requestedRateHz: decodeNumber(value.requestedRateHz),
        achievedScheduleHz: decodeNumber(value.achievedScheduleHz),
        achievedCompletionHz: decodeNumber(value.achievedCompletionHz),
        maxStartDriftMs: decodeNumber(pacing?.maxStartDriftMs),
        lateFrameCount: decodeNumber(pacing?.lateFrameCount),
        duration: decodeDistributedRunTimingRecord(duration),
        thresholdFailureCount: thresholdFailures.length,
        observations: decodeRecordItems(value.observations, decodeStreamObservation),
        fingerprintText: {
            duration: JSON.stringify(duration),
            thresholdFailures: JSON.stringify(thresholdFailures),
            observations: JSON.stringify(observations)
        }
    };
}

/** Result payloads nest the summary under value, details or payload wrappers; the first summary found wins. */
export function decodeNestedStreamSummary(value: unknown): DistributedRunStreamSummary | undefined {
    if (!isJsonRecordValue(value)) {
        return undefined;
    }
    const details = isJsonRecordValue(value.details) ? value.details : undefined;
    const nestedDetails = details !== undefined && isJsonRecordValue(details.details) ? details.details : undefined;
    for (
        const candidate of [
            value.value,
            details?.value,
            details?.details,
            nestedDetails?.value,
            value.payload,
            value.data,
            value
        ]
    ) {
        const summary = decodeDistributedRunStreamSummary(candidate);
        if (summary !== undefined) {
            return summary;
        }
    }
    return undefined;
}

function decodeStreamObservation(value: unknown): DistributedRunStreamObservation {
    if (!isJsonRecordValue(value)) {
        return { dropped: false };
    }
    return {
        dropped: Boolean(value.dropped),
        durationMs: decodeNumber(value.durationMs),
        errorCode: decodeText(value.errorCode) ?? decodeText(value.code)
    };
}
