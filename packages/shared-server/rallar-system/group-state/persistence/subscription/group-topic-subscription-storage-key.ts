import type { GroupRef } from '@shared/api/group-types.ts';

import {
    decodeGroupStateChildStorageKeyValues,
    groupStateChildStorageKey,
    groupStateChildStorageKeySuffix
} from '../aggregate/group-aggregate-storage-keys.ts';

export function groupStateTopicSubscriptionStorageKey(ref: GroupRef, sessionId: string, topicId: string): string {
    return `${groupStateChildStorageKey(ref, 'session', sessionId)}${
        groupStateChildStorageKeySuffix('topic', topicId)
    }`;
}

export function decodeGroupStateTopicSubscriptionStorageKey(
    storageKey: string
): GroupRef & Readonly<{ sessionId: string; topicId: string; }> {
    const { ref, values } = decodeGroupStateChildStorageKeyValues(storageKey, ['session', 'topic']);
    return { ...ref, sessionId: values[0], topicId: values[1] };
}
