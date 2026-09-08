import type { ResourceEntry } from './ResourceEntry.ts';

export interface QueueBoxCompletedRetention {
    readonly typeIds: readonly string[];
    readonly topicIds: readonly string[];
}

/** Selection affects terminal cleanup only; the row's expiry always remains authoritative. */
export function matchesQueueBoxCompletedRetention(
    entry: Pick<ResourceEntry, 'key' | 'typeId'>,
    retention: QueueBoxCompletedRetention
): boolean {
    return retention.typeIds.includes(entry.typeId) || retention.topicIds.includes(entry.key.topicId);
}
