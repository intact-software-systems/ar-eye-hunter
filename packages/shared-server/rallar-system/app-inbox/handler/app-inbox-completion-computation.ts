import { Temporal } from '@js-temporal/polyfill';
import {
    EntityStatus,
    toResourceEntryWithUpdatedResource,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import type { ResourceInboxReservationFinish } from '../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import {
    toPgTimestamp,
    toSystemDate
} from '../../../queuebox/postgres/resource-inbox-row-codec.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { AppInboxReservationConflictError } from '../app-inbox-contracts.ts';
import { encodeAppInboxResult } from '../app-inbox-registration-codecs.ts';
import {
    toAppInboxComputedValidationIssue,
    validateAppInboxComputedProjection,
    type AppInboxComputedValidationIssue
} from './app-inbox-computed-validation.ts';

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

export interface AppInboxResultReplacement {
    readonly resourceId: string;
    readonly topicId: string;
    readonly resource: string;
    readonly typeId: string;
    readonly status: ResourceEntry['status'];
    readonly contextId: string;
    readonly systemDate: string;
    readonly createdBy: string;
    readonly createdAt: string;
    readonly expiresAt: string;
}

export interface AppInboxCompletionComputed<Result> {
    readonly durableResult: Result;
    readonly encodedResult: JsonWireValue;
    readonly resultReplacement: AppInboxResultReplacement;
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
        resultReplacement: computeAppInboxResultReplacement(
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

export function computeAppInboxResultReplacement(
    entry: ResourceEntry
): AppInboxResultReplacement {
    return {
        resourceId: entry.key.resourceId,
        topicId: entry.key.topicId,
        resource: entry.resource,
        typeId: entry.typeId,
        status: entry.status,
        contextId: entry.key.contextId,
        systemDate: toSystemDate(entry),
        createdBy: entry.audit.createdBy,
        createdAt: toPgTimestamp(entry.audit.createdTs),
        expiresAt: toPgTimestamp(entry.audit.expiryTs)
    };
}

export function validateAppInboxCompletion<Result>(
    input: AppInboxCompletionInput<Result>,
    computed: AppInboxCompletionComputed<Result>
): readonly AppInboxComputedValidationIssue[] {
    const issues = validateAppInboxCompletionFacts(input);
    if (issues.length > 0) {
        return issues;
    }
    return validateAppInboxComputedProjection(computeAppInboxCompletion(input), computed, 'computed');
}

export function validateAppInboxCompletionFacts(
    input: AppInboxCompletionValidationFacts
): readonly AppInboxComputedValidationIssue[] {
    const issues: AppInboxComputedValidationIssue[] = [];
    if (!Number.isSafeInteger(input.completedAtEpochMs) || Math.abs(input.completedAtEpochMs) > 8.64e15) {
        issues.push(
            toAppInboxComputedValidationIssue('completedAtEpochMs', 'must be a valid epoch millisecond timestamp')
        );
    }
    if (!Number.isSafeInteger(input.entry.dequeueAudit.attempts) || input.entry.dequeueAudit.attempts < 1) {
        issues.push(
            toAppInboxComputedValidationIssue('entry.dequeueAudit.attempts', 'must identify a reserved attempt')
        );
    }
    if (input.entry.status !== EntityStatus.RESERVED) {
        issues.push(toAppInboxComputedValidationIssue('entry.status', 'must be RESERVED'));
    }
    if (input.status !== EntityStatus.COMPLETED && input.status !== EntityStatus.FAILED) {
        issues.push(toAppInboxComputedValidationIssue('status', 'must be COMPLETED or FAILED'));
    }
    return issues;
}

