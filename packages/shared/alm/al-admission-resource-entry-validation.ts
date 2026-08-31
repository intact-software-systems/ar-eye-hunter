import { Temporal } from '@js-temporal/polyfill';

import { EntityStatus, type Key, type ResourceEntry } from '../queuebox/ResourceEntry.ts';

export interface StoredALAdmissionResourceEntry {
    readonly key: ResourceEntry['key'];
    readonly resource: string;
    readonly typeId: string;
    readonly audit: Readonly<{
        date: string;
        createdBy: string;
        createdTs: string;
        expiryTs: string;
    }>;
    readonly status: ResourceEntry['status'];
    readonly dequeueAudit: Readonly<{
        startTs: string | undefined;
        endTs: string | undefined;
        nextTs: string | undefined;
        attempts: number;
    }>;
    readonly db: ResourceEntry['db'];
}

/** IndexedDB structured cloning cannot preserve Temporal instances; durable entries use their ISO strings. */
export function encodeALAdmissionResourceEntry(entry: ResourceEntry): StoredALAdmissionResourceEntry {
    return {
        key: entry.key,
        resource: entry.resource,
        typeId: entry.typeId,
        audit: {
            date: entry.audit.date.toString(),
            createdBy: entry.audit.createdBy,
            createdTs: entry.audit.createdTs.toString(),
            expiryTs: entry.audit.expiryTs.toString()
        },
        status: entry.status,
        dequeueAudit: {
            startTs: entry.dequeueAudit.startTs?.toString(),
            endTs: entry.dequeueAudit.endTs?.toString(),
            nextTs: entry.dequeueAudit.nextTs?.toString(),
            attempts: entry.dequeueAudit.attempts
        },
        db: entry.db
    };
}

export function decodeALAdmissionResourceEntry(value: unknown): ResourceEntry {
    const entry = decodeResourceEntryRecord(value, [
        'key',
        'resource',
        'typeId',
        'audit',
        'status',
        'dequeueAudit',
        'db'
    ]);
    const audit = decodeResourceEntryRecord(entry.audit, ['date', 'createdBy', 'createdTs', 'expiryTs']);
    const dequeue = decodeResourceEntryRecord(entry.dequeueAudit, ['startTs', 'endTs', 'nextTs', 'attempts']);
    if (!Number.isSafeInteger(dequeue.attempts) || typeof dequeue.attempts !== 'number' || dequeue.attempts < 0) {
        throw new TypeError('Persisted AL resource entry dequeue attempts are invalid');
    }
    if (!Object.values(EntityStatus).some((status) => status === entry.status)) {
        throw new TypeError('Persisted AL resource entry status is invalid');
    }
    const db = entry.db === undefined ? undefined : decodeResourceEntryRecord(entry.db, ['id']);
    return {
        key: decodeALAdmissionResourceEntryKey(entry.key),
        resource: decodeResourceEntryString(entry.resource),
        typeId: decodeResourceEntryString(entry.typeId),
        audit: {
            date: decodeResourceEntryTime(audit.date),
            createdBy: decodeResourceEntryString(audit.createdBy),
            createdTs: decodeResourceEntryDateTime(audit.createdTs),
            expiryTs: decodeResourceEntryInstant(audit.expiryTs)
        },
        status: entry.status as ResourceEntry['status'],
        dequeueAudit: {
            attempts: dequeue.attempts,
            startTs: dequeue.startTs === undefined ? undefined : decodeResourceEntryInstant(dequeue.startTs),
            endTs: dequeue.endTs === undefined ? undefined : decodeResourceEntryInstant(dequeue.endTs),
            nextTs: dequeue.nextTs === undefined ? undefined : decodeResourceEntryInstant(dequeue.nextTs)
        },
        db: db === undefined ? undefined : { id: decodeResourceEntryString(db.id) }
    };
}

export function decodeALAdmissionResourceEntryKey(value: unknown): Key {
    const key = decodeResourceEntryRecord(value, ['topicId', 'resourceId', 'contextId']);
    return {
        topicId: decodeResourceEntryString(key.topicId),
        resourceId: decodeResourceEntryString(key.resourceId),
        contextId: decodeResourceEntryString(key.contextId)
    };
}

function decodeResourceEntryRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new TypeError('Persisted AL resource entry section is invalid');
    }
    for (const key of Reflect.ownKeys(value)) {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || !fields.includes(key) || !property?.enumerable || !('value' in property)) {
            throw new TypeError('Persisted AL resource entry field is invalid');
        }
    }
    return value as Record<string, unknown>;
}

function decodeResourceEntryString(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError('Persisted AL resource entry string is invalid');
    }
    return value;
}

function decodeResourceEntryTime(value: unknown): Temporal.PlainTime {
    if (value instanceof Temporal.PlainTime) {
        return value;
    }
    return Temporal.PlainTime.from(decodeResourceEntryString(value));
}

function decodeResourceEntryDateTime(value: unknown): Temporal.PlainDateTime {
    if (value instanceof Temporal.PlainDateTime) {
        return value;
    }
    return Temporal.PlainDateTime.from(decodeResourceEntryString(value));
}

function decodeResourceEntryInstant(value: unknown): Temporal.Instant {
    if (value instanceof Temporal.Instant) {
        return value;
    }
    return Temporal.Instant.from(decodeResourceEntryString(value));
}
