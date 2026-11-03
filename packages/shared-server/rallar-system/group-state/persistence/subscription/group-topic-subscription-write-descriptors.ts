import {
    validateGroupTopicSubscription,
    type GroupTopicSubscription
} from '@shared/api/group-publication/group-topic-subscriptions.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { formatRallarValidation } from '@shared/api/rallar-validation.ts';

import type {
    RuntimeStateGuardedBatchDelete,
    RuntimeStateGuardedBatchEffect,
    RuntimeStateGuardedBatchInsert,
    RuntimeStateGuardedBatchUpdate
} from '../../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { GroupTopicSubscriptionDeleteEffect } from '../../mutation/group-mutation-contracts.ts';
import { SUBSCRIPTIONS_NAMESPACE } from '../group-state-runtime-namespaces.ts';
import { serializeGroupStateValue } from '../serialize-group-state-value.ts';
import { groupStateTopicSubscriptionStorageKey } from './group-topic-subscription-storage-key.ts';

/** The row expires from the store at its lease, so every reader takes a lapsed subscription for absent. */
export function groupStateInsertTopicSubscriptionDescriptor(
    ref: GroupRef,
    subscription: GroupTopicSubscription
): RuntimeStateGuardedBatchInsert {
    const issues = validateGroupTopicSubscription(subscription);
    if (issues.length > 0) {
        throw new TypeError(`Topic subscription row is invalid: ${formatRallarValidation(issues)}`);
    }
    return {
        operation: 'insert',
        namespace: SUBSCRIPTIONS_NAMESPACE,
        key: groupStateTopicSubscriptionStorageKey(ref, subscription.sessionId, subscription.topicId),
        value: serializeGroupStateValue(subscription),
        expireAtTimestamp: subscription.leaseExpiresAtEpochMs
    };
}

export function groupStateUpdateTopicSubscriptionDescriptor(
    ref: GroupRef,
    subscription: GroupTopicSubscription,
    expectedRevision: number
): RuntimeStateGuardedBatchUpdate {
    return { ...groupStateInsertTopicSubscriptionDescriptor(ref, subscription), operation: 'update', expectedRevision };
}

export function groupStateDeleteTopicSubscriptionDescriptor(
    ref: GroupRef,
    subscription: GroupTopicSubscription,
    expectedRevision: number
): RuntimeStateGuardedBatchDelete {
    return {
        operation: 'delete',
        namespace: SUBSCRIPTIONS_NAMESPACE,
        key: groupStateTopicSubscriptionStorageKey(ref, subscription.sessionId, subscription.topicId),
        expectedRevision
    };
}

export function toTopicSubscriptionDeleteBatchEffect(
    effect: GroupTopicSubscriptionDeleteEffect
): RuntimeStateGuardedBatchEffect {
    return {
        effectId: `topic-subscription:${effect.value.sessionId}:${effect.value.topicId}`,
        ...groupStateDeleteTopicSubscriptionDescriptor(effect.ref, effect.value, effect.expectedRevision)
    };
}
