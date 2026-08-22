import type { ResourceInboxFairnessSelection } from './QueueBoxTypes.ts';

export type ResourceInboxRetryPolicy = Readonly<{
    maxAttempts: number;
    delaysAfterAttemptMs: readonly number[];
    maxDelayMs: number;
    jitterRatio: number;
    staleDueThresholdMs: number;
}>;

export type ResourceInboxRetryDecision =
    | Readonly<{ status: 'retry'; delayMs: number; }>
    | Readonly<{ status: 'failed'; delayMs: null; }>;

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
        16_000
    ],
    maxDelayMs: 30_000,
    jitterRatio: 0.2,
    staleDueThresholdMs: 30_000
};

export const RESOURCE_INBOX_RETRY_PROCESSING_MARGIN_MS = 60_000;

export function resourceInboxRetryHorizonMs(
    policy: ResourceInboxRetryPolicy = DEFAULT_RESOURCE_INBOX_RETRY_POLICY
): number {
    let horizonMs = 0;
    for (let attempt = 1; attempt < policy.maxAttempts; attempt += 1) {
        const baseDelayMs = Math.min(
            policy.delaysAfterAttemptMs[attempt - 1] ?? policy.maxDelayMs,
            policy.maxDelayMs
        );
        horizonMs += Math.max(1, Math.ceil(baseDelayMs * (1 + policy.jitterRatio)));
    }
    return horizonMs;
}

export const DEFAULT_RESOURCE_INBOX_RETRY_HORIZON_MS = resourceInboxRetryHorizonMs(
    DEFAULT_RESOURCE_INBOX_RETRY_POLICY
);

export function resourceInboxRetryExpiryAtEpochMs(
    capturedAtEpochMs: number,
    requestedExpireAtEpochMs = capturedAtEpochMs
): number {
    if (
        !Number.isSafeInteger(capturedAtEpochMs) || capturedAtEpochMs < 0 ||
        !Number.isSafeInteger(requestedExpireAtEpochMs) ||
        requestedExpireAtEpochMs < capturedAtEpochMs
    ) {
        throw new TypeError('Resource inbox retry expiry input is invalid');
    }
    const minimumExpireAtEpochMs = capturedAtEpochMs +
        DEFAULT_RESOURCE_INBOX_RETRY_HORIZON_MS +
        RESOURCE_INBOX_RETRY_PROCESSING_MARGIN_MS;
    if (!Number.isSafeInteger(minimumExpireAtEpochMs)) {
        throw new RangeError('Resource inbox retry expiry exceeds the safe timestamp range');
    }
    return Math.max(requestedExpireAtEpochMs, minimumExpireAtEpochMs);
}

export function retryAfterAttempt(
    policy: ResourceInboxRetryPolicy,
    attempts: number,
    jitterUnit: number
): ResourceInboxRetryDecision {
    if (attempts >= policy.maxAttempts) {
        return { status: 'failed', delayMs: null };
    }

    const baseDelayMs = Math.min(
        policy.delaysAfterAttemptMs[attempts - 1] ?? policy.maxDelayMs,
        policy.maxDelayMs
    );
    const jitterMultiplier = 1 - policy.jitterRatio + (2 * policy.jitterRatio * jitterUnit);
    const delayMs = Math.max(1, Math.round(baseDelayMs * jitterMultiplier));

    return { status: 'retry', delayMs };
}

export function toResourceInboxFairnessTelemetry(
    selection: ResourceInboxFairnessSelection,
    selectedAtEpochMs: number
): ResourceInboxFairnessTelemetry {
    const { entry, selectedDueTs } = selection;
    const createdAtEpochMs = Number(
        entry.audit.createdTs.toZonedDateTime('UTC').toInstant().epochMilliseconds
    );

    return {
        queueAgeMs: selectedAtEpochMs - createdAtEpochMs,
        dueAgeMs: selectedAtEpochMs - Number(selectedDueTs.epochMilliseconds),
        attempt: entry.dequeueAudit.attempts,
        type: entry.typeId,
        lane: 'FAIRNESS'
    };
}
