import { Temporal } from '@js-temporal/polyfill';
import { EntityStatus, NEVER_EXPIRE_TS, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

export function newWorkEntry(typeId: string, effectId: string): ResourceEntry {
    return {
        key: { topicId: 'AL_TEST', resourceId: 'ns', contextId: effectId },
        resource: JSON.stringify({ effectId }),
        typeId,
        audit: {
            date: Temporal.Now.plainTimeISO(),
            createdBy: 'test',
            createdTs: Temporal.Now.plainDateTimeISO(),
            expiryTs: NEVER_EXPIRE_TS
        },
        status: EntityStatus.NEW,
        dequeueAudit: {
            attempts: 0
        },
        db: undefined
    };
}
