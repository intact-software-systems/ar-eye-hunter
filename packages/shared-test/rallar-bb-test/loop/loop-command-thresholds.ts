import { toRecord } from '../to-runtime-command-values.ts';
import type {
    RallarBlackBoxTestLoopResultValue,
    RallarBlackBoxTestLoopThresholdFailure,
    RallarBlackBoxTestLoopThresholds
} from '../rallar-black-box-test-contracts.ts';
interface LoopThresholdIssue {
    readonly message: string;
    readonly details: unknown;
}

export function evaluateLoopThresholds(
    thresholds: RallarBlackBoxTestLoopThresholds | undefined,
    value: RallarBlackBoxTestLoopResultValue
): readonly RallarBlackBoxTestLoopThresholdFailure[] {
    return thresholds
        ? [
            ...evaluateLoopRateThreshold(thresholds, value),
            ...evaluateLoopDriftThresholds(thresholds, value),
            ...evaluateLoopDeliveryThresholds(thresholds, value)
        ]
        : [];
}

function evaluateLoopRateThreshold(
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

function evaluateLoopDriftThresholds(
    thresholds: RallarBlackBoxTestLoopThresholds,
    value: RallarBlackBoxTestLoopResultValue
): readonly RallarBlackBoxTestLoopThresholdFailure[] {
    const failures: RallarBlackBoxTestLoopThresholdFailure[] = [];
    const pacing = value.pacing;
    if (
        thresholds.maxAverageStartDriftMs !== undefined &&
        pacing?.averageStartDriftMs !== undefined &&
        pacing.averageStartDriftMs > thresholds.maxAverageStartDriftMs
    ) {
        failures.push({
            name: 'maxAverageStartDriftMs',
            category: 'pacing',
            threshold: thresholds.maxAverageStartDriftMs,
            actual: pacing.averageStartDriftMs,
            message:
                `Average loop start drift was ${pacing.averageStartDriftMs} ms, above the configured ${thresholds.maxAverageStartDriftMs} ms maximum.`
        });
    }
    if (
        thresholds.maxStartDriftMs !== undefined &&
        pacing?.maxStartDriftMs !== undefined &&
        pacing.maxStartDriftMs > thresholds.maxStartDriftMs
    ) {
        failures.push({
            name: 'maxStartDriftMs',
            category: 'pacing',
            threshold: thresholds.maxStartDriftMs,
            actual: pacing.maxStartDriftMs,
            message:
                `Maximum loop start drift was ${pacing.maxStartDriftMs} ms, above the configured ${thresholds.maxStartDriftMs} ms maximum.`
        });
    }
    if (
        thresholds.maxJitterMs !== undefined &&
        pacing?.maxJitterMs !== undefined &&
        pacing.maxJitterMs > thresholds.maxJitterMs
    ) {
        failures.push({
            name: 'maxJitterMs',
            category: 'pacing',
            threshold: thresholds.maxJitterMs,
            actual: pacing.maxJitterMs,
            message:
                `Maximum loop jitter was ${pacing.maxJitterMs} ms, above the configured ${thresholds.maxJitterMs} ms maximum.`
        });
    }
    return failures;
}

function evaluateLoopDeliveryThresholds(
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

export function validateLoopThresholds(value: unknown): LoopThresholdIssue | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {
            message: 'Loop thresholds must be an object.',
            details: {
                thresholds: value
            }
        };
    }

    const thresholds = toRecord(value);

    const nonNegativeNumbers = [
        'minAchievedRateHz',
        'maxAverageStartDriftMs',
        'maxStartDriftMs',
        'maxJitterMs'
    ];
    for (const key of nonNegativeNumbers) {
        const value = thresholds[key];
        if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
            return {
                message: 'Loop threshold values must be non-negative finite numbers.',
                details: {
                    threshold: key,
                    value
                }
            };
        }
    }

    return validateLoopDeliveryThresholds(thresholds);
}

function validateLoopDeliveryThresholds(thresholds: Record<string, unknown>): LoopThresholdIssue | undefined {
    const minSendSuccessRatio = thresholds.minSendSuccessRatio;
    if (
        minSendSuccessRatio !== undefined &&
        (
            typeof minSendSuccessRatio !== 'number' ||
            !Number.isFinite(minSendSuccessRatio) ||
            minSendSuccessRatio < 0 ||
            minSendSuccessRatio > 1
        )
    ) {
        return {
            message: 'Loop minSendSuccessRatio threshold must be between 0 and 1.',
            details: {
                threshold: 'minSendSuccessRatio',
                value: minSendSuccessRatio
            }
        };
    }

    if (
        thresholds.failOnBackpressure !== undefined &&
        typeof thresholds.failOnBackpressure !== 'boolean'
    ) {
        return {
            message: 'Loop failOnBackpressure threshold must be a boolean.',
            details: {
                threshold: 'failOnBackpressure',
                value: thresholds.failOnBackpressure
            }
        };
    }

    return undefined;
}
