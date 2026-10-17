import type { Temporal } from '@js-temporal/polyfill';

import { Either } from '../resilience/Either.ts';
import type { ResourceInboxWorkPage } from './queue-box-types.ts';
import {
    EntityStatus,
    isExpiredResourceEntry,
    isKeysEqual,
    toKeyAsString,
    type Key,
    type ResourceEntry,
    type ResourceEntryKeyString
} from './ResourceEntry.ts';

export interface ResourceEntryObservedWrite {
    readonly key: ResourceEntryKeyString;
    readonly expected: ResourceEntry | undefined;
    readonly entry: ResourceEntry | undefined;
    readonly existing: ResourceEntry | undefined;
}

export function captureResourceEntryObservations(
    entries: readonly ResourceEntry[] | undefined
): ReadonlyMap<string, ResourceEntry> | undefined {
    return entries === undefined ? undefined : new Map(entries.map((entry) => [
        toObservationKey(entry.key),
        toResourceEntrySnapshot(entry)
    ]));
}

export function resolveResourceEntryObservation(
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

export function resolveResourceInboxWorkPageRequest(
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

export function resolveResourceEntryObservedWrites(
    writes: readonly ResourceEntryObservedWrite[],
    observedAt: Temporal.Instant
): Either<Error | 'conflict', readonly ResourceEntryObservedWrite[]> {
    const keys = new Set<string>();
    const issues: string[] = [];
    for (const write of writes) {
        if (keys.has(write.key)) {
            issues.push('Queue writes contain a duplicate key');
        }
        if (write.expected !== undefined && toKeyAsString(write.expected.key) !== write.key) {
            issues.push('Queue replacement key differs from its observation');
        }
        keys.add(write.key);
    }
    if (issues.length > 0) {
        return Either.ofLeft(new TypeError(issues.join('; ')));
    }
    return writes.some(({ expected, existing }) =>
            expected === undefined
                ? existing !== undefined && !isExpiredResourceEntry(existing, observedAt)
                : existing === undefined || isExpiredResourceEntry(existing, observedAt) ||
                    !hasSameResourceEntryValue(existing, expected)
        )
        ? Either.ofLeft('conflict')
        : Either.ofRight(writes);
}
