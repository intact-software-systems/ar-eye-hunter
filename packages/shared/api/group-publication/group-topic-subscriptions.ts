import { Either } from '../../resilience/Either.ts';
import type { ApiJsonObject, ApiJsonValue } from '../api-json-value.ts';
import type { PrincipalId, SessionId } from '../group-types.ts';
import { validateRallarWsUserTopicId, type RallarValidationIssue } from '../rallar-validation.ts';
import {
    isJsonObject,
    presentKeys,
    toIssue,
    toKeyIssues,
    toNonEmptyStringIssues
} from './group-publication-validation-issues.ts';

/** One session's leased election to receive one granted topic, asserted by one connection generation. */
export interface GroupTopicSubscription {
    readonly sessionId: SessionId;
    readonly principalId: PrincipalId;
    /** A RallarWsUserTopicId. */
    readonly topicId: string;
    /** The asserting connection generation; equal to the client-state session's generationId at write. */
    readonly connectionGenerationId: string;
    /** The write instant plus GROUP_TOPIC_SUBSCRIPTION_LEASE_MS; the row's store expiry. */
    readonly leaseExpiresAtEpochMs: number;
    /** The group's snapshotVersion the write read. */
    readonly admittedAtGroupRevision: number;
}

export const GROUP_TOPIC_SUBSCRIPTION_LEASE_MS = 120_000;

export type GroupTopicSubscriptionOutcome = 'subscribed' | 'renewed' | 'unsubscribed' | 'not-subscribed';

export interface GroupTopicSubscriptionResult {
    readonly outcome: GroupTopicSubscriptionOutcome;
}

/** A session's live rows, in topicId order. */
export interface GroupTopicSubscriptionList {
    readonly subscriptions: readonly GroupTopicSubscription[];
}

const SUBSCRIPTION_KEYS = [
    'sessionId',
    'principalId',
    'topicId',
    'connectionGenerationId',
    'leaseExpiresAtEpochMs',
    'admittedAtGroupRevision'
] as const;

export function decodeGroupTopicSubscription(
    value: unknown
): Either<readonly RallarValidationIssue[], GroupTopicSubscription> {
    const issues = isJsonObject(value)
        ? toSubscriptionIssues(value)
        : [toIssue('$', 'invalid-record', 'Topic subscription must be an object.')];
    return issues.length > 0 ? Either.ofLeft(issues) : Either.ofRight(value as GroupTopicSubscription);
}

export function validateGroupTopicSubscription(subscription: GroupTopicSubscription): readonly RallarValidationIssue[] {
    return decodeGroupTopicSubscription(subscription).fold((issues) => issues, () => []);
}

function toSubscriptionIssues(subscription: ApiJsonObject): readonly RallarValidationIssue[] {
    return [
        ...toKeyIssues(subscription, SUBSCRIPTION_KEYS, '$'),
        ...toNonEmptyStringIssues(subscription, ['sessionId', 'principalId'], '$'),
        ...(typeof subscription.topicId === 'string'
            ? validateRallarWsUserTopicId(subscription.topicId, '$.topicId').issues
            : presentKeys(subscription, ['topicId']).map((key) =>
                toIssue(`$.${key}`, 'invalid-string', `${key} must be a non-empty string.`)
            )),
        ...toNonEmptyStringIssues(subscription, ['connectionGenerationId'], '$'),
        ...presentKeys(subscription, ['leaseExpiresAtEpochMs'])
            .filter((key) => !isSafeIntegerAtLeast(subscription[key], 1))
            .map((key) => toIssue(`$.${key}`, 'invalid-timestamp', `${key} must be a positive integer.`)),
        ...presentKeys(subscription, ['admittedAtGroupRevision'])
            .filter((key) => !isSafeIntegerAtLeast(subscription[key], 1))
            .map((key) => toIssue(`$.${key}`, 'invalid-revision', `${key} must be a positive integer.`))
    ];
}

function isSafeIntegerAtLeast(value: ApiJsonValue | undefined, minimum: number): boolean {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
