import type { RallarTopicSubscriptionStatus } from '@shared-web/browser/messages/rallar-message-contracts.ts';

import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';
import { decodeAlmRuntimeRecord } from './decode-alm-runtime-record.ts';
import { requireAlmStringField, toAlmInvalidRuntimeResultError } from './decode-alm-runtime-result.ts';
import type {
    AlmTopicSubscriptionEntry,
    RallarBlackBoxTestMessagesSubscribeResultValue,
    RallarBlackBoxTestMessagesSubscriptionsResultValue
} from './rallar-black-box-alm-result-values.ts';

/** Keyed by every token status, so a new status fails to compile here instead of decoding as an invalid result. */
const ALM_TOPIC_SUBSCRIPTION_STATUSES: Readonly<Record<RallarTopicSubscriptionStatus, true>> = {
    pending: true,
    active: true,
    refused: true,
    lapsed: true
};

export function decodeAlmMessagesSubscribeResultValue(
    value: unknown,
    path: string
): RallarBlackBoxTestMessagesSubscribeResultValue {
    const record = decodeAlmRuntimeRecord(value);
    return {
        subscriptionId: requireAlmStringField(record, path, 'subscriptionId'),
        status: requireAlmTopicSubscriptionStatus(record, path)
    };
}

export function decodeAlmMessagesSubscriptionsResultValue(
    value: unknown
): RallarBlackBoxTestMessagesSubscriptionsResultValue {
    const record = decodeAlmRuntimeRecord(value);
    const path = 'messages.subscriptions result';
    const generation = record.connectionGenerationId;
    if (generation !== null && typeof generation !== 'string') {
        throw toAlmInvalidRuntimeResultError(`${path}.connectionGenerationId`);
    }
    const subscriptions = record.subscriptions;
    if (!Array.isArray(subscriptions)) {
        throw toAlmInvalidRuntimeResultError(`${path}.subscriptions`);
    }
    return {
        connectionGenerationId: generation,
        subscriptions: subscriptions.map((entry) => decodeAlmTopicSubscriptionEntry(entry, `${path}.subscriptions`))
    };
}

function decodeAlmTopicSubscriptionEntry(value: unknown, path: string): AlmTopicSubscriptionEntry {
    const record = decodeAlmRuntimeRecord(value);
    return {
        ...decodeAlmMessagesSubscribeResultValue(record, path),
        topicId: requireAlmStringField(record, path, 'topicId')
    };
}

function requireAlmTopicSubscriptionStatus(
    record: RallarBlackBoxTestRecord,
    path: string
): RallarTopicSubscriptionStatus {
    const status = record.status;
    if (typeof status !== 'string' || !Object.hasOwn(ALM_TOPIC_SUBSCRIPTION_STATUSES, status)) {
        throw toAlmInvalidRuntimeResultError(`${path}.status`);
    }
    return status as RallarTopicSubscriptionStatus;
}
