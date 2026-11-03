import type { GroupRef } from '../api/group-types.ts';

/** Whether a room's topic is granted: the RTC origin signs a publication on it, or refuses to carry it. */
export interface RtcGrantedTopicReader {
    isGrantedTopic(groupRef: GroupRef, topicId: string): boolean;
}
