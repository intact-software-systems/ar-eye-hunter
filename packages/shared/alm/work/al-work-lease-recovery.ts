import { EntityStatus, type ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '../../queuebox/ResourceInboxRetryPolicy.ts';
import { RateLimiter, SlidingWindowCounter } from '../../resilience/Resilience.ts';

/**
 * One lock limiter per lease sweep, in the role `lockEntryRateLimiter` plays in the ResourceInbox
 * dequeuer, counted on the work owner's clock rather than `Date.now`.
 */
export interface ALWorkLeaseSweepLimiters {
    readonly timeout: RateLimiter;
    readonly finalization: RateLimiter;
}

/** How often a work owner sweeps for reservations whose lease ended without a release. */
export type ALWorkLeaseRecovery =
    | Readonly<{ kind: 'every-batch'; }>
    | Readonly<{ kind: 'limited'; limiters: ALWorkLeaseSweepLimiters; }>;

/** Which sweeps may read now, taken without spending an allowance. */
export interface ALWorkLeaseSweepState {
    readonly isTimeoutOpen: boolean;
    readonly isFinalizationOpen: boolean;
}

/** One sweep of each kind per lease. A fresh pair holds both allowances, so the owner's first batch sweeps. */
export function createLimitedALWorkLeaseRecovery(leaseMs: number, nowMs: number): ALWorkLeaseRecovery {
    return {
        kind: 'limited',
        limiters: {
            timeout: RateLimiter.initWithTs(leaseMs, 1, nowMs),
            finalization: RateLimiter.initWithTs(leaseMs, 1, nowMs)
        }
    };
}

/** Spends the sweep's allowance; false means the sweep must not read. Call it only when the sweep would read. */
export function spendALWorkLeaseSweep(
    recovery: ALWorkLeaseRecovery,
    sweep: 'timeout' | 'finalization',
    nowMs: number
): boolean {
    if (recovery.kind === 'every-batch') {
        return true;
    }
    const limiter = recovery.limiters[sweep];
    return limiter.allowAt(toLimiterNowMs(limiter, nowMs));
}

export function computeALWorkLeaseSweepState(recovery: ALWorkLeaseRecovery, nowMs: number): ALWorkLeaseSweepState {
    if (recovery.kind === 'every-batch') {
        return { isTimeoutOpen: true, isFinalizationOpen: true };
    }
    return {
        isTimeoutOpen: isLeaseSweepOpen(recovery.limiters.timeout, nowMs),
        isFinalizationOpen: isLeaseSweepOpen(recovery.limiters.finalization, nowMs)
    };
}

/**
 * A reserved row waits for the sweep that recovers it: the finalization sweep once the row has spent
 * the retry policy's attempts, the timeout sweep before that.
 */
export function isALWorkLeaseSweepDeferred(entry: ResourceEntry, state: ALWorkLeaseSweepState): boolean {
    if (entry.status !== EntityStatus.RESERVED) {
        return false;
    }
    return entry.dequeueAudit.attempts >= DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        ? !state.isFinalizationOpen
        : !state.isTimeoutOpen;
}

function isLeaseSweepOpen(limiter: RateLimiter, nowMs: number): boolean {
    return SlidingWindowCounter.sumInWindowWithNow(limiter.slidingWindow, toLimiterNowMs(limiter, nowMs)) <
        limiter.policy.maxNumberToAllow;
}

/** The limiter finds no bucket for a time before its creation, so a clock stepped back reads as its creation. */
function toLimiterNowMs(limiter: RateLimiter, nowMs: number): number {
    return Math.max(nowMs, limiter.slidingWindow.createdTs);
}
