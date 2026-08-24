export const DEFAULT_APP_INBOX_WAIT_MAX_ELAPSED_MSECS = 10_000;
export const DEFAULT_APP_INBOX_WAIT_RETRY_INTERVAL_MSECS = 500;
export const DEFAULT_APP_INBOX_WAIT_MAX_RETRY_INTERVAL_MSECS = 20_000;
export const DEFAULT_APP_INBOX_WAIT_JITTER_RATIO = 0.2;

export interface AppInboxOptions {
    readonly phaseTiming?: boolean;
    readonly waitMaxElapsedMsecs?: number;
    readonly waitRetryIntervalMsecs?: number;
    readonly waitMaxRetryIntervalMsecs?: number;
    readonly waitJitterRatio?: number;
    readonly nowEpochMs?: () => number;
    readonly timingNowEpochMs?: () => number;
}

export interface NormalizedAppInboxOptions {
    readonly phaseTiming: boolean;
    readonly waitMaxElapsedMsecs: number;
    readonly waitRetryIntervalMsecs: number;
    readonly waitMaxRetryIntervalMsecs: number;
    readonly waitJitterRatio: number;
}

export function normalizeAppInboxOptions(options: AppInboxOptions): NormalizedAppInboxOptions {
    return {
        phaseTiming: options.phaseTiming ?? false,
        waitMaxElapsedMsecs: toNonNegativeFiniteNumber(
            options.waitMaxElapsedMsecs,
            DEFAULT_APP_INBOX_WAIT_MAX_ELAPSED_MSECS
        ),
        waitRetryIntervalMsecs: toNonNegativeFiniteNumber(
            options.waitRetryIntervalMsecs,
            DEFAULT_APP_INBOX_WAIT_RETRY_INTERVAL_MSECS
        ),
        waitMaxRetryIntervalMsecs: toNonNegativeFiniteNumber(
            options.waitMaxRetryIntervalMsecs,
            DEFAULT_APP_INBOX_WAIT_MAX_RETRY_INTERVAL_MSECS
        ),
        waitJitterRatio: toRatio(options.waitJitterRatio, DEFAULT_APP_INBOX_WAIT_JITTER_RATIO)
    };
}

function toNonNegativeFiniteNumber(value: number | undefined, fallback: number): number {
    return value === undefined || !Number.isFinite(value) || value < 0 ? fallback : value;
}

function toRatio(value: number | undefined, fallback: number): number {
    if (value === undefined || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(0, Math.min(1, value));
}
