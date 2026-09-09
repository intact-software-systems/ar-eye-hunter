import type { Key } from '../queuebox/ResourceEntry.ts';

import { decodeALAdmissionRecord, decodeALAdmissionString } from './al-admission-value-validation.ts';

export function decodeALAdmissionResourceEntryKey(value: unknown): Key {
    const key = decodeALAdmissionRecord(value, ['topicId', 'resourceId', 'contextId']);
    return {
        topicId: decodeALAdmissionString(key.topicId),
        resourceId: decodeALAdmissionString(key.resourceId),
        contextId: decodeALAdmissionString(key.contextId)
    };
}
