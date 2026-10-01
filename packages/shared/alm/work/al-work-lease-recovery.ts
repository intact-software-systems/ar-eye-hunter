import { EntityStatus, type ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '../../queuebox/ResourceInboxRetryPolicy.ts';
import { RateLimiter } from '../../resilience/Resilience.ts';

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

/**
 * How many leases a spent sweep window stays closed at most: the limiter counts its one-lease window in
 * quarter-window buckets, so a spend late in a bucket holds until that bucket leaves the window.
 */
export const AL_WORK_LEASE_SWEEP_WINDOW_LEASES = 1.25;

/**
 * Of each kind, at most one sweep that comes back with room to spare per 1 to `AL_WORK_LEASE_SWEEP_WINDOW_LEASES`
 * leases. A fresh pair holds both allowances, so the owner's first batch sweeps.
 */
export function createLimitedALWorkLeaseRecovery(leaseMs: number, nowMs: number): ALWorkLeaseRecovery {
    return {
        kind: 'limited',
        limiters: {
            timeout: RateLimiter.initWithTs(leaseMs, 1, nowMs),
            finalization: RateLimiter.initWithTs(leaseMs, 1, nowMs)
        }
    };
}

/** Whether the sweep may read now, taken without spending its allowance. */
export function isALWorkLeaseSweepOpen(
    recovery: ALWorkLeaseRecovery,
    sweep: keyof ALWorkLeaseSweepLimiters,
    nowMs: number
): boolean {
    return recovery.kind === 'every-batch' || recovery.limiters[sweep].isAllowedAt(nowMs);
}

/**
 * Spends the sweep's allowance after a read that returned fewer rows than it had room for. A sweep that filled
 * its room leaves the window open, so a backlog drains on every batch.
 */
export function spendALWorkLeaseSweep(
    recovery: ALWorkLeaseRecovery,
    sweep: keyof ALWorkLeaseSweepLimiters,
    nowMs: number
): void {
    if (recovery.kind === 'limited') {
        recovery.limiters[sweep].allowAt(nowMs);
    }
}

/** Both sweeps' windows at `nowMs`, for a readiness scan that must not advertise rows a closed sweep would recover. */
export function computeALWorkLeaseSweepState(recovery: ALWorkLeaseRecovery, nowMs: number): ALWorkLeaseSweepState {
    return {
        isTimeoutOpen: isALWorkLeaseSweepOpen(recovery, 'timeout', nowMs),
        isFinalizationOpen: isALWorkLeaseSweepOpen(recovery, 'finalization', nowMs)
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
