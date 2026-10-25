const DEFAULT_APP_INBOX_CONFLICT_RETRY_MAX_DELAY_MS = 250;

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
 * The finished-retention contract, `finishedRetentionMs` (R) from this floor to `MAX_APP_INBOX_FINISHED_RETENTION_MS`.
 * A command's idempotency record and the rows it derives expire at its ingress plus R; its AppInbox fact and result
 * expire at its completion plus R. Until the fact expires a replay of the command's key returns the stored result,
 * even once the idempotency record has expired; after it the same key executes again, and its writes replace any
 * expired row still under their keys before the sweep removes it. Writers decide "expired" on the database clock,
 * readers on the process clock: skew between the two gives a bounded conflict retry or a stored-result replay just
 * past the window, never a second write.
 *
 * The floor is the shortest window a command's derived rows may live. A formation timer is due up to the longest
 * formation deadline, stage-trigger delay or replan wait (600 000 ms each) after its ingress but expires at ingress
 * plus this window, and every queue reader skips a row past its expiry, so a shorter window would hide a timer before
 * it is due and stall its group in forming. One hour also outlasts every result waiter.
 */
export const MIN_APP_INBOX_FINISHED_RETENTION_MS = 3_600_000;
export const MAX_APP_INBOX_FINISHED_RETENTION_MS = 2_592_000_000;

export interface AppInboxOptions {
    /** Final delay ceiling for classified optimistic conflicts; ordinary failures retain QueueBox backoff. */
    readonly conflictRetryMaxDelayMs?: number;
    readonly phaseTiming?: boolean;
    readonly attemptDeadlineMarginMs?: number;
    readonly waitMaxElapsedMsecs?: number;
    readonly waitRetryIntervalMsecs?: number;
    readonly waitMaxRetryIntervalMsecs?: number;
    readonly waitJitterRatio?: number;
    readonly nowEpochMs?: () => number;
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

export interface AppInboxAttemptDeadlineIssue {
    readonly code: 'app-inbox-attempt-deadline-margin-outside-lease';
    readonly message: string;
}

/** The margin and the lease have different owners, so the process that pairs them checks it once at startup. */
export function validateAppInboxAttemptDeadlineMargin(
    options: AppInboxOptions,
    reservationLeaseMs: number
): readonly AppInboxAttemptDeadlineIssue[] {
    const marginMs = resolveAppInboxAttemptDeadlineMarginMs(options);
    return marginMs > 0 && marginMs < reservationLeaseMs
        ? []
        : [{
            code: 'app-inbox-attempt-deadline-margin-outside-lease',
            message:
                `AppInbox attempt deadline margin ${marginMs} ms must lie inside the ${reservationLeaseMs} ms reservation lease`
        }];
}

/** A positive integer ceiling; invalid explicit policy fails at construction instead of silently defaulting. */
export function resolveAppInboxConflictRetryMaxDelayMs(options: AppInboxOptions): number {
    const delayMs = options.conflictRetryMaxDelayMs ?? DEFAULT_APP_INBOX_CONFLICT_RETRY_MAX_DELAY_MS;
    if (!Number.isSafeInteger(delayMs) || delayMs < 1 || delayMs > MAX_APP_INBOX_FINISHED_RETENTION_MS) {
        throw new RangeError(`AppInbox conflict retry maximum delay must be a positive safe integer no greater than ${MAX_APP_INBOX_FINISHED_RETENTION_MS}`);
    }
    return delayMs;
}

/** How far below its reservation lease an attempt's deadline falls. */
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
