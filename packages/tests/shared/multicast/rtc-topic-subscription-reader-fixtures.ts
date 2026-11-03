import type { RtcTopicSubscriptionReader } from '@shared/multicast/rtc-topic-subscription-reader.ts';

/** A tab with no active subscription token: a granted frame it admits is forwarded, never delivered. */
export const NO_RTC_TOPIC_SUBSCRIPTIONS: RtcTopicSubscriptionReader = { isSubscriptionActive: () => false };

/** A tab whose held tokens are active for exactly `topicIds`, in every room. */
export function createRtcTopicSubscriptionsFixture(topicIds: readonly string[]): RtcTopicSubscriptionReader {
    return { isSubscriptionActive: (_groupRef, topicId) => topicIds.includes(topicId) };
}
