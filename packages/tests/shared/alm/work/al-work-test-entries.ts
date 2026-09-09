import { toResourceEntryWithKey, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

export function newWorkEntry(typeId: string, effectId: string): ResourceEntry {
    return toResourceEntryWithKey(
        { topicId: 'AL_TEST', resourceId: 'ns', contextId: effectId },
        typeId,
        { effectId }
    );
}
