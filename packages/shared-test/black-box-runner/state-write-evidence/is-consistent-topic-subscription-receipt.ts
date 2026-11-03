import type { ApiJsonObject } from '@shared/api/api-json-value.ts';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';

/** A subscription write records no event and no effect, and its receipt names the outcome its receipt outcome allows. */
const TOPIC_SUBSCRIPTION_OUTCOMES_BY_RECEIPT_OUTCOME: Readonly<Record<string, readonly (string | null)[]>> = {
    applied: ['subscribed', 'renewed', 'unsubscribed'],
    'no-op': ['not-subscribed'],
    rejected: [null]
};

/** True for every receipt of another command type, and for a subscription receipt that keeps that shape. */
export function isConsistentTopicSubscriptionReceipt(commandType: string, receipt: ApiJsonObject): boolean {
    if (commandType !== AppInboxType.GROUP_TOPIC_SUBSCRIBE && commandType !== AppInboxType.GROUP_TOPIC_UNSUBSCRIBE) {
        return true;
    }
    const { outcome, subscriptionOutcome, outboxIds } = receipt;
    const allowed =
        typeof outcome === 'string' && Object.hasOwn(TOPIC_SUBSCRIPTION_OUTCOMES_BY_RECEIPT_OUTCOME, outcome)
            ? TOPIC_SUBSCRIPTION_OUTCOMES_BY_RECEIPT_OUTCOME[outcome]
            : [];
    return receipt.eventId === null &&
        Array.isArray(outboxIds) && outboxIds.length === 0 &&
        (subscriptionOutcome === null || typeof subscriptionOutcome === 'string') &&
        allowed.includes(subscriptionOutcome);
}
