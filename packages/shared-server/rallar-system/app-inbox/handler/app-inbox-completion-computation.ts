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
import { serializeCanonicalJson } from '../../protocol/canonical-json.ts';
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
    if (issues.length > 0) {
        return issues;
    }
    const expected = computeAppInboxCompletion(input);
    if (computed.durableResult !== input.durableResult) {
        issues.push(toAppInboxCompletionValidationIssue('computed.durableResult', 'must be the computed result'));
    }
    if (!hasSameJsonWireValue(computed.encodedResult, expected.encodedResult)) {
        issues.push(toAppInboxCompletionValidationIssue(
            'computed.encodedResult',
            'must encode the computed durable result'
        ));
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
        !hasSameResultReplacement(computed.resultReplacement, expected.resultReplacement)
    ) {
        issues.push(toAppInboxCompletionValidationIssue(
            'computed.resultReplacement',
            'must target the reserved entry with the computed status'
        ));
    }
    if (
        !hasSameFinalizedEntry(computed.finalizedEntry, expected.finalizedEntry)
    ) {
        issues.push(toAppInboxCompletionValidationIssue(
            'computed.finalizedEntry',
            'must describe the completed reservation'
        ));
    }
    if (
        !(computed.reservationConflict instanceof AppInboxReservationConflictError) ||
        !hasSameResourceInboxKey(computed.reservationConflict.key, input.entry.key)
    ) {
        issues.push(toAppInboxCompletionValidationIssue(
            'computed.reservationConflict',
            'must describe the reserved entry'
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

function hasSameJsonWireValue(left: JsonWireValue, right: JsonWireValue): boolean {
    try {
        return serializeCanonicalJson(left) === serializeCanonicalJson(right);
    }
    catch {
        return false;
    }
}

function hasSameResultReplacement(
    left: ResourceInboxResultReplacement,
    right: ResourceInboxResultReplacement
): boolean {
    return left.resourceId === right.resourceId &&
        left.topicId === right.topicId &&
        left.resource === right.resource &&
        left.typeId === right.typeId &&
        left.status === right.status &&
        left.contextId === right.contextId &&
        left.systemDate === right.systemDate &&
        left.createdBy === right.createdBy &&
        left.createdAt === right.createdAt &&
        left.expiresAt === right.expiresAt;
}

function hasSameFinalizedEntry(left: ResourceEntry, right: ResourceEntry): boolean {
    return hasSameResourceInboxKey(left.key, right.key) &&
        left.resource === right.resource &&
        left.typeId === right.typeId &&
        left.status === right.status &&
        left.audit.date.equals(right.audit.date) &&
        left.audit.createdBy === right.audit.createdBy &&
        left.audit.createdTs.equals(right.audit.createdTs) &&
        left.audit.expiryTs.equals(right.audit.expiryTs) &&
        hasSameOptionalInstant(left.dequeueAudit.startTs, right.dequeueAudit.startTs) &&
        hasSameOptionalInstant(left.dequeueAudit.endTs, right.dequeueAudit.endTs) &&
        hasSameOptionalInstant(left.dequeueAudit.nextTs, right.dequeueAudit.nextTs) &&
        left.dequeueAudit.attempts === right.dequeueAudit.attempts &&
        left.db?.id === right.db?.id;
}

function hasSameOptionalInstant(
    left: Temporal.Instant | undefined,
    right: Temporal.Instant | undefined
): boolean {
    return left === undefined || right === undefined
        ? left === right
        : left.equals(right);
}

function toAppInboxCompletionValidationIssue(
    path: string,
    reason: string
): AppInboxCompletionValidationIssue {
    const message = `AppInbox ${path} ${reason}`;
    return { path, message, cause: new TypeError(message) };
}
