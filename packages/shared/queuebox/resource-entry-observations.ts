import type { Temporal } from '@js-temporal/polyfill';

import { Either } from '../resilience/Either.ts';
import type { ResourceInboxWorkPage } from './queue-box-types.ts';
import {
    EntityStatus,
    isKeysEqual,
    type Key,
    type ResourceEntry
} from './ResourceEntry.ts';

export function captureResourceEntryObservations(
    entries: readonly ResourceEntry[] | undefined
): ReadonlyMap<string, ResourceEntry> | undefined {
    return entries === undefined ? undefined : new Map(entries.map((entry) => [
        toObservationKey(entry.key),
        toResourceEntrySnapshot(entry)
    ]));
}

export function validateResourceEntryObservation(
    current: ResourceEntry,
    observations: ReadonlyMap<string, ResourceEntry> | undefined
): Either<'stale', ResourceEntry> {
    if (observations === undefined) {
        return Either.ofRight(current);
    }
    const observed = observations.get(toObservationKey(current.key));
    return observed !== undefined && hasSameResourceEntryValue(current, observed)
        ? Either.ofRight(current)
        : Either.ofLeft('stale');
}

function toObservationKey(key: Key): string {
    return JSON.stringify([key.topicId, key.resourceId, key.contextId]);
}

export function toResourceEntrySnapshot(entry: ResourceEntry): ResourceEntry {
    // Temporal leaves are immutable; copy the mutable records without structuredClone losing their prototypes.
    return {
        ...entry,
        key: { ...entry.key },
        audit: { ...entry.audit },
        dequeueAudit: { ...entry.dequeueAudit },
        db: entry.db === undefined ? undefined : { ...entry.db }
    };
}

export function validateResourceInboxWorkPageRequest(
    request: ResourceInboxWorkPage.Request
): Either<TypeError, ResourceInboxWorkPage.Request> {
    const issues: string[] = [];
    if (typeof request.typeId !== 'string' || request.typeId.length === 0) {
        issues.push('Queue work pages require a nonempty type');
    }
    if (!Object.values(EntityStatus).includes(request.status)) {
        issues.push('Queue work pages require a known status');
    }
    if (!Number.isSafeInteger(request.maxToRead) || request.maxToRead < 1 || request.maxToRead > 256) {
        issues.push('Queue work pages require a limit between 1 and 256');
    }
    if (
        request.cursor !== null && (
            request.cursor.typeId !== request.typeId || request.cursor.status !== request.status ||
            typeof request.cursor.position !== 'string' || request.cursor.position.length === 0
        )
    ) {
        issues.push('Queue work cursor requires a position matching its requested type and status');
    }
    return issues.length > 0 ? Either.ofLeft(new TypeError(issues.join('; '))) : Either.ofRight(request);
}

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
