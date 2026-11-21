import type { ApiMiddleware } from '../rallar-connection-facade.ts';

/** Opt-in room presence timing. This does not shorten the authenticated client session. */
export interface RallarGroupPresencePolicy {
    readonly leaseMs: number;
    readonly renewalIntervalMs: number;
    /** Shared deadline for the entire renewal attempt; nested requests inherit its cancellation. */
    readonly requestTimeoutMs: number;
    readonly retryMs: number;
}

/** Capture caller-owned configuration before a running connection can observe later mutations. */
export function captureGroupPresencePolicy(
    policy: RallarGroupPresencePolicy | undefined
): RallarGroupPresencePolicy | undefined {
    if (policy === undefined) {
        return undefined;
    }
    const issues = validateGroupPresencePolicy(policy);
    if (issues.length > 0) {
        throw issues[0];
    }
    return Object.freeze({ ...policy });
}

function validateGroupPresencePolicy(policy: RallarGroupPresencePolicy): readonly Error[] {
    const { leaseMs, renewalIntervalMs, requestTimeoutMs, retryMs } = policy;
    const issues: Error[] = [];
    if (
        ![leaseMs, renewalIntervalMs, requestTimeoutMs, retryMs].every((value) =>
            Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647
        )
    ) {
        issues.push(
            new TypeError(
                'Group presence timings must be positive integer milliseconds within the browser timer range.'
            )
        );
    }
    // Budget the previous completion, a failed renewal and its retry at the same whole-attempt bound.
    if (!canIssueGroupPresenceLease(policy, 0)) {
        issues.push(
            new RangeError(
                'Group presence lease must allow renewal completion, the next attempt and one bounded retry.'
            )
        );
    }
    return issues;
}

/** Clock uncertainty consumes the same lease headroom as renewal work. */
export function canIssueGroupPresenceLease(policy: RallarGroupPresencePolicy, windowWidthMs: number): boolean {
    return policy.leaseMs > windowWidthMs + policy.renewalIntervalMs + 3 * policy.requestTimeoutMs + policy.retryMs;
}

export function readGroupPresenceCreationEpochMs(context: ApiMiddleware): number {
    return context.serverTime.readWindow().fold(
        (failure) => {
            throw failure.cause;
        },
        (window) => {
            const policy = context.middleware.heartbeat.groupPresence;
            if (policy && !canIssueGroupPresenceLease(policy, window.latestEpochMs - window.earliestEpochMs)) {
                throw new TypeError(
                    'Server clock uncertainty leaves insufficient time to renew the group presence lease.'
                );
            }
            return window.earliestEpochMs;
        }
    );
}
