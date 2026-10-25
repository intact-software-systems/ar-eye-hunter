import { Temporal } from '@js-temporal/polyfill';
import { EntityStatus, isExpiredResourceEntry, type ResourceEntry } from './ResourceEntry.ts';

import type { InMemoryQueueBox } from './in-memory-queue-box.ts';

export function computeReservedResourceEntry(entry: ResourceEntry, now: Temporal.Instant): ResourceEntry {
    return {
        ...entry,
        status: EntityStatus.RESERVED,
        dequeueAudit: {
            startTs: now,
            endTs: undefined,
            nextTs: undefined,
            attempts: entry.dequeueAudit.attempts + 1
        }
    };
}

export function isNewEntryDue(entry: ResourceEntry, now: Temporal.Instant): boolean {
    return entry.status === EntityStatus.NEW &&
        (entry.dequeueAudit.nextTs === undefined || Temporal.Instant.compare(entry.dequeueAudit.nextTs, now) <= 0);
}

export function isRetryEntryDueBefore(entry: ResourceEntry, dueBefore: Temporal.Instant): boolean {
    return entry.status === EntityStatus.RETRY && entry.dequeueAudit.nextTs !== undefined &&
        Temporal.Instant.compare(entry.dequeueAudit.nextTs, dueBefore) <= 0;
}

export function isReservedEntryStartedBefore(entry: ResourceEntry, startedBefore: Temporal.Instant): boolean {
    return entry.status === EntityStatus.RESERVED && entry.dequeueAudit.startTs !== undefined &&
        Temporal.Instant.compare(entry.dequeueAudit.startTs, startedBefore) <= 0;
}

export function isInMemoryQueueEntryReservable(read: InMemoryQueueBox.ReservationRead): boolean {
    const { entry, now } = read;
    return read.typeIds.has(entry.typeId) && read.statusIds.has(entry.status) &&
        !isExpiredResourceEntry(entry, now) && entry.status !== EntityStatus.FAILED &&
        entry.dequeueAudit.attempts < read.maxAttempts &&
        (entry.dequeueAudit.nextTs === undefined || Temporal.Instant.compare(now, entry.dequeueAudit.nextTs) >= 0);
}
