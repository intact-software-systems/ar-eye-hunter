import type { GroupRef } from '../api/group-types.ts';

/** Whether this tab holds an active subscription token for a room's topic: only then a granted frame is delivered. */
export interface RtcTopicSubscriptionReader {
    isSubscriptionActive(groupRef: GroupRef, topicId: string): boolean;
}
