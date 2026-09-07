import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { toPgTimestamp, toSystemDate } from './resource-inbox-row-codec.ts';

export interface ResourceInboxEntryInsertValues {
    readonly entry: ResourceEntry;
    readonly systemDate: string;
    readonly createdTimestamp: string;
    readonly expiryTimestamp: string;
    readonly startTimestamp: string | null;
    readonly endTimestamp: string | null;
    readonly nextTimestamp: string | null;
    readonly attempts: number;
}

export function computeResourceInboxEntryInsertValues(entry: ResourceEntry): ResourceInboxEntryInsertValues {
    return {
        entry,
        systemDate: toSystemDate(entry),
        createdTimestamp: toPgTimestamp(entry.audit.createdTs),
        expiryTimestamp: toPgTimestamp(entry.audit.expiryTs),
        startTimestamp: entry.dequeueAudit.startTs ? toPgTimestamp(entry.dequeueAudit.startTs) : null,
        endTimestamp: entry.dequeueAudit.endTs ? toPgTimestamp(entry.dequeueAudit.endTs) : null,
        nextTimestamp: entry.dequeueAudit.nextTs ? toPgTimestamp(entry.dequeueAudit.nextTs) : null,
        attempts: entry.dequeueAudit.attempts
    };
}
