import type { ResourceEntry } from './ResourceEntry.ts';

export type ResourceInboxRetryPolicy = Readonly<{
    maxAttempts: number;
    delaysAfterAttemptMs: readonly number[];
    maxDelayMs: number;
    jitterRatio: number;
    staleDueThresholdMs: number;
}>;

export type ResourceInboxRetryDecision =
    | Readonly<{ status: 'retry'; delayMs: number }>
    | Readonly<{ status: 'failed'; delayMs: null }>;

export type ResourceInboxFairnessTelemetry = Readonly<{
    queueAgeMs: number;
    dueAgeMs: number;
    attempt: number;
    type: string;
    lane: 'FAIRNESS';
}>;

export const DEFAULT_RESOURCE_INBOX_RETRY_POLICY: ResourceInboxRetryPolicy = {
    maxAttempts: 20,
    delaysAfterAttemptMs: [
        1,
        2,
        4,
        8,
        16,
        1_000,
        2_000,
        4_000,
        8_000,
        16_000,
    ],
    maxDelayMs: 30_000,
    jitterRatio: 0.2,
    staleDueThresholdMs: 30_000,
};

export function retryAfterAttempt(
    policy: ResourceInboxRetryPolicy,
    attempts: number,
    jitterUnit: number,
): ResourceInboxRetryDecision {
    if (attempts >= policy.maxAttempts) {
        return { status: 'failed', delayMs: null };
    }

    const baseDelayMs = Math.min(
        policy.delaysAfterAttemptMs[attempts - 1] ?? policy.maxDelayMs,
        policy.maxDelayMs,
    );
    const jitterMultiplier =
        1 - policy.jitterRatio + (2 * policy.jitterRatio * jitterUnit);
    const delayMs = Math.max(1, Math.round(baseDelayMs * jitterMultiplier));

    return { status: 'retry', delayMs };
}

export function toResourceInboxFairnessTelemetry(
    entry: ResourceEntry,
    selectedAtEpochMs: number,
): ResourceInboxFairnessTelemetry {
    const createdAtEpochMs = Number(
        entry.audit.createdTs.toZonedDateTime('UTC').toInstant().epochMilliseconds,
    );
    const nextTs = entry.dequeueAudit.nextTs;
    if (!nextTs) {
        throw new Error('Fairness reservation requires a persisted nextTs');
    }

    return {
        queueAgeMs: selectedAtEpochMs - createdAtEpochMs,
        dueAgeMs: selectedAtEpochMs - Number(nextTs.epochMilliseconds),
        attempt: entry.dequeueAudit.attempts,
        type: entry.typeId,
        lane: 'FAIRNESS',
    };
}
