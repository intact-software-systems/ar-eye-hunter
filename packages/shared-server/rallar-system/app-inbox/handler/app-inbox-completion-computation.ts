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
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { AppInboxReservationConflictError } from '../app-inbox-contracts.ts';
import { encodeAppInboxResult } from '../app-inbox-registration-codecs.ts';

export interface AppInboxCompletionValidationIssue {
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

export interface AppInboxCompletionValidationFacts extends AppInboxCompletionFacts {
    readonly status: typeof EntityStatus.COMPLETED | typeof EntityStatus.FAILED;
}

export interface AppInboxCompletionComputed<Result> {
    readonly durableResult: Result;
    readonly encodedResult: JsonWireValue;
    readonly resultReplacement: ResourceInboxResultReplacement;
    readonly reservationFinish: ResourceInboxReservationFinish;
    readonly reservationConflict: AppInboxReservationConflictError;
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
        reservationConflict: new AppInboxReservationConflictError(input.entry.key),
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
    if (computed.durableResult !== input.durableResult) {
        issues.push(toAppInboxCompletionValidationIssue('computed.durableResult', 'must be the computed result'));
    }
    if (
        !hasSameResourceInboxKey(computed.reservationFinish.key, input.entry.key) ||
        computed.reservationFinish.expectedAttempts !== input.entry.dequeueAudit.attempts ||
        computed.reservationFinish.status !== input.status ||
        computed.reservationFinish.completedAt.getTime() !== input.completedAtEpochMs
    ) {
        issues.push(toAppInboxCompletionValidationIssue(
            'computed.reservationFinish',
            'must match the reserved entry and completion facts'
        ));
    }
    if (
        computed.resultReplacement.resourceId !== input.entry.key.resourceId ||
        computed.resultReplacement.topicId !== input.entry.key.topicId ||
        computed.resultReplacement.contextId !== input.entry.key.contextId ||
        computed.resultReplacement.status !== input.status
    ) {
        issues.push(toAppInboxCompletionValidationIssue(
            'computed.resultReplacement',
            'must target the reserved entry with the computed status'
        ));
    }
    if (
        !hasSameResourceInboxKey(computed.finalizedEntry.key, input.entry.key) ||
        computed.finalizedEntry.status !== input.status ||
        computed.finalizedEntry.dequeueAudit.endTs?.epochMilliseconds !== input.completedAtEpochMs ||
        computed.finalizedEntry.dequeueAudit.nextTs !== undefined
    ) {
        issues.push(toAppInboxCompletionValidationIssue(
            'computed.finalizedEntry',
            'must describe the completed reservation'
        ));
    }
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

function hasSameResourceInboxKey(
    left: ResourceEntry['key'],
    right: ResourceEntry['key']
): boolean {
    return left.topicId === right.topicId &&
        left.resourceId === right.resourceId &&
        left.contextId === right.contextId;
}

function toAppInboxCompletionValidationIssue(
    path: string,
    reason: string
): AppInboxCompletionValidationIssue {
    const message = `AppInbox ${path} ${reason}`;
    return { path, message, cause: new TypeError(message) };
}
