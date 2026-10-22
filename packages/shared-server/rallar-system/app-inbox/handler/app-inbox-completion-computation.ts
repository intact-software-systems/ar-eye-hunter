import { Temporal } from '@js-temporal/polyfill';
import {
    EntityStatus,
    toResourceEntryWithUpdatedResource,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import type {
    ResourceInboxReservationFinish,
    ResourceInboxRetainedReservationFinish
} from '../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import {
    computeResourceInboxResultReplacement,
    type ResourceInboxResultReplacement
} from '../../../queuebox/postgres/resource-inbox-result-replacement.ts';
import {
    validateComputedData,
    validateComputedProjection
} from '../../computed-data-validation.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { encodeAppInboxResult } from '../app-inbox-registration-codecs.ts';

interface AppInboxCompletionValidationIssue {
    readonly path: string;
    readonly message: string;
    readonly cause: TypeError;
}

export interface AppInboxCompletionFacts {
    readonly entry: ResourceEntry;
    readonly completedAtEpochMs: number;
    /**
     * How long the finished fact and its result stay after completion. Inside the window a replay of the command's
     * key returns the stored result; once the expiry sweep removes them, the same key executes again.
     */
    readonly finishedRetentionMs: number;
}

export interface AppInboxCompletionInput<Result> extends AppInboxCompletionFacts {
    readonly durableResult: Result;
    readonly status: ResourceInboxReservationFinish['status'];
}

interface AppInboxCompletionValidationFacts extends AppInboxCompletionFacts {
    readonly status: ResourceInboxReservationFinish['status'];
}

export interface AppInboxCompletionComputed<Result> {
    readonly durableResult: Result;
    readonly encodedResult: JsonWireValue;
    readonly resultReplacement: ResourceInboxResultReplacement;
    readonly reservationFinish: ResourceInboxRetainedReservationFinish;
    readonly finalizedEntry: ResourceEntry;
}

export function computeAppInboxCompletion<Result>(
    input: AppInboxCompletionInput<Result>
): AppInboxCompletionComputed<Result> {
    const encodedResult = encodeAppInboxResult(input.durableResult, 'AppInbox completion result');
    const expiresAtEpochMs = input.completedAtEpochMs + input.finishedRetentionMs;
    const retainedEntry: ResourceEntry = {
        ...input.entry,
        audit: { ...input.entry.audit, expiryTs: Temporal.Instant.fromEpochMilliseconds(expiresAtEpochMs) }
    };
    return {
        durableResult: input.durableResult,
        encodedResult,
        resultReplacement: computeResourceInboxResultReplacement(
            toResourceEntryWithUpdatedResource(retainedEntry, input.status, encodedResult)
        ),
        reservationFinish: {
            key: input.entry.key,
            expectedAttempts: input.entry.dequeueAudit.attempts,
            status: input.status,
            completedAt: new Date(input.completedAtEpochMs),
            expiresAt: new Date(expiresAtEpochMs)
        },
        finalizedEntry: {
            ...retainedEntry,
            status: input.status,
            dequeueAudit: {
                ...input.entry.dequeueAudit,
                endTs: Temporal.Instant.fromEpochMilliseconds(input.completedAtEpochMs),
                nextTs: undefined
            }
        }
    };
}

export function validateAppInboxCompletion<Result>(
    input: AppInboxCompletionInput<Result>,
    computed: AppInboxCompletionComputed<Result>
): readonly AppInboxCompletionValidationIssue[] {
    const issues = validateAppInboxCompletionFacts(input);
    if (issues.length > 0) {
        issues.push(...validateComputedData(computed, 'computed'));
        return issues;
    }
    const expected = computeAppInboxCompletion(input);
    issues.push(...validateComputedProjection(expected, computed, 'computed'));
    return issues;
}

export function validateAppInboxCompletionFacts(
    input: AppInboxCompletionValidationFacts
): AppInboxCompletionValidationIssue[] {
    const issues: AppInboxCompletionValidationIssue[] = [];
    const completedAtIsValid = isEpochMs(input.completedAtEpochMs);
    if (!completedAtIsValid) {
        issues.push(
            toAppInboxCompletionValidationIssue('completedAtEpochMs', 'must be a valid epoch millisecond timestamp')
        );
    }
    if (
        !Number.isSafeInteger(input.finishedRetentionMs) || input.finishedRetentionMs < 1 ||
        (completedAtIsValid && !isEpochMs(input.completedAtEpochMs + input.finishedRetentionMs))
    ) {
        issues.push(
            toAppInboxCompletionValidationIssue('finishedRetentionMs', 'must be a positive retention after completion')
        );
    }
    if (!Number.isSafeInteger(input.entry.dequeueAudit.attempts) || input.entry.dequeueAudit.attempts < 1) {
        issues.push(
            toAppInboxCompletionValidationIssue('entry.dequeueAudit.attempts', 'must identify a reserved attempt')
        );
    }
    if (input.entry.status !== EntityStatus.RESERVED) {
        issues.push(toAppInboxCompletionValidationIssue('entry.status', 'must be RESERVED'));
    }
    if (
        input.status !== EntityStatus.COMPLETED && input.status !== EntityStatus.FAILED &&
        input.status !== EntityStatus.NON_RETRYABLE
    ) {
        issues.push(toAppInboxCompletionValidationIssue('status', 'must be COMPLETED, FAILED or NON_RETRYABLE'));
    }
    return issues;
}

function isEpochMs(value: number): boolean {
    return Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15;
}

function toAppInboxCompletionValidationIssue(
    path: string,
    reason: string
): AppInboxCompletionValidationIssue {
    const message = `AppInbox ${path} ${reason}`;
    return { path, message, cause: new TypeError(message) };
}
