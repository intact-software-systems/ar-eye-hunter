import { Temporal } from '@js-temporal/polyfill';

import {
    EntityStatus,
    NEVER_EXPIRE_TS,
    toKeyAsString,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';

export const CHECKPOINT_TEST_TYPE_ID = 'checkpoint.work';

export function createCheckpointTestEntry(resourceId: string): ResourceEntry {
    return {
        key: { topicId: CHECKPOINT_TEST_TYPE_ID, resourceId, contextId: 'ctx' },
        resource: JSON.stringify({ resourceId }),
        typeId: CHECKPOINT_TEST_TYPE_ID,
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'test',
            createdTs: Temporal.PlainDateTime.from('2026-10-02T12:00:00'),
            expiryTs: NEVER_EXPIRE_TS
        },
        status: EntityStatus.NEW,
        dequeueAudit: { attempts: 0 }
    };
}

export function toCheckpointTestKey(resourceId: string): string {
    return toKeyAsString(createCheckpointTestEntry(resourceId).key);
}
