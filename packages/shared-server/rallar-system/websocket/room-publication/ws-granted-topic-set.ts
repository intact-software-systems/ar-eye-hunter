/**
 * The topic ids whose definitions declare `participation: 'granted'`. Built at the composition root before the
 * router and the target resolver: the router's `define` adds to it, and the resolver refuses to resolve its topics.
 */
export class WsGrantedTopicSet {
    private readonly topicIds = new Set<string>();

    add(topicId: string): void {
        this.topicIds.add(topicId);
    }

    has(topicId: string): boolean {
        return this.topicIds.has(topicId);
    }
}
