import { Temporal } from '@js-temporal/polyfill';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

export function hasSameResourceEntryContent(
    left: ResourceEntry,
    right: ResourceEntry
): boolean {
    return left.key.topicId === right.key.topicId &&
        left.key.resourceId === right.key.resourceId &&
        left.key.contextId === right.key.contextId &&
        left.resource === right.resource &&
        left.typeId === right.typeId &&
        left.status === right.status &&
        left.audit.createdBy === right.audit.createdBy &&
        hasSamePersistedPlainDateTime(left.audit.createdTs, right.audit.createdTs) &&
        left.audit.expiryTs.epochMilliseconds === right.audit.expiryTs.epochMilliseconds &&
        left.dequeueAudit.attempts === right.dequeueAudit.attempts &&
        hasSameOptionalInstant(left.dequeueAudit.startTs, right.dequeueAudit.startTs) &&
        hasSameOptionalInstant(left.dequeueAudit.endTs, right.dequeueAudit.endTs) &&
        hasSameOptionalInstant(left.dequeueAudit.nextTs, right.dequeueAudit.nextTs);
}

export function hasSamePersistedResourceEntry(
    left: ResourceEntry,
    right: ResourceEntry
): boolean {
    return hasSameResourceEntryContent(left, right) && left.db?.id === right.db?.id;
}

export function hasSameResourceEntryIdentity(
    left: ResourceEntry,
    right: ResourceEntry
): boolean {
    return left.key.topicId === right.key.topicId &&
        left.key.resourceId === right.key.resourceId &&
        left.key.contextId === right.key.contextId &&
        left.typeId === right.typeId;
}

function hasSameOptionalInstant(
    left: Temporal.Instant | undefined,
    right: Temporal.Instant | undefined
): boolean {
    return left === undefined || right === undefined
        ? left === right
        : left.epochMilliseconds === right.epochMilliseconds;
}

function hasSamePersistedPlainDateTime(
    left: Temporal.PlainDateTime,
    right: Temporal.PlainDateTime
): boolean {
    return Temporal.PlainDateTime.compare(
        left.with({ microsecond: 0, nanosecond: 0 }),
        right.with({ microsecond: 0, nanosecond: 0 })
    ) === 0;
}
