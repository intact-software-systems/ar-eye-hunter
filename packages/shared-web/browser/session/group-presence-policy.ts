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
    if (leaseMs <= renewalIntervalMs + 3 * requestTimeoutMs + retryMs) {
        issues.push(
            new RangeError(
                'Group presence lease must allow renewal completion, the next attempt and one bounded retry.'
            )
        );
    }
    return issues;
}
