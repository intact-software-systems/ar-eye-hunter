import type { Temporal } from '@js-temporal/polyfill';

import { isKeysEqual, type ResourceEntry } from './ResourceEntry.ts';

export function hasSameResourceEntryValue(
    left: ResourceEntry,
    right: ResourceEntry
): boolean {
    return isKeysEqual(left.key, right.key) &&
        left.resource === right.resource &&
        left.typeId === right.typeId &&
        left.status === right.status &&
        left.audit.date.equals(right.audit.date) &&
        left.audit.createdBy === right.audit.createdBy &&
        left.audit.createdTs.equals(right.audit.createdTs) &&
        left.audit.expiryTs.equals(right.audit.expiryTs) &&
        left.dequeueAudit.attempts === right.dequeueAudit.attempts &&
        haveSameInstant(left.dequeueAudit.startTs, right.dequeueAudit.startTs) &&
        haveSameInstant(left.dequeueAudit.endTs, right.dequeueAudit.endTs) &&
        haveSameInstant(left.dequeueAudit.nextTs, right.dequeueAudit.nextTs) &&
        left.db?.id === right.db?.id;
}

function haveSameInstant(
    left: Temporal.Instant | undefined,
    right: Temporal.Instant | undefined
): boolean {
    return left === undefined || right === undefined
        ? left === right
        : left.equals(right);
}
