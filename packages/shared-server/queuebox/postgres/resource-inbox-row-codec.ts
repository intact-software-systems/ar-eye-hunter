import { Temporal } from '@js-temporal/polyfill';

import {
    EntityStatus,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';

/**
 * Repository for table `resource_inbox`.
 *
 * Mapping between domain and DB columns:
 * - key.topicId     <-> ri_topic_id
 * - key.resourceId  <-> ri_resource_id
 * - key.contextId   <-> fk_ext_bank_id
 * - typeId          <-> ri_type_id
 * - resource        <-> ri_resource
 * - status          <-> ri_status
 * - audit.createdBy <-> created_by
 * - audit.createdTs <-> created_ts
 * - audit.expiryTs  <-> expire_ts
 * - dequeueAudit.startTs/endTs/nextTs <-> start_ts/end_ts/next_ts
 * - dequeueAudit.attempts            <-> ri_attempts
 */
export interface ResourceInboxStatusAndAttempts {
    readonly status: ResourceEntry['status'];
    readonly attempts: ResourceEntry['dequeueAudit']['attempts'];
}

export interface ResourceInboxRow {
    ri_row_id: bigint;
    ri_resource_id: string;
    ri_topic_id: string;
    ri_resource: string;
    ri_type_id: string;
    ri_status: string;
    fk_ext_bank_id: string;
    system_date: string; // DATE
    created_by: string;
    created_ts: string; // timestamp without time zone
    expire_ts: string; // timestamp without time zone
    start_ts: string | null;
    end_ts: string | null;
    next_ts: string | null;
    ri_attempts: bigint | null;
}

export interface ResourceInboxResultsRow {
    ris_row_id: bigint;
    ris_resource_id: string;
    ris_topic_id: string;
    ris_resource: string;
    ris_type_id: string;
    ris_status: string;
    fk_ext_bank_id: string;
    system_date: string;
    created_by: string;
    created_ts: string;
    expire_ts: string;
}

const RESOURCE_INBOX_STATUSES = new Set<string>(Object.values(EntityStatus));

export class ResourceInboxRowCorruptionError extends Error {
    readonly code = 'resource-inbox-row-corruption';

    constructor(message: string) {
        super(message);
        this.name = 'ResourceInboxRowCorruptionError';
    }
}

export function rowsToMap(
    rows: ResourceInboxRow[]
): Map<string, ResourceEntry> {
    const entries = new Map<string, ResourceEntry>();
    for (const row of rows) {
        const entry = toDomain(row);
        entries.set(row.ri_row_id.toString(), entry);
    }
    return entries;
}

export function toResourceInboxStatusAndAttempts(
    row: Pick<ResourceInboxRow, 'ri_status' | 'ri_attempts'>
): ResourceInboxStatusAndAttempts {
    return { status: decodeEntityStatus(row.ri_status), attempts: decodeResourceInboxAttempts(row.ri_attempts) };
}

export function toDomain(row: ResourceInboxRow): ResourceEntry {
    const { status, attempts } = toResourceInboxStatusAndAttempts(row);
    if (!hasValidResourceInboxFullRowLifecycle(row)) {
        throw new ResourceInboxRowCorruptionError('Resource inbox row has an invalid lifecycle');
    }
    const createdTs = parseTemporalPlainDateTime(row.created_ts);

    return {
        key: {
            topicId: row.ri_topic_id,
            resourceId: row.ri_resource_id,
            contextId: row.fk_ext_bank_id
        },
        resource: row.ri_resource,
        typeId: row.ri_type_id,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy: row.created_by,
            createdTs,
            expiryTs: toInstant(row.expire_ts)
        },
        status,
        dequeueAudit: {
            startTs: row.start_ts ? toInstant(row.start_ts) : undefined,
            endTs: row.end_ts ? toInstant(row.end_ts) : undefined,
            nextTs: row.next_ts ? toInstant(row.next_ts) : undefined,
            attempts
        },
        db: {
            id: row.ri_row_id.toString()
        }
    };
}

export function toResultsDomain(row: ResourceInboxResultsRow): ResourceEntry {
    return {
        key: {
            topicId: row.ris_topic_id,
            resourceId: row.ris_resource_id,
            contextId: row.fk_ext_bank_id
        },
        resource: row.ris_resource,
        typeId: row.ris_type_id,
        audit: {
            date: parseTemporalPlainDateTime(row.created_ts).toPlainTime(),
            createdBy: row.created_by,
            createdTs: parseTemporalPlainDateTime(row.created_ts),
            expiryTs: toInstant(row.expire_ts)
        },
        status: decodeEntityStatus(row.ris_status),
        dequeueAudit: {
            attempts: 0
        },
        db: {
            id: row.ris_row_id.toString()
        }
    };
}

export function toSystemDate(entry: ResourceEntry): string {
    // system_date is DATE; derive it from createdTs.
    // createdTs is Temporal.PlainDateTime (no zone) -> take its PlainDate.
    return entry.audit.createdTs.toPlainDate().toString();
}

export function toPgTimestamp(
    timestamp: Temporal.PlainDateTime | Temporal.Instant
): string {
    // postgres.js serializes a zone-less string as process-local time. The
    // domain PlainDateTime is a UTC wall clock, so make that zone explicit.
    return 'epochMilliseconds' in timestamp ? timestamp.toString() : `${timestamp.toString()}Z`;
}

export function parseTemporalPlainDateTime(timestamp: string | Date): Temporal.PlainDateTime {
    if (timestamp instanceof Date) {
        return Temporal.PlainDateTime.from({
            year: timestamp.getFullYear(),
            month: timestamp.getMonth() + 1,
            day: timestamp.getDate(),
            hour: timestamp.getHours(),
            minute: timestamp.getMinutes(),
            second: timestamp.getSeconds(),
            millisecond: timestamp.getMilliseconds()
        });
    }
    return Temporal.PlainDateTime.from(timestamp.replace(' ', 'T'));
}

export function toInstant(timestamp: string | Date): Temporal.Instant {
    if (timestamp instanceof Date) {
        return parseTemporalPlainDateTime(timestamp).toZonedDateTime('UTC').toInstant();
    }
    const normalized = timestamp.replace(' ', 'T');
    return Temporal.Instant.from(
        /[zZ]$|[+-]\d{2}(?::?\d{2})?$/u.test(normalized)
            ? normalized
            : `${normalized}Z`
    );
}

/** Immutable replay requires a processing lifecycle; retained AL facts also occupy full storage rows. */
export function isValidResourceInboxLifecycle(row: ResourceInboxRow): boolean {
    return hasValidResourceInboxFields(row) && hasValidResourceInboxProcessingState(row);
}

export function hasMatchingImmutableResourceInboxContent(
    row: ResourceInboxRow,
    entry: ResourceEntry
): boolean {
    try {
        return row.ri_topic_id === entry.key.topicId &&
            row.ri_resource_id === entry.key.resourceId &&
            row.fk_ext_bank_id === entry.key.contextId &&
            row.ri_type_id === entry.typeId &&
            row.ri_resource === entry.resource &&
            row.created_by === entry.audit.createdBy &&
            isSamePostgresTimestamp6(row.created_ts, entry.audit.createdTs) &&
            isSamePostgresTimestamp6(row.expire_ts, entry.audit.expiryTs);
    }
    catch {
        return false;
    }
}

function hasValidResourceInboxFullRowLifecycle(row: ResourceInboxRow): boolean {
    if (!hasValidResourceInboxFields(row)) {
        return false;
    }
    switch (row.ri_status) {
        case EntityStatus.NEW:
            return Number(row.ri_attempts) === 0 && !row.start_ts && !row.end_ts;
        case EntityStatus.COMPLETED:
            return Number(row.ri_attempts) === 0
                ? Boolean(row.start_ts) === Boolean(row.end_ts)
                : row.start_ts !== null && row.end_ts !== null;
        default:
            return hasValidResourceInboxProcessingState(row);
    }
}

function hasValidResourceInboxFields(row: ResourceInboxRow): boolean {
    const attempts = row.ri_attempts === null ? NaN : Number(row.ri_attempts);
    if (
        !RESOURCE_INBOX_STATUSES.has(row.ri_status) ||
        !Number.isSafeInteger(attempts) ||
        attempts < 0
    ) {
        return false;
    }

    try {
        parsePostgresTimestamp6(row.created_ts);
        parsePostgresTimestamp6(row.expire_ts);
        for (const timestamp of [row.start_ts, row.end_ts, row.next_ts]) {
            if (timestamp !== null) {
                parsePostgresTimestamp6(timestamp);
            }
        }
    }
    catch {
        return false;
    }

    return row.end_ts === null || row.start_ts !== null;
}

function hasValidResourceInboxProcessingState(row: ResourceInboxRow): boolean {
    const attempts = Number(row.ri_attempts);
    const hasStart = row.start_ts !== null;
    const hasEnd = row.end_ts !== null;
    const hasNext = row.next_ts !== null;

    switch (row.ri_status) {
        case EntityStatus.NEW:
            return attempts === 0 && !hasStart && !hasEnd && !hasNext;
        case EntityStatus.RETRY:
            return attempts === 0
                ? hasStart === hasEnd && hasNext
                : hasStart && hasEnd && hasNext;
        case EntityStatus.RESERVED:
            return attempts > 0 && hasStart && !hasEnd && !hasNext;
        case EntityStatus.FAILED:
            return attempts > 0 && hasStart && hasEnd;
        case EntityStatus.COMPLETED:
        case EntityStatus.ABORTED:
        case EntityStatus.NON_RETRYABLE:
        case EntityStatus.PARTITIONED:
        case EntityStatus.MERGED:
            return attempts > 0 && hasStart && hasEnd && !hasNext;
        default:
            return false;
    }
}

function isSamePostgresTimestamp6(
    persisted: string,
    candidate: Temporal.PlainDateTime | Temporal.Instant
): boolean {
    return Temporal.PlainDateTime.compare(
        parsePostgresTimestamp6(persisted),
        toPostgresTimestamp6(candidate)
    ) === 0;
}

function parsePostgresTimestamp6(value: string): Temporal.PlainDateTime {
    if (/[zZ]$/u.test(value) || /[+-]\d{2}(?::?\d{2})?$/u.test(value)) {
        throw new RangeError('PostgreSQL timestamp without time zone contains a zone');
    }

    const timestamp = Temporal.PlainDateTime.from(value.replace(' ', 'T'));
    if (timestamp.nanosecond !== 0) {
        throw new RangeError('PostgreSQL timestamp(6) exceeds microsecond precision');
    }
    return timestamp;
}

function toPostgresTimestamp6(
    value: Temporal.PlainDateTime | Temporal.Instant
): Temporal.PlainDateTime {
    const timestamp = value instanceof Temporal.Instant
        ? value.toZonedDateTimeISO('UTC').toPlainDateTime()
        : value;

    return timestamp.round({
        smallestUnit: 'microsecond',
        roundingMode: 'halfEven'
    });
}

function decodeEntityStatus(value: string): EntityStatus {
    switch (value) {
        case EntityStatus.NEW:
        case EntityStatus.RETRY:
        case EntityStatus.RESERVED:
        case EntityStatus.FAILED:
        case EntityStatus.COMPLETED:
        case EntityStatus.ABORTED:
        case EntityStatus.NON_RETRYABLE:
        case EntityStatus.PARTITIONED:
        case EntityStatus.MERGED:
            return value;
        default:
            throw new ResourceInboxRowCorruptionError(
                `Resource inbox row has unknown status: ${value}`
            );
    }
}

function decodeResourceInboxAttempts(value: bigint | null): number {
    if (value === null) {
        throw new ResourceInboxRowCorruptionError(
            'Resource inbox row is missing its attempt count'
        );
    }
    const attempts = Number(value);
    if (!Number.isSafeInteger(attempts) || attempts < 0) {
        throw new ResourceInboxRowCorruptionError(
            'Resource inbox row has an invalid attempt count'
        );
    }
    return attempts;
}
