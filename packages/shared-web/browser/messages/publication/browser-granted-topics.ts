import { isGroupPublicationTopicGranted } from '@shared/api/group-publication/group-publication-grants.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RtcGrantedTopicReader } from '@shared/multicast/publication/rtc-granted-topic-reader.ts';

export namespace BrowserGrantedTopics {
    export interface Input {
        /** The room's cached snapshot; `undefined` while none is cached. */
        findGroupSnapshot(roomRef: GroupRef): GroupSnapshot | undefined;
    }
}

/**
 * The page's granted topics: each a typed channel declared granted, and each a cached room snapshot grants. A declared
 * topic stays granted for the page's lifetime and is never undone, by design: one page runs one application.
 */
export class BrowserGrantedTopics implements RtcGrantedTopicReader {
    private readonly declaredTopicIds = new Set<string>();
    private readonly input: BrowserGrantedTopics.Input;

    public constructor(input: BrowserGrantedTopics.Input) {
        this.input = input;
    }

    public declareGrantedTopic(topicId: string): void {
        this.declaredTopicIds.add(topicId);
    }

    public isGrantedTopic(groupRef: GroupRef | undefined, topicId: string): boolean {
        if (this.declaredTopicIds.has(topicId)) {
            return true;
        }
        const snapshot = groupRef === undefined ? undefined : this.input.findGroupSnapshot(groupRef);
        return snapshot !== undefined && isGroupPublicationTopicGranted(snapshot, topicId);
    }
}
