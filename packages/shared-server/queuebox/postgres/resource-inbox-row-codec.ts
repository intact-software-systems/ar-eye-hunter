import { Temporal } from '@js-temporal/polyfill';
import { EntityStatus, Key, NEVER_EXPIRE_TS, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

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

export class ResourceInboxRowCorruptionError extends Error {
    readonly code = 'resource-inbox-row-corruption';

    constructor(message: string) {
        super(message);
        this.name = 'ResourceInboxRowCorruptionError';
    }
}

export function keyToString(k: Key): string {
    return `${k.contextId}::${k.topicId}::${k.resourceId}`;
}

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

export function rowsToMap(
    rows: ResourceInboxRow[]
): Map<string, ResourceEntry> {
    const m = new Map<string, ResourceEntry>();
    for (const r of rows) {
        const e = toDomain(r);
        m.set(keyToString(e.key), e);
    }
    return m;
}

export function toDomain(r: ResourceInboxRow): ResourceEntry {
    const status = decodeEntityStatus(r.ri_status);
    const attempts = decodeResourceInboxAttempts(r.ri_attempts);

    return {
        key: {
            topicId: r.ri_topic_id,
            resourceId: r.ri_resource_id,
            contextId: r.fk_ext_bank_id
        },
        resource: r.ri_resource,
        typeId: r.ri_type_id,
        audit: {
            // date is not stored separately in the table; keep it derived from created_ts
            date: Temporal.PlainTime.from(
                parseTemporalPlainDateTime(r.created_ts)
                    .toPlainTime()
                    .toString()
            ),
            createdBy: r.created_by,
            createdTs: parseTemporalPlainDateTime(r.created_ts),
            expiryTs: r.expire_ts
                ? toInstant(r.expire_ts)
                : NEVER_EXPIRE_TS
        },
        status,
        dequeueAudit: {
            startTs: r.start_ts ? toInstant(r.start_ts) : undefined,
            endTs: r.end_ts ? toInstant(r.end_ts) : undefined,
            nextTs: r.next_ts ? toInstant(r.next_ts) : undefined,
            attempts
        },
        db: {
            id: r.ri_row_id.toString()
        }
    };
}

export function toResultsDomain(r: ResourceInboxResultsRow): ResourceEntry {
    return {
        key: {
            topicId: r.ris_topic_id,
            resourceId: r.ris_resource_id,
            contextId: r.fk_ext_bank_id
        },
        resource: r.ris_resource,
        typeId: r.ris_type_id,
        audit: {
            date: parseTemporalPlainDateTime(r.created_ts).toPlainTime(),
            createdBy: r.created_by,
            createdTs: parseTemporalPlainDateTime(r.created_ts),
            expiryTs: toInstant(r.expire_ts)
        },
        status: decodeEntityStatus(r.ris_status),
        dequeueAudit: {
            attempts: 0
        },
        db: {
            id: r.ris_row_id.toString()
        }
    };
}

export function toSystemDate(entry: ResourceEntry): string {
    // system_date is DATE; derive it from createdTs.
    // createdTs is Temporal.PlainDateTime (no zone) -> take its PlainDate.
    return entry.audit.createdTs.toPlainDate().toString();
}

export function toPgTimestamp(
    t: Temporal.PlainDateTime | Temporal.Instant
): string {
    // postgres.js serializes a zone-less string as process-local time. The
    // domain PlainDateTime is a UTC wall clock, so make that zone explicit.
    return 'epochMilliseconds' in t ? t.toString() : `${t.toString()}Z`;
}

export function parseTemporalPlainDateTime(ts: string | Date): Temporal.PlainDateTime {
    if (ts instanceof Date) {
        return Temporal.PlainDateTime.from({
            year: ts.getFullYear(),
            month: ts.getMonth() + 1,
            day: ts.getDate(),
            hour: ts.getHours(),
            minute: ts.getMinutes(),
            second: ts.getSeconds(),
            millisecond: ts.getMilliseconds()
        });
    }
    return Temporal.PlainDateTime.from(ts.replace(' ', 'T'));
}

export function toInstant(ts: string | Date): Temporal.Instant {
    if (ts instanceof Date) {
        return parseTemporalPlainDateTime(ts).toZonedDateTime('UTC').toInstant();
    }
    const normalized = ts.replace(' ', 'T');
    return Temporal.Instant.from(
        /[zZ]$|[+-]\d{2}(?::?\d{2})?$/u.test(normalized)
            ? normalized
            : `${normalized}Z`
    );
}

const RESOURCE_INBOX_STATUSES = new Set<string>(Object.values(EntityStatus));

export function isValidResourceInboxLifecycle(row: ResourceInboxRow): boolean {
    if (row.ri_attempts === null) {
        return false;
    }

    const attempts = Number(row.ri_attempts);
    if (
        !RESOURCE_INBOX_STATUSES.has(row.ri_status) ||
        !Number.isSafeInteger(attempts) ||
        attempts < 0
    ) {
        return false;
    }

    let createdTs: Temporal.PlainDateTime;
    let expiryTs: Temporal.PlainDateTime;
    let startTs: Temporal.PlainDateTime | null;
    let endTs: Temporal.PlainDateTime | null;
    let nextTs: Temporal.PlainDateTime | null;
    try {
        createdTs = parsePostgresTimestamp6(row.created_ts);
        expiryTs = parsePostgresTimestamp6(row.expire_ts);
        startTs = row.start_ts ? parsePostgresTimestamp6(row.start_ts) : null;
        endTs = row.end_ts ? parsePostgresTimestamp6(row.end_ts) : null;
        nextTs = row.next_ts ? parsePostgresTimestamp6(row.next_ts) : null;
    }
    catch {
        return false;
    }

    if (
        Temporal.PlainDateTime.compare(createdTs, expiryTs) >= 0 ||
        (startTs && Temporal.PlainDateTime.compare(startTs, createdTs) < 0) ||
        (endTs && (!startTs || Temporal.PlainDateTime.compare(endTs, startTs) < 0)) ||
        (nextTs && endTs && Temporal.PlainDateTime.compare(nextTs, endTs) < 0) ||
        (nextTs && !endTs && Temporal.PlainDateTime.compare(nextTs, createdTs) < 0)
    ) {
        return false;
    }

    switch (row.ri_status) {
        case EntityStatus.NEW:
            return attempts === 0 && !startTs && !endTs && !nextTs;
        case EntityStatus.RETRY:
            return attempts === 0
                ? !startTs && !endTs && nextTs !== null
                : startTs !== null && endTs !== null && nextTs !== null;
        case EntityStatus.RESERVED:
            return attempts > 0 && startTs !== null && !endTs && !nextTs;
        case EntityStatus.FAILED:
            return attempts > 0 && startTs !== null && endTs !== null;
        case EntityStatus.COMPLETED:
        case EntityStatus.ABORTED:
        case EntityStatus.NON_RETRYABLE:
        case EntityStatus.PARTITIONED:
        case EntityStatus.MERGED:
            return attempts > 0 && startTs !== null && endTs !== null && !nextTs;
        default:
            return false;
    }
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
