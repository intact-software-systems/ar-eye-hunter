import { Either } from './Either.ts';

export interface RemoteClockObservation {
    readonly remoteEpochMs: number;
    readonly requestStartedAtMonotonicMs: number;
    readonly responseReceivedAtMonotonicMs: number;
}

export interface RemoteClockPolicy {
    readonly maxRoundTripMs: number;
    readonly maxAgeMs: number;
    /** Bound on remote elapsed time relative to local monotonic elapsed time, in parts per million. */
    readonly maxRelativeDriftPpm: number;
    /** Maximum absolute quantization/measurement error of each monotonic reading. */
    readonly maxMonotonicErrorMs: number;
}

export interface RemoteClockWindow {
    readonly earliestEpochMs: number;
    readonly latestEpochMs: number;
}

export interface ComputeRemoteClockWindowInput {
    readonly observation: RemoteClockObservation;
    readonly policy: RemoteClockPolicy;
    readonly nowMonotonicMs: number;
}

/** Bounds assume an uncached millisecond-resolution remote observation and the policy's relative clock-rate bound. */
export function computeRemoteClockWindow(
    input: ComputeRemoteClockWindowInput
): Either<readonly string[], RemoteClockWindow> {
    const issues = validateRemoteClockObservation(input);
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    const { observation, policy, nowMonotonicMs } = input;
    const ageMs = nowMonotonicMs - observation.responseReceivedAtMonotonicMs;
    const roundTripMs = observation.responseReceivedAtMonotonicMs - observation.requestStartedAtMonotonicMs;
    const driftRate = policy.maxRelativeDriftPpm / 1_000_000;
    const intervalErrorMs = policy.maxMonotonicErrorMs * 2;
    const earliestEpochMs = Math.floor(
        observation.remoteEpochMs + Math.max(0, ageMs - intervalErrorMs) * (1 - driftRate) - 1
    );
    const latestEpochMs = Math.ceil(
        observation.remoteEpochMs + (ageMs + roundTripMs + intervalErrorMs) * (1 + driftRate) + 1
    );
    if (!Number.isSafeInteger(earliestEpochMs) || earliestEpochMs < 0 || !Number.isSafeInteger(latestEpochMs)) {
        return Either.ofLeft(['Remote clock bounds exceed the supported epoch range.']);
    }
    return Either.ofRight({ earliestEpochMs, latestEpochMs });
}

function validateRemoteClockObservation(input: ComputeRemoteClockWindowInput): readonly string[] {
    const { observation, policy, nowMonotonicMs } = input;
    const issues: string[] = [];
    if (!Number.isSafeInteger(observation.remoteEpochMs) || observation.remoteEpochMs < 0) {
        issues.push('Remote time must be a nonnegative integer epoch in milliseconds.');
    }
    if (
        [nowMonotonicMs, observation.requestStartedAtMonotonicMs, observation.responseReceivedAtMonotonicMs]
            .some((value) => !Number.isFinite(value) || value < 0) ||
        observation.responseReceivedAtMonotonicMs < observation.requestStartedAtMonotonicMs ||
        nowMonotonicMs < observation.responseReceivedAtMonotonicMs
    ) {
        issues.push('Clock observation must have a finite, ordered monotonic request interval.');
    }
    if (
        [policy.maxRoundTripMs, policy.maxAgeMs].some((value) => !Number.isFinite(value) || value <= 0) ||
        !Number.isFinite(policy.maxRelativeDriftPpm) || policy.maxRelativeDriftPpm < 0 ||
        policy.maxRelativeDriftPpm >= 1_000_000 ||
        !Number.isFinite(policy.maxMonotonicErrorMs) || policy.maxMonotonicErrorMs < 0
    ) {
        issues.push('Remote clock policy must have positive bounds and a relative drift rate below one.');
    }
    const intervalErrorMs = policy.maxMonotonicErrorMs * 2;
    if (
        observation.responseReceivedAtMonotonicMs - observation.requestStartedAtMonotonicMs + intervalErrorMs >
            policy.maxRoundTripMs
    ) {
        issues.push('Remote clock request exceeds the allowed round-trip time.');
    }
    if (nowMonotonicMs - observation.responseReceivedAtMonotonicMs + intervalErrorMs > policy.maxAgeMs) {
        issues.push('Remote clock observation has expired.');
    }
    return issues;
}
