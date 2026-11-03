import type { RtcGrantedTopicReader } from '@shared/multicast/publication/rtc-granted-topic-reader.ts';

/** A page with no granted topic: every RTC publication is carried unsigned, as before Slice 3. */
export const NO_RTC_GRANTED_TOPICS: RtcGrantedTopicReader = { isGrantedTopic: () => false };

/** A page whose granted topics are exactly `topicIds`, in every room. */
export function createRtcGrantedTopicsFixture(topicIds: readonly string[]): RtcGrantedTopicReader {
    return { isGrantedTopic: (_groupRef, topicId) => topicIds.includes(topicId) };
}
