import type { Timers } from '@shared/resilience/timers.ts';

export const DEFAULT_APP_INBOX_WAIT_MAX_ELAPSED_MSECS = 10_000;
export const DEFAULT_APP_INBOX_WAIT_RETRY_INTERVAL_MSECS = 500;
export const DEFAULT_APP_INBOX_WAIT_MAX_RETRY_INTERVAL_MSECS = 20_000;
export const DEFAULT_APP_INBOX_WAIT_JITTER_RATIO = 0.2;
/** Above the hosted p99 handler time; an abandoned claim's late finish still fails its attempt guard after a reclaim. */
export const APP_INBOX_RESERVATION_LEASE_MS = 60_000;
/**
 * How long before its reservation lease runs out a handler attempt is abandoned, so the serial lane moves on and
 * the attempt's own commit is refused before another process can reclaim the entry.
 */
export const DEFAULT_APP_INBOX_ATTEMPT_DEADLINE_MARGIN_MS = 5_000;
/**
 * A waiter with a live completion subscription re-reads on a wake, or on this tick when a wake was lost. Well below
 * any caller's HTTP allowance (the native fixtures allow 5 s), so one lost wake costs a tick, not the request.
 */
export const APP_INBOX_WAIT_SAFETY_TICK_MSECS = 1_000;

export interface AppInboxOptions {
    readonly phaseTiming?: boolean;
    readonly attemptDeadlineMarginMs?: number;
    readonly waitMaxElapsedMsecs?: number;
    readonly waitRetryIntervalMsecs?: number;
    readonly waitMaxRetryIntervalMsecs?: number;
    readonly waitJitterRatio?: number;
    readonly nowEpochMs?: () => number;
    readonly timers?: Timers;
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

/** The handler side's one option: how far below its reservation lease an attempt's deadline falls. */
export function resolveAppInboxAttemptDeadlineMarginMs(options: AppInboxOptions): number {
    return toNonNegativeFiniteNumber(options.attemptDeadlineMarginMs, DEFAULT_APP_INBOX_ATTEMPT_DEADLINE_MARGIN_MS);
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
