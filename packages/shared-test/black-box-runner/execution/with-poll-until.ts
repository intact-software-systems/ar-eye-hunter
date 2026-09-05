// deno-lint-ignore-file no-explicit-any
import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

const SUCCESS = 'SUCCESS';

export interface PollUntilPolicy {
    readonly maxAttempts: number;
    readonly maxDurationMs: number;
    readonly backoffMs: number;
    readonly backoffMultiplier: number;
    /** The condition must hold continuously for this long; 0 accepts the first pass. */
    readonly stableForMs: number;
}

export interface WithPollUntilInput {
    readonly request: any;
    readonly execute: () => Promise<any>;
}

function isRecord(value: unknown): value is Record<string, ApiJsonValue> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function hasPollUntilPolicy(request: any): boolean {
    return isRecord(request?.poll);
}

export function toPollUntilPolicy(request: any): PollUntilPolicy {
    const poll = isRecord(request?.poll) ? request.poll : {};

    return {
        maxAttempts: Number.parseInt(String(poll.maxAttempts ?? 10), 10),
        maxDurationMs: Number.parseInt(String(poll.maxDurationMs ?? 15000), 10),
        backoffMs: Number.parseInt(String(poll.backoffMs ?? 100), 10),
        backoffMultiplier: Number.parseFloat(String(poll.backoffMultiplier ?? 2)),
        stableForMs: Number.parseInt(String(poll.stableForMs ?? 0), 10)
    };
}

export function withPollReportFields(status: any, poll: any): any {
    return {
        ...status,
        pollAttempts: poll.attempts,
        pollExhausted: poll.exhausted,
        pollElapsedMs: poll.elapsedMs,
        ...(poll.stableForMs > 0 ? { pollStableForMs: poll.stableForMs } : {})
    };
}

function toBackoffMs(policy: PollUntilPolicy, attemptNumber: number): number {
    return policy.backoffMs * Math.pow(policy.backoffMultiplier, attemptNumber - 1);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Repeats `execute` until its own expectation passes, which is what separates
 * polling from transport retry: retry is for a request that failed to be made,
 * polling is for state that has not converged yet.
 *
 * With `stableForMs` the condition must hold *continuously* for that long, and
 * any lapse restarts the window — the difference between a value that has
 * converged and one passing through on its way somewhere else. Without a
 * declared policy the step runs exactly once and carries no poll fields, so a
 * step that never asked to poll is unchanged.
 */
export async function withPollUntil(input: WithPollUntilInput): Promise<any> {
    if (!hasPollUntilPolicy(input.request)) {
        return await input.execute();
    }

    const policy = toPollUntilPolicy(input.request);
    const startedAtEpochMs = Date.now();
    let lastStatus: any;
    let stableSinceEpochMs: number | undefined;

    for (let attemptNumber = 1; attemptNumber <= policy.maxAttempts; attemptNumber++) {
        lastStatus = await input.execute();
        const elapsedMs = Date.now() - startedAtEpochMs;

        if (lastStatus?.status === SUCCESS) {
            stableSinceEpochMs = stableSinceEpochMs ?? Date.now();
            if (Date.now() - stableSinceEpochMs >= policy.stableForMs) {
                return withPollReportFields(lastStatus, {
                    attempts: attemptNumber,
                    exhausted: false,
                    elapsedMs,
                    stableForMs: policy.stableForMs
                });
            }
        }
        else {
            stableSinceEpochMs = undefined;
        }

        const backoffMs = toBackoffMs(policy, attemptNumber);
        if (attemptNumber >= policy.maxAttempts || elapsedMs + backoffMs > policy.maxDurationMs) {
            return withPollReportFields(toExhaustedStatus(lastStatus, policy), {
                attempts: attemptNumber,
                exhausted: true,
                elapsedMs,
                stableForMs: policy.stableForMs
            });
        }

        await sleep(backoffMs);
    }

    return withPollReportFields(toExhaustedStatus(lastStatus, policy), {
        attempts: policy.maxAttempts,
        exhausted: true,
        elapsedMs: Date.now() - startedAtEpochMs,
        stableForMs: policy.stableForMs
    });
}

/**
 * A last attempt that passed but never held for `stableForMs` is not a pass —
 * reporting it as one would be the silent weakening the stability window exists
 * to prevent.
 */
function toExhaustedStatus(lastStatus: any, policy: PollUntilPolicy): any {
    if (policy.stableForMs <= 0 || lastStatus?.status !== SUCCESS) {
        return lastStatus;
    }

    return {
        ...lastStatus,
        status: 'FAILURE',
        result: `Polled condition never held for ${policy.stableForMs}ms`
    };
}
