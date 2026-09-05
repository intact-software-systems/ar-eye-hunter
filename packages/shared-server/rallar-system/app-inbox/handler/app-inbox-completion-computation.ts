import { Temporal } from '@js-temporal/polyfill';
import {
    EntityStatus,
    toResourceEntryWithUpdatedResource,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import type { ResourceInboxReservationFinish } from '../../../queuebox/postgres/resource-inbox-reservation-write.ts';
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
}

export interface AppInboxCompletionInput<Result> extends AppInboxCompletionFacts {
    readonly durableResult: Result;
    readonly status: typeof EntityStatus.COMPLETED | typeof EntityStatus.FAILED;
}

interface AppInboxCompletionValidationFacts extends AppInboxCompletionFacts {
    readonly status: typeof EntityStatus.COMPLETED | typeof EntityStatus.FAILED;
}

export interface AppInboxCompletionComputed<Result> {
    readonly durableResult: Result;
    readonly encodedResult: JsonWireValue;
    readonly resultReplacement: ResourceInboxResultReplacement;
    readonly reservationFinish: ResourceInboxReservationFinish;
    readonly finalizedEntry: ResourceEntry;
}

export function computeAppInboxCompletion<Result>(
    input: AppInboxCompletionInput<Result>
): AppInboxCompletionComputed<Result> {
    const encodedResult = encodeAppInboxResult(input.durableResult, 'AppInbox completion result');
    return {
        durableResult: input.durableResult,
        encodedResult,
        resultReplacement: computeResourceInboxResultReplacement(
            toResourceEntryWithUpdatedResource(input.entry, input.status, encodedResult)
        ),
        reservationFinish: {
            key: input.entry.key,
            expectedAttempts: input.entry.dequeueAudit.attempts,
            status: input.status,
            completedAt: new Date(input.completedAtEpochMs)
        },
        finalizedEntry: {
            ...input.entry,
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
    if (!Number.isSafeInteger(input.completedAtEpochMs) || Math.abs(input.completedAtEpochMs) > 8.64e15) {
        issues.push(
            toAppInboxCompletionValidationIssue('completedAtEpochMs', 'must be a valid epoch millisecond timestamp')
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
    if (input.status !== EntityStatus.COMPLETED && input.status !== EntityStatus.FAILED) {
        issues.push(toAppInboxCompletionValidationIssue('status', 'must be COMPLETED or FAILED'));
    }
    return issues;
}

function toAppInboxCompletionValidationIssue(
    path: string,
    reason: string
): AppInboxCompletionValidationIssue {
    const message = `AppInbox ${path} ${reason}`;
    return { path, message, cause: new TypeError(message) };
}
