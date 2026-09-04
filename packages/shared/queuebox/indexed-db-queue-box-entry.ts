import { Temporal } from '@js-temporal/polyfill';
import {
    EntityStatus,
    Key,
    NEVER_EXPIRE_TS,
    ResourceEntry,
    ResourceEntryKeyString,
    toKeyAsString
} from './ResourceEntry.ts';

export type StoredResourceEntry = Readonly<{
    keyString: ResourceEntryKeyString;
    revision?: number;
    fairnessDueEpochMs?: number;
    key: Key;
    resource: string;
    typeId: string;
    audit: Readonly<{
        date: string;
        createdBy: string;
        createdTs: string;
        expiryTs?: string;
    }>;
    status: EntityStatus;
    dequeueAudit: Readonly<{
        startTs?: string;
        endTs?: string;
        nextTs?: string;
        attempts: number;
    }>;
}>;

export type ComputedIndexedDbQueueMutation = Readonly<{
    keyString: ResourceEntryKeyString;
    expectedRevision?: number | null;
    value?: StoredResourceEntry;
}>;

export function encodeStoredResourceEntry(
    entry: ResourceEntry,
    revision: number
): StoredResourceEntry {
    return {
        keyString: toKeyAsString(entry.key),
        revision,
        fairnessDueEpochMs: entry.dequeueAudit.nextTs
            ? Number(entry.dequeueAudit.nextTs.epochMilliseconds)
            : undefined,
        key: entry.key,
        resource: entry.resource,
        typeId: entry.typeId,
        audit: {
            date: toPlainTime(entry.audit.date).toString(),
            createdBy: entry.audit.createdBy,
            createdTs: toPlainDateTime(entry.audit.createdTs).toString(),
            expiryTs: toInstant(entry.audit.expiryTs).toString()
        },
        status: entry.status,
        dequeueAudit: {
            startTs: toOptionalInstant(entry.dequeueAudit.startTs)?.toString(),
            endTs: toOptionalInstant(entry.dequeueAudit.endTs)?.toString(),
            nextTs: toOptionalInstant(entry.dequeueAudit.nextTs)?.toString({
                fractionalSecondDigits: 9
            }),
            attempts: entry.dequeueAudit.attempts
        }
    };
}

export function decodeStoredResourceEntry(stored: StoredResourceEntry): ResourceEntry {
    return {
        key: stored.key,
        resource: stored.resource,
        typeId: stored.typeId,
        audit: {
            date: toPlainTime(stored.audit.date),
            createdBy: stored.audit.createdBy,
            createdTs: toPlainDateTime(stored.audit.createdTs),
            expiryTs: stored.audit.expiryTs
                ? toInstant(stored.audit.expiryTs)
                : NEVER_EXPIRE_TS
        },
        status: stored.status,
        dequeueAudit: {
            startTs: toOptionalInstant(stored.dequeueAudit.startTs),
            endTs: toOptionalInstant(stored.dequeueAudit.endTs),
            nextTs: toOptionalInstant(stored.dequeueAudit.nextTs),
            attempts: stored.dequeueAudit.attempts
        },
        db: {
            id: stored.keyString
        }
    };
}

export function storedResourceEntryRevision(stored: StoredResourceEntry): number {
    return stored.revision ?? 0;
}

export function computeIndexedDbQueuePut(
    stored: StoredResourceEntry | undefined,
    entry: ResourceEntry
): ComputedIndexedDbQueueMutation {
    const expectedRevision = stored ? storedResourceEntryRevision(stored) : null;
    return {
        keyString: toKeyAsString(entry.key),
        expectedRevision,
        value: encodeStoredResourceEntry(entry, (expectedRevision ?? -1) + 1)
    };
}

export function computeIndexedDbQueueDelete(
    stored: StoredResourceEntry
): ComputedIndexedDbQueueMutation {
    return {
        keyString: stored.keyString,
        expectedRevision: storedResourceEntryRevision(stored)
    };
}

export function computeReservedQueueEntry(
    entry: ResourceEntry,
    now: Temporal.Instant
): ResourceEntry {
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

export function isStoredQueueEntryExpired(
    stored: StoredResourceEntry,
    now: Temporal.Instant
): boolean {
    const expiryTs = stored.audit.expiryTs
        ? Temporal.Instant.from(stored.audit.expiryTs)
        : NEVER_EXPIRE_TS;
    return Temporal.Instant.compare(now, expiryTs) >= 0;
}

export function isStoredQueueEntryReservable(
    input: Readonly<{
        stored: StoredResourceEntry;
        typeIds: ReadonlySet<string>;
        statusIds: ReadonlySet<EntityStatus>;
        now: Temporal.Instant;
        maxAttempts: number;
    }>
): boolean {
    const { stored, typeIds, statusIds, now, maxAttempts } = input;
    if (isStoredQueueEntryExpired(stored, now)) {
        return false;
    }
    if (!typeIds.has(stored.typeId) || !statusIds.has(stored.status)) {
        return false;
    }
    if (stored.status === EntityStatus.FAILED || stored.dequeueAudit.attempts >= maxAttempts) {
        return false;
    }
    return !stored.dequeueAudit.nextTs ||
        Temporal.Instant.compare(now, Temporal.Instant.from(stored.dequeueAudit.nextTs)) >= 0;
}

export function isStoredQueueEntryTimedOut(
    input: Readonly<{
        stored: StoredResourceEntry;
        typeIds: ReadonlySet<string>;
        duration: Temporal.Duration;
        now: Temporal.Instant;
    }>
): boolean {
    const { stored, typeIds, duration, now } = input;
    if (
        isStoredQueueEntryExpired(stored, now) ||
        !typeIds.has(stored.typeId) ||
        stored.status !== EntityStatus.RESERVED ||
        !stored.dequeueAudit.startTs
    ) {
        return false;
    }
    const startTs = Temporal.Instant.from(stored.dequeueAudit.startTs);
    return Temporal.Instant.compare(now, startTs.add(duration)) >= 0;
}

function temporalText(value: string | object, fallback: string): string {
    if (typeof value === 'string' && value.length > 0 && value !== '[object Object]') {
        return value;
    }

    if (
        value &&
        typeof value === 'object' &&
        'toString' in value &&
        typeof value.toString === 'function'
    ) {
        const text = value.toString();
        if (text.length > 0 && text !== '[object Object]') {
            return text;
        }
    }

    return fallback;
}

function toPlainTime(value: string | Temporal.PlainTime): Temporal.PlainTime {
    const fallback = Temporal.Now.plainTimeISO();
    try {
        return Temporal.PlainTime.from(temporalText(value, fallback.toString()));
    }
    catch {
        return fallback;
    }
}

function toPlainDateTime(value: string | Temporal.PlainDateTime): Temporal.PlainDateTime {
    const fallback = Temporal.Now.plainDateTimeISO();
    try {
        return Temporal.PlainDateTime.from(temporalText(value, fallback.toString()));
    }
    catch {
        return fallback;
    }
}

function toInstant(
    value: string | Temporal.Instant,
    fallback: Temporal.Instant = NEVER_EXPIRE_TS
): Temporal.Instant {
    try {
        return Temporal.Instant.from(temporalText(value, fallback.toString()));
    }
    catch {
        return fallback;
    }
}

function toOptionalInstant(
    value: string | Temporal.Instant | undefined
): Temporal.Instant | undefined {
    if (value === undefined) {
        return undefined;
    }

    try {
        return Temporal.Instant.from(temporalText(value, ''));
    }
    catch {
        return undefined;
    }
}
