import { Either } from '@shared/resilience/Either.ts';
import type {
    RallarBlackBoxTestLoopResultValue,
    RallarBlackBoxTestLoopThresholdFailure,
    RallarBlackBoxTestLoopThresholds,
    RallarBlackBoxTestRecord
} from '../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import { RALLAR_BLACK_BOX_COMMAND_NON_NEGATIVE_FIELDS } from '../schema/rallar-black-box-command-fields.ts';

export interface LoopThresholdIssue {
    readonly message: string;
    readonly details: RallarBlackBoxTestRecord;
}

interface LoopPacingMaximum {
    readonly name: 'maxAverageStartDriftMs' | 'maxStartDriftMs' | 'maxJitterMs';
    readonly label: string;
    readonly threshold: number | undefined;
    readonly actual: number | undefined;
}

export function computeLoopThresholdFailures(
    thresholds: RallarBlackBoxTestLoopThresholds,
    value: RallarBlackBoxTestLoopResultValue
): readonly RallarBlackBoxTestLoopThresholdFailure[] {
    return [
        ...computeLoopRateFailures(thresholds, value),
        ...computeLoopDriftFailures(thresholds, value),
        ...computeLoopDeliveryFailures(thresholds, value)
    ];
}

function computeLoopRateFailures(
    thresholds: RallarBlackBoxTestLoopThresholds,
    value: RallarBlackBoxTestLoopResultValue
): readonly RallarBlackBoxTestLoopThresholdFailure[] {
    const failures: RallarBlackBoxTestLoopThresholdFailure[] = [];
    const pacing = value.pacing;
    if (
        thresholds.minAchievedRateHz !== undefined &&
        pacing?.achievedRateHz !== undefined &&
        pacing.achievedRateHz < thresholds.minAchievedRateHz
    ) {
        failures.push({
            name: 'minAchievedRateHz',
            category: 'pacing',
            threshold: thresholds.minAchievedRateHz,
            actual: pacing.achievedRateHz,
            message:
                `Loop achieved ${pacing.achievedRateHz} Hz, below the configured ${thresholds.minAchievedRateHz} Hz minimum.`
        });
    }
    return failures;
}

function computeLoopDriftFailures(
    thresholds: RallarBlackBoxTestLoopThresholds,
    value: RallarBlackBoxTestLoopResultValue
): readonly RallarBlackBoxTestLoopThresholdFailure[] {
    const pacing = value.pacing;
    const maximums: readonly LoopPacingMaximum[] = [
        {
            name: 'maxAverageStartDriftMs',
            label: 'Average loop start drift',
            threshold: thresholds.maxAverageStartDriftMs,
            actual: pacing?.averageStartDriftMs
        },
        {
            name: 'maxStartDriftMs',
            label: 'Maximum loop start drift',
            threshold: thresholds.maxStartDriftMs,
            actual: pacing?.maxStartDriftMs
        },
        {
            name: 'maxJitterMs',
            label: 'Maximum loop jitter',
            threshold: thresholds.maxJitterMs,
            actual: pacing?.maxJitterMs
        }
    ];
    return maximums.flatMap(({ name, label, threshold, actual }) =>
        threshold !== undefined && actual !== undefined && actual > threshold
            ? [{
                name,
                category: 'pacing' as const,
                threshold,
                actual,
                message: `${label} was ${actual} ms, above the configured ${threshold} ms maximum.`
            }]
            : []
    );
}

function computeLoopDeliveryFailures(
    thresholds: RallarBlackBoxTestLoopThresholds,
    value: RallarBlackBoxTestLoopResultValue
): readonly RallarBlackBoxTestLoopThresholdFailure[] {
    const failures: RallarBlackBoxTestLoopThresholdFailure[] = [];
    const sends = value.sends;
    if (
        thresholds.minSendSuccessRatio !== undefined &&
        sends?.successRatio !== undefined &&
        sends.successRatio < thresholds.minSendSuccessRatio
    ) {
        failures.push({
            name: 'minSendSuccessRatio',
            category: 'delivery',
            threshold: thresholds.minSendSuccessRatio,
            actual: sends.successRatio,
            message:
                `Loop send success ratio was ${sends.successRatio}, below the configured ${thresholds.minSendSuccessRatio} minimum.`
        });
    }
    if (
        thresholds.failOnBackpressure === true &&
        sends !== undefined &&
        (sends.backpressureCount > 0 || sends.droppedPayloadCount > 0 || sends.replacedPayloadCount > 0)
    ) {
        failures.push({
            name: 'failOnBackpressure',
            category: 'backpressure',
            threshold: true,
            actual: true,
            message: 'Loop observed send backpressure, dropped payloads, or replaced payloads.'
        });
    }
    return failures;
}

/** Absent thresholds decode to an empty set, which no loop result can fail. */
export function decodeLoopThresholds(value: unknown): Either<LoopThresholdIssue, RallarBlackBoxTestLoopThresholds> {
    if (value === undefined) {
        return Either.ofRight({});
    }
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft({ message: 'Loop thresholds must be an object.', details: { thresholds: value } });
    }
    const issue = toNonNegativeThresholdIssue(value) ?? toDeliveryThresholdIssue(value);
    return issue === undefined
        ? Either.ofRight(value as RallarBlackBoxTestLoopThresholds)
        : Either.ofLeft(issue);
}

function toNonNegativeThresholdIssue(thresholds: RallarBlackBoxTestRecord): LoopThresholdIssue | undefined {
    const key = RALLAR_BLACK_BOX_COMMAND_NON_NEGATIVE_FIELDS.loopThresholds.find((candidate) => {
        const threshold = thresholds[candidate];
        return threshold !== undefined &&
            (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0);
    });
    return key === undefined
        ? undefined
        : {
            message: 'Loop threshold values must be non-negative finite numbers.',
            details: { threshold: key, value: thresholds[key] }
        };
}

function toDeliveryThresholdIssue(thresholds: RallarBlackBoxTestRecord): LoopThresholdIssue | undefined {
    const minSendSuccessRatio = thresholds.minSendSuccessRatio;
    if (
        minSendSuccessRatio !== undefined &&
        (typeof minSendSuccessRatio !== 'number' || !Number.isFinite(minSendSuccessRatio) ||
            minSendSuccessRatio < 0 || minSendSuccessRatio > 1)
    ) {
        return {
            message: 'Loop minSendSuccessRatio threshold must be between 0 and 1.',
            details: { threshold: 'minSendSuccessRatio', value: minSendSuccessRatio }
        };
    }
    return thresholds.failOnBackpressure !== undefined && typeof thresholds.failOnBackpressure !== 'boolean'
        ? {
            message: 'Loop failOnBackpressure threshold must be a boolean.',
            details: { threshold: 'failOnBackpressure', value: thresholds.failOnBackpressure }
        }
        : undefined;
}
