import type { GroupRef } from '../../api/group-types.ts';

/**
 * Whether a topic is granted: the RTC origin signs a publication on it, and a relay or receiver judges every frame on
 * it by proof. A frame naming no room (`groupRef` absent) is granted when the page declared its topic granted.
 */
export interface RtcGrantedTopicReader {
    isGrantedTopic(groupRef: GroupRef | undefined, topicId: string): boolean;
}
