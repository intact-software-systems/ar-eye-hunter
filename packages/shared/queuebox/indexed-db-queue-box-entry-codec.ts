import { Temporal } from '@js-temporal/polyfill';

import {
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
    status: EntityStatus;
    dequeueAudit: Readonly<{
        startTs?: string;
        endTs?: string;
        nextTs?: string;
        attempts: number;
    }>;
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

export function encodeStoredResourceEntry(
    entry: ResourceEntry,
    revision: number
): StoredResourceEntry {
    const stored: StoredResourceEntry = {
        keyString: toKeyAsString(entry.key),
        revision,
        fairnessDueEpochMs: entry.dequeueAudit.nextTs
            ? Number(entry.dequeueAudit.nextTs.epochMilliseconds)
            : undefined,
        key: { ...entry.key },
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
    validateStoredResourceEntry(stored);
    return stored;
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
    const stored = requireDataRecord(value, 'IndexedDB queue row', {
        required: ['keyString', 'revision', 'key', 'resource', 'typeId', 'audit', 'status', 'dequeueAudit'],
        optional: ['fairnessDueEpochMs']
    });
    const key = requireDataRecord(stored.key, 'IndexedDB queue key', {
        required: ['topicId', 'resourceId', 'contextId']
    });
    const audit = requireDataRecord(stored.audit, 'IndexedDB queue audit', {
        required: ['date', 'createdBy', 'createdTs', 'expiryTs']
    });
    const dequeueAudit = requireDataRecord(stored.dequeueAudit, 'IndexedDB queue dequeue audit', {
        required: ['attempts'],
        optional: ['startTs', 'endTs', 'nextTs']
    });
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
        audit: {
            date: requireString(audit.date, 'IndexedDB queue audit date'),
            createdBy: requireString(audit.createdBy, 'IndexedDB queue creator'),
            createdTs: requireString(audit.createdTs, 'IndexedDB queue creation timestamp'),
            expiryTs: requireString(audit.expiryTs, 'IndexedDB queue expiry timestamp')
        },
        status: requireEntityStatus(stored.status),
        dequeueAudit: {
            ...(dequeueAudit.startTs === undefined
                ? {}
                : { startTs: requireString(dequeueAudit.startTs, 'IndexedDB queue start timestamp') }),
            ...(dequeueAudit.endTs === undefined
                ? {}
                : { endTs: requireString(dequeueAudit.endTs, 'IndexedDB queue end timestamp') }),
            ...(dequeueAudit.nextTs === undefined
                ? {}
                : { nextTs: requireString(dequeueAudit.nextTs, 'IndexedDB queue next timestamp') }),
            attempts: requireNonNegativeInteger(
                dequeueAudit.attempts,
                'IndexedDB queue attempt count'
            )
        }
    } satisfies StoredResourceEntry;
    validateStoredResourceEntry(canonical);
    return canonical;
}

function validateStoredResourceEntry(stored: StoredResourceEntry): void {
    if (stored.keyString !== toKeyAsString(stored.key)) {
        throw new TypeError('IndexedDB queue row key differs from its canonical key');
    }
    toPlainTime(stored.audit.date);
    toPlainDateTime(stored.audit.createdTs);
    toInstant(stored.audit.expiryTs);
    toOptionalInstant(stored.dequeueAudit.startTs);
    toOptionalInstant(stored.dequeueAudit.endTs);
    const next = toOptionalInstant(stored.dequeueAudit.nextTs);
    const expectedFairness = next === undefined ? undefined : Number(next.epochMilliseconds);
    if (stored.fairnessDueEpochMs !== expectedFairness) {
        throw new TypeError('IndexedDB queue fairness timestamp differs from its next timestamp');
    }
}

function toPlainTime(value: string | Temporal.PlainTime): Temporal.PlainTime {
    if (typeof value !== 'string' && !(value instanceof Temporal.PlainTime)) {
        throw new TypeError('IndexedDB queue audit date must be a plain time');
    }
    return Temporal.PlainTime.from(value);
}

function toPlainDateTime(value: string | Temporal.PlainDateTime): Temporal.PlainDateTime {
    if (typeof value !== 'string' && !(value instanceof Temporal.PlainDateTime)) {
        throw new TypeError('IndexedDB queue creation timestamp must be a plain date-time');
    }
    return Temporal.PlainDateTime.from(value);
}

function toInstant(value: string | Temporal.Instant): Temporal.Instant {
    if (typeof value !== 'string' && !(value instanceof Temporal.Instant)) {
        throw new TypeError('IndexedDB queue timestamp must be an instant');
    }
    return Temporal.Instant.from(value);
}

function toOptionalInstant(
    value: string | Temporal.Instant | undefined
): Temporal.Instant | undefined {
    return value === undefined ? undefined : toInstant(value);
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
