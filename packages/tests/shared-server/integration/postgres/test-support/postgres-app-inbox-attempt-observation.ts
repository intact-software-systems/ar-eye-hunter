import type { ResourceInboxAttemptReleaseTelemetry } from '@shared/queuebox/ResourceInboxAttemptTelemetry.ts';

export interface PersistedAppInboxAttempt {
    readonly resourceId: string;
    readonly attempt: number;
    readonly classification: ResourceInboxAttemptReleaseTelemetry['classification'];
    readonly status: ResourceInboxAttemptReleaseTelemetry['status'];
    readonly retryDelayMs: number;
}

interface RetriedAppInboxAttempt extends Pick<PersistedAppInboxAttempt, 'resourceId' | 'attempt' | 'classification' | 'retryDelayMs'> {}

export interface FindRetriedAppInboxAttemptSequenceInput {
    readonly traces: readonly Readonly<{
        attempts: readonly RetriedAppInboxAttempt[];
    }>[];
    readonly ownedResourceIds: readonly string[];
}

export function findSingleRetriedAppInboxAttemptSequence(
    input: FindRetriedAppInboxAttemptSequenceInput
): readonly RetriedAppInboxAttempt[] {
    const ownedResourceIds = new Set(input.ownedResourceIds);
    const attempts = input.traces
        .flatMap((trace) => trace.attempts)
        .filter((attempt) => ownedResourceIds.has(attempt.resourceId));
    const retried = attempts.filter((attempt) => attempt.classification === 'retryable');
    if (retried.length !== 1) {
        throw new Error(`Expected one retryable AppInbox attempt, found ${retried.length}`);
    }
    const retriedAttempt = retried[0];
    if (retriedAttempt === undefined) {
        throw new Error('Expected the retryable AppInbox attempt to be present');
    }
    return attempts
        .filter((attempt) => attempt.resourceId === retriedAttempt.resourceId)
        .sort((left, right) => left.attempt - right.attempt);
}
