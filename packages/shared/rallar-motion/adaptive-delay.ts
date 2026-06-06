import { clampRallarMotionNumber } from './math.ts';
import type {
    RallarMotionAdaptiveDelay,
    RallarMotionAdaptiveDelayOptions,
} from './types.ts';

const DEFAULT_ADAPTIVE_DELAY_OPTIONS = {
    defaultDelayMs: 100,
    minDelayMs: 50,
    maxDelayMs: 250,
    smoothingAlpha: 0.2,
    jitterMultiplier: 2,
    safetyMarginMs: 10,
};

export function createRallarMotionAdaptiveDelay(
    options: RallarMotionAdaptiveDelayOptions = {},
): RallarMotionAdaptiveDelay {
    const resolved = {
        ...DEFAULT_ADAPTIVE_DELAY_OPTIONS,
        ...options,
    };
    const alpha = clampRallarMotionNumber(resolved.smoothingAlpha, 0, 1);
    let previousObservedAtEpochMs: number | undefined;
    let averageIntervalMs: number | undefined;
    let averageJitterMs = 0;

    const pushInterval = (intervalMs: number): number => {
        if (intervalMs <= 0 || !Number.isFinite(intervalMs)) {
            return currentDelayMs();
        }

        if (averageIntervalMs === undefined) {
            averageIntervalMs = intervalMs;
            averageJitterMs = 0;
            return currentDelayMs();
        }

        const jitter = Math.abs(intervalMs - averageIntervalMs);
        averageIntervalMs = averageIntervalMs * (1 - alpha) + intervalMs * alpha;
        averageJitterMs = averageJitterMs * (1 - alpha) + jitter * alpha;
        return currentDelayMs();
    };

    const currentDelayMs = (): number => {
        if (averageIntervalMs === undefined) {
            return clampRallarMotionNumber(
                resolved.defaultDelayMs,
                resolved.minDelayMs,
                resolved.maxDelayMs,
            );
        }

        return clampRallarMotionNumber(
            averageIntervalMs +
                averageJitterMs * resolved.jitterMultiplier +
                resolved.safetyMarginMs,
            resolved.minDelayMs,
            resolved.maxDelayMs,
        );
    };

    return {
        pushObservedAt(observedAtEpochMs): number {
            if (previousObservedAtEpochMs === undefined) {
                previousObservedAtEpochMs = observedAtEpochMs;
                return currentDelayMs();
            }

            const intervalMs = observedAtEpochMs - previousObservedAtEpochMs;
            previousObservedAtEpochMs = observedAtEpochMs;
            return pushInterval(intervalMs);
        },
        pushInterval,
        currentDelayMs,
        reset(): void {
            previousObservedAtEpochMs = undefined;
            averageIntervalMs = undefined;
            averageJitterMs = 0;
        },
    };
}
