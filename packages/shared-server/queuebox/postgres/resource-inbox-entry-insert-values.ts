import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import {
    toPgTimestamp,
    toSystemDate
} from './resource-inbox-row-codec.ts';

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
    const snapshot = { ...entry };
    return {
        entry: snapshot,
        systemDate: toSystemDate(snapshot),
        createdTimestamp: toPgTimestamp(snapshot.audit.createdTs),
        expiryTimestamp: toPgTimestamp(snapshot.audit.expiryTs),
        startTimestamp: snapshot.dequeueAudit.startTs ? toPgTimestamp(snapshot.dequeueAudit.startTs) : null,
        endTimestamp: snapshot.dequeueAudit.endTs ? toPgTimestamp(snapshot.dequeueAudit.endTs) : null,
        nextTimestamp: snapshot.dequeueAudit.nextTs ? toPgTimestamp(snapshot.dequeueAudit.nextTs) : null,
        attempts: snapshot.dequeueAudit.attempts
    };
}
