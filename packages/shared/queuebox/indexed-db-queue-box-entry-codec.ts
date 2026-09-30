import { Temporal } from '@js-temporal/polyfill';

import {
    COMPLETED_STATUSES,
    EntityStatus,
    toKeyAsString,
    type Key,
    type ResourceEntry,
    type ResourceEntryKeyString
} from './ResourceEntry.ts';

export type StoredResourceEntry = Readonly<{
    keyString: ResourceEntryKeyString;
    revision: number;
    fairnessDueEpochMs?: number;
    key: Key;
    resource: string;
    typeId: string;
    audit: Readonly<{
        date: string;
        createdBy: string;
        createdTs: string;
        expiryTs: string;
    }>;
    expiryEpochMs: number;
    status: EntityStatus;
    dequeueAudit: Readonly<{
        startTs?: string;
        endTs?: string;
        nextTs?: string;
        attempts: number;
    }>;
    /** Null only while unreleased; a completed row with no recorded release defaults to 0 so retention cleanup can still index it. */
    endEpochMs: number | null;
}>;

type IndexedDbQueueDataValue =
    | string
    | number
    | boolean
    | null
    | undefined
    | IndexedDbQueueDataRecord
    | readonly IndexedDbQueueDataValue[];

interface IndexedDbQueueDataRecord {
    readonly [key: string]: IndexedDbQueueDataValue;
}

interface DataRecordFields {
    readonly required: readonly string[];
    readonly optional?: readonly string[];
}

const ROW_FIELDS: DataRecordFields = {
    required: [
        'keyString',
        'revision',
        'key',
        'resource',
        'typeId',
        'audit',
        'expiryEpochMs',
        'status',
        'dequeueAudit',
        'endEpochMs'
    ],
    optional: ['fairnessDueEpochMs']
};
const KEY_FIELDS: DataRecordFields = { required: ['topicId', 'resourceId', 'contextId'] };
const AUDIT_FIELDS: DataRecordFields = { required: ['date', 'createdBy', 'createdTs', 'expiryTs'] };
const DEQUEUE_AUDIT_FIELDS: DataRecordFields = {
    required: ['attempts'],
    optional: ['startTs', 'endTs', 'nextTs']
};

interface StoredResourceEntryTimestamps {
    readonly date: Temporal.PlainTime;
    readonly createdTs: Temporal.PlainDateTime;
    readonly expiryTs: Temporal.Instant;
    readonly startTs: Temporal.Instant | undefined;
    readonly endTs: Temporal.Instant | undefined;
    readonly nextTs: Temporal.Instant | undefined;
}

/** Frozen rows whose timestamp strings and epoch-ms mirrors were produced from, or checked against, these values. */
const verifiedTimestamps = new WeakMap<object, StoredResourceEntryTimestamps>();

export function encodeStoredResourceEntry(
    entry: ResourceEntry,
    revision: number
): StoredResourceEntry {
    const timestamps = toStoredResourceEntryTimestamps(entry);
    return freezeVerifiedStoredResourceEntry(
        toStoredResourceEntry(entry, revision, timestamps),
        timestamps
    );
}

export function decodeStoredResourceEntry(stored: StoredResourceEntry): ResourceEntry {
    const canonical = decodeStoredResourceEntryValue(stored);
    return {
        key: canonical.key,
        resource: canonical.resource,
        typeId: canonical.typeId,
        audit: {
            date: toPlainTime(canonical.audit.date),
            createdBy: canonical.audit.createdBy,
            createdTs: toPlainDateTime(canonical.audit.createdTs),
            expiryTs: toInstant(canonical.audit.expiryTs)
        },
        status: canonical.status,
        dequeueAudit: {
            startTs: toOptionalInstant(canonical.dequeueAudit.startTs),
            endTs: toOptionalInstant(canonical.dequeueAudit.endTs),
            nextTs: toOptionalInstant(canonical.dequeueAudit.nextTs),
            attempts: canonical.dequeueAudit.attempts
        },
        db: {
            id: canonical.keyString
        }
    };
}

export function decodeStoredResourceEntryValue<Value>(value: Value): StoredResourceEntry {
    const canonical = decodeStoredResourceEntryFields(value);
    if (getVerifiedTimestamps(value) === undefined) {
        decodeStoredResourceEntryTimestamps(canonical);
    }
    return canonical;
}

function toStoredResourceEntryTimestamps(entry: ResourceEntry): StoredResourceEntryTimestamps {
    const expiryTs = toInstant(entry.audit.expiryTs);
    const endTs = toOptionalInstant(entry.dequeueAudit.endTs);
    const nextTs = toOptionalInstant(entry.dequeueAudit.nextTs);
    return {
        date: toPlainTime(entry.audit.date),
        createdTs: toPlainDateTime(entry.audit.createdTs),
        expiryTs,
        startTs: toOptionalInstant(entry.dequeueAudit.startTs),
        endTs,
        nextTs
    };
}

function toStoredResourceEntry(
    entry: ResourceEntry,
    revision: number,
    timestamps: StoredResourceEntryTimestamps
): StoredResourceEntry {
    const { expiryTs, endTs, nextTs } = timestamps;
    return {
        keyString: toKeyAsString(entry.key),
        revision,
        fairnessDueEpochMs: toOptionalEpochMs(nextTs),
        key: { ...entry.key },
        resource: entry.resource,
        typeId: entry.typeId,
        audit: {
            date: timestamps.date.toString(),
            createdBy: entry.audit.createdBy,
            createdTs: timestamps.createdTs.toString(),
            expiryTs: expiryTs.toString()
        },
        expiryEpochMs: Number(expiryTs.epochMilliseconds),
        status: entry.status,
        dequeueAudit: {
            startTs: timestamps.startTs?.toString(),
            endTs: endTs?.toString(),
            nextTs: nextTs?.toString({ fractionalSecondDigits: 9 }),
            attempts: entry.dequeueAudit.attempts
        },
        endEpochMs: toExpectedEndEpochMs(entry.status, endTs)
    };
}

function decodeStoredResourceEntryTimestamps(
    stored: StoredResourceEntry
): StoredResourceEntryTimestamps {
    const date = toPlainTime(stored.audit.date);
    const createdTs = toPlainDateTime(stored.audit.createdTs);
    const expiryTs = toInstant(stored.audit.expiryTs);
    if (stored.expiryEpochMs !== Number(expiryTs.epochMilliseconds)) {
        throw new TypeError(
            'IndexedDB queue expiry timestamp (ms) differs from its expiry instant'
        );
    }
    const startTs = toOptionalInstant(stored.dequeueAudit.startTs);
    const endTs = toOptionalInstant(stored.dequeueAudit.endTs);
    if (stored.endEpochMs !== toExpectedEndEpochMs(stored.status, endTs)) {
        throw new TypeError('IndexedDB queue end timestamp (ms) differs from its dequeue audit');
    }
    const nextTs = toOptionalInstant(stored.dequeueAudit.nextTs);
    if (stored.fairnessDueEpochMs !== toOptionalEpochMs(nextTs)) {
        throw new TypeError('IndexedDB queue fairness timestamp differs from its next timestamp');
    }
    return { date, createdTs, expiryTs, startTs, endTs, nextTs };
}

function freezeVerifiedStoredResourceEntry(
    stored: StoredResourceEntry,
    timestamps: StoredResourceEntryTimestamps
): StoredResourceEntry {
    Object.freeze(stored.key);
    Object.freeze(stored.audit);
    Object.freeze(stored.dequeueAudit);
    verifiedTimestamps.set(Object.freeze(stored), timestamps);
    return stored;
}

function getVerifiedTimestamps<Value>(value: Value): StoredResourceEntryTimestamps | undefined {
    return typeof value === 'object' && value !== null ? verifiedTimestamps.get(value) : undefined;
}

/**
 * A completed row that never passed through release (e.g. a canonical entry admitted
 * already-COMPLETED) has no dequeueAudit.endTs. Defaulting it to 0 instead of null keeps the
 * row indexable by `by-status-end`: IndexedDB drops a compound-index record when any key
 * component is null, which would hide such rows from retention cleanup forever.
 */
function toExpectedEndEpochMs(
    status: EntityStatus,
    endTs: Temporal.Instant | undefined
): number | null {
    if (endTs !== undefined) {
        return Number(endTs.epochMilliseconds);
    }
    return COMPLETED_STATUSES.has(status) ? 0 : null;
}

function toOptionalEpochMs(instant: Temporal.Instant | undefined): number | undefined {
    return instant === undefined ? undefined : Number(instant.epochMilliseconds);
}

function toPlainTime(value: string | Temporal.PlainTime): Temporal.PlainTime {
    if (value instanceof Temporal.PlainTime) {
        return value;
    }
    if (typeof value !== 'string') {
        throw new TypeError('IndexedDB queue audit date must be a plain time');
    }
    return Temporal.PlainTime.from(value);
}

function toPlainDateTime(value: string | Temporal.PlainDateTime): Temporal.PlainDateTime {
    if (value instanceof Temporal.PlainDateTime) {
        return value;
    }
    if (typeof value !== 'string') {
        throw new TypeError('IndexedDB queue creation timestamp must be a plain date-time');
    }
    return Temporal.PlainDateTime.from(value);
}

function toInstant(value: string | Temporal.Instant): Temporal.Instant {
    if (value instanceof Temporal.Instant) {
        return value;
    }
    if (typeof value !== 'string') {
        throw new TypeError('IndexedDB queue timestamp must be an instant');
    }
    return Temporal.Instant.from(value);
}

function toOptionalInstant(
    value: string | Temporal.Instant | undefined
): Temporal.Instant | undefined {
    return value === undefined ? undefined : toInstant(value);
}

function decodeStoredResourceEntryFields<Value>(value: Value): StoredResourceEntry {
    const stored = requireDataRecord(value, 'IndexedDB queue row', ROW_FIELDS);
    const key = requireDataRecord(stored.key, 'IndexedDB queue key', KEY_FIELDS);
    const audit = requireDataRecord(stored.audit, 'IndexedDB queue audit', AUDIT_FIELDS);
    const dequeueAudit = requireDataRecord(
        stored.dequeueAudit,
        'IndexedDB queue dequeue audit',
        DEQUEUE_AUDIT_FIELDS
    );
    const canonical = {
        keyString: requireString(stored.keyString, 'IndexedDB queue key string'),
        revision: requireNonNegativeInteger(stored.revision, 'IndexedDB queue revision'),
        ...(stored.fairnessDueEpochMs === undefined
            ? {}
            : {
                fairnessDueEpochMs: requireSafeInteger(
                    stored.fairnessDueEpochMs,
                    'IndexedDB queue fairness timestamp'
                )
            }),
        key: {
            topicId: requireString(key.topicId, 'IndexedDB queue topic id'),
            resourceId: requireString(key.resourceId, 'IndexedDB queue resource id'),
            contextId: requireString(key.contextId, 'IndexedDB queue context id')
        },
        resource: requireString(stored.resource, 'IndexedDB queue resource'),
        typeId: requireString(stored.typeId, 'IndexedDB queue type id'),
        audit: toStoredAudit(audit),
        expiryEpochMs: requireSafeInteger(
            stored.expiryEpochMs,
            'IndexedDB queue expiry timestamp (ms)'
        ),
        status: requireEntityStatus(stored.status),
        dequeueAudit: toStoredDequeueAudit(dequeueAudit),
        endEpochMs: requireSafeIntegerOrNull(
            stored.endEpochMs,
            'IndexedDB queue end timestamp (ms)'
        )
    } satisfies StoredResourceEntry;
    if (canonical.keyString !== toKeyAsString(canonical.key)) {
        throw new TypeError('IndexedDB queue row key differs from its canonical key');
    }
    return canonical;
}

function toStoredAudit(audit: IndexedDbQueueDataRecord): StoredResourceEntry['audit'] {
    return {
        date: requireString(audit.date, 'IndexedDB queue audit date'),
        createdBy: requireString(audit.createdBy, 'IndexedDB queue creator'),
        createdTs: requireString(audit.createdTs, 'IndexedDB queue creation timestamp'),
        expiryTs: requireString(audit.expiryTs, 'IndexedDB queue expiry timestamp')
    };
}

function toStoredDequeueAudit(
    dequeueAudit: IndexedDbQueueDataRecord
): StoredResourceEntry['dequeueAudit'] {
    return {
        ...(dequeueAudit.startTs === undefined
            ? {}
            : { startTs: requireString(dequeueAudit.startTs, 'IndexedDB queue start timestamp') }),
        ...(dequeueAudit.endTs === undefined
            ? {}
            : { endTs: requireString(dequeueAudit.endTs, 'IndexedDB queue end timestamp') }),
        ...(dequeueAudit.nextTs === undefined
            ? {}
            : { nextTs: requireString(dequeueAudit.nextTs, 'IndexedDB queue next timestamp') }),
        attempts: requireNonNegativeInteger(dequeueAudit.attempts, 'IndexedDB queue attempt count')
    };
}

function requireDataRecord<Value>(
    value: Value,
    label: string,
    fields: DataRecordFields
): IndexedDbQueueDataRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be a record`);
    }
    const record = value as IndexedDbQueueDataRecord;
    const permitted = new Set([...fields.required, ...(fields.optional ?? [])]);
    const keys = Object.keys(record);
    if (
        fields.required.some((key) => !Object.hasOwn(record, key)) ||
        keys.some((key) => !permitted.has(key)) ||
        Reflect.ownKeys(record).length !== keys.length
    ) {
        throw new TypeError(`${label} fields are invalid`);
    }
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError(`${label} must contain only data fields`);
        }
    }
    return record;
}

function requireString(value: IndexedDbQueueDataValue, label: string): string {
    if (typeof value !== 'string') {
        throw new TypeError(`${label} must be a string`);
    }
    return value;
}

function requireSafeInteger(value: IndexedDbQueueDataValue, label: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new TypeError(`${label} must be a safe integer`);
    }
    return value;
}

function requireSafeIntegerOrNull(value: IndexedDbQueueDataValue, label: string): number | null {
    return value === null ? null : requireSafeInteger(value, label);
}

function requireNonNegativeInteger(value: IndexedDbQueueDataValue, label: string): number {
    const integer = requireSafeInteger(value, label);
    if (integer < 0 || Object.is(integer, -0)) {
        throw new TypeError(`${label} must be non-negative`);
    }
    return integer;
}

function requireEntityStatus(value: IndexedDbQueueDataValue): EntityStatus {
    for (const status of Object.values(EntityStatus)) {
        if (value === status) {
            return status;
        }
    }
    throw new TypeError('IndexedDB queue status is invalid');
}
