import { Temporal } from '@js-temporal/polyfill';
import {
    EntityStatus,
    Key,
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

export type IndexedDbQueueExpectedState =
    | Readonly<{ kind: 'missing'; }>
    | Readonly<{ kind: 'revision'; revision: number; }>
    | Readonly<{ kind: 'legacy-row'; stored: StoredResourceEntry; }>;

export type ComputedIndexedDbQueueMutation =
    | Readonly<{
        kind: 'put';
        keyString: ResourceEntryKeyString;
        expected: IndexedDbQueueExpectedState;
        value: StoredResourceEntry;
    }>
    | Readonly<{
        kind: 'delete';
        keyString: ResourceEntryKeyString;
        expected: IndexedDbQueueExpectedState;
    }>
    | Readonly<{
        kind: 'delete-unconditionally';
        keyString: ResourceEntryKeyString;
    }>;

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

export function decodeStoredResourceEntryValue(value: unknown): StoredResourceEntry {
    const stored = requireDataRecord(
        value,
        'IndexedDB queue row',
        ['keyString', 'key', 'resource', 'typeId', 'audit', 'status', 'dequeueAudit'],
        ['revision', 'fairnessDueEpochMs']
    );
    const key = requireDataRecord(
        stored.key,
        'IndexedDB queue key',
        ['topicId', 'resourceId', 'contextId']
    );
    const audit = requireDataRecord(
        stored.audit,
        'IndexedDB queue audit',
        ['date', 'createdBy', 'createdTs', 'expiryTs']
    );
    const dequeueAudit = requireDataRecord(
        stored.dequeueAudit,
        'IndexedDB queue dequeue audit',
        ['attempts'],
        ['startTs', 'endTs', 'nextTs']
    );
    const canonical = {
        keyString: requireString(stored.keyString, 'IndexedDB queue key string'),
        ...(stored.revision === undefined
            ? {}
            : { revision: requireNonNegativeInteger(stored.revision, 'IndexedDB queue revision') }),
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

export function hasSameStoredResourceEntry(
    left: StoredResourceEntry,
    right: StoredResourceEntry
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export function storedResourceEntryRevision(stored: StoredResourceEntry): number {
    return stored.revision ?? 0;
}

export function computeIndexedDbQueuePut(
    stored: StoredResourceEntry | undefined,
    entry: ResourceEntry
): Extract<ComputedIndexedDbQueueMutation, { kind: 'put'; }> {
    const expected = toIndexedDbQueueExpectedState(stored);
    const nextRevision = stored ? storedResourceEntryRevision(stored) + 1 : 0;
    return {
        kind: 'put',
        keyString: toKeyAsString(entry.key),
        expected,
        value: encodeStoredResourceEntry(entry, nextRevision)
    };
}

export function computeIndexedDbQueueDelete(
    stored: StoredResourceEntry
): Extract<ComputedIndexedDbQueueMutation, { kind: 'delete'; }> {
    return {
        kind: 'delete',
        keyString: stored.keyString,
        expected: toIndexedDbQueueExpectedState(stored)
    };
}

export function computeIndexedDbQueueUnconditionalDelete(
    keyString: ResourceEntryKeyString
): Extract<ComputedIndexedDbQueueMutation, { kind: 'delete-unconditionally'; }> {
    return { kind: 'delete-unconditionally', keyString };
}

export function validateComputedIndexedDbQueueMutations(
    mutations: readonly ComputedIndexedDbQueueMutation[]
): void {
    for (const mutation of mutations) {
        requireString(mutation.keyString, 'IndexedDB queue mutation key');
        if (mutation.kind === 'delete-unconditionally') {
            continue;
        }
        validateIndexedDbQueueExpectedState(mutation.expected);
        if (mutation.kind === 'delete') {
            if (mutation.expected.kind === 'missing') {
                throw new TypeError('IndexedDB queue delete cannot expect a missing row');
            }
            continue;
        }
        decodeStoredResourceEntryValue(mutation.value);
        if (mutation.value.keyString !== mutation.keyString) {
            throw new TypeError('IndexedDB queue mutation key differs from its stored value');
        }
        const expectedRevision = mutation.expected.kind === 'missing'
            ? 0
            : mutation.expected.kind === 'revision'
            ? mutation.expected.revision + 1
            : 1;
        if (mutation.value.revision !== expectedRevision) {
            throw new TypeError('IndexedDB queue mutation revision is not the next revision');
        }
    }
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
    return Temporal.Instant.compare(now, Temporal.Instant.from(stored.audit.expiryTs)) >= 0;
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
    if (value === undefined) {
        return undefined;
    }

    return toInstant(value);
}

function toIndexedDbQueueExpectedState(
    stored: StoredResourceEntry | undefined
): IndexedDbQueueExpectedState {
    if (!stored) {
        return { kind: 'missing' };
    }
    const canonical = decodeStoredResourceEntryValue(stored);
    return canonical.revision === undefined
        ? { kind: 'legacy-row', stored: canonical }
        : { kind: 'revision', revision: canonical.revision };
}

function validateIndexedDbQueueExpectedState(expected: IndexedDbQueueExpectedState): void {
    switch (expected.kind) {
        case 'missing':
            return;
        case 'revision':
            requireNonNegativeInteger(expected.revision, 'IndexedDB queue expected revision');
            return;
        case 'legacy-row':
            decodeStoredResourceEntryValue(expected.stored);
            if (expected.stored.revision !== undefined) {
                throw new TypeError('IndexedDB queue legacy expectation contains a revision');
            }
    }
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

function requireDataRecord(
    value: unknown,
    label: string,
    required: readonly string[],
    optional: readonly string[] = []
): Readonly<Record<string, unknown>> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be a record`);
    }
    const record = value as Readonly<Record<string, unknown>>;
    const permitted = new Set([...required, ...optional]);
    const keys = Object.keys(record);
    if (
        required.some((key) => !Object.prototype.hasOwnProperty.call(record, key)) ||
        keys.some((key) => !permitted.has(key)) ||
        Reflect.ownKeys(record).length !== keys.length
    ) {
        throw new TypeError(`${label} fields are invalid`);
    }
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            throw new TypeError(`${label} must contain only data fields`);
        }
    }
    return record;
}

function requireString(value: unknown, label: string): string {
    if (typeof value !== 'string') {
        throw new TypeError(`${label} must be a string`);
    }
    return value;
}

function requireSafeInteger(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new TypeError(`${label} must be a safe integer`);
    }
    return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
    const integer = requireSafeInteger(value, label);
    if (integer < 0 || Object.is(integer, -0)) {
        throw new TypeError(`${label} must be non-negative`);
    }
    return integer;
}

function requireEntityStatus(value: unknown): EntityStatus {
    for (const status of Object.values(EntityStatus)) {
        if (value === status) {
            return status;
        }
    }
    throw new TypeError('IndexedDB queue status is invalid');
}
