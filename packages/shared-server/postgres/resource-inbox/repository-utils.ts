import { EntityStatus, Key, NEVER_EXPIRE_TS, ResourceEntry, } from '@shared/queuebox/ResourceEntry.ts';
import { Temporal } from '@js-temporal/polyfill';

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
export type ResourceInboxRow = {
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
};

export type ResourceInboxResultsRow = {
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
};

export function keyToString(k: Key): string {
    return `${k.contextId}::${k.topicId}::${k.resourceId}`;
}

export function rowsToMap(
    rows: ResourceInboxRow[],
): Map<string, ResourceEntry> {
    const m = new Map<string, ResourceEntry>();
    for (const r of rows) {
        const e = toDomain(r);
        m.set(keyToString(e.key), e);
    }
    return m;
}

export function toDomain(r: ResourceInboxRow): ResourceEntry {
    // created_ts/start_ts/end_ts/next_ts are timestamps without TZ; keep as Instant-ish by assuming UTC.
    // If you prefer local time, adjust parsing here.
    const attempts = r.ri_attempts == null ? 0 : Number(r.ri_attempts);

    return {
        key: {
            topicId: r.ri_topic_id,
            resourceId: r.ri_resource_id,
            contextId: r.fk_ext_bank_id,
        },
        resource: r.ri_resource,
        typeId: r.ri_type_id,
        audit: {
            // date is not stored separately in the table; keep it derived from created_ts
            date: Temporal.PlainTime.from(
                parseTemporalPlainDateTime(r.created_ts)
                    .toPlainTime()
                    .toString(),
            ),
            createdBy: r.created_by,
            createdTs: parseTemporalPlainDateTime(r.created_ts),
            expiryTs: r.expire_ts
                ? toInstant(r.expire_ts)
                : NEVER_EXPIRE_TS,
        },
        status: r.ri_status as EntityStatus,
        dequeueAudit: {
            startTs: r.start_ts ? toInstant(r.start_ts) : undefined,
            endTs: r.end_ts ? toInstant(r.end_ts) : undefined,
            nextTs: r.next_ts ? toInstant(r.next_ts) : undefined,
            attempts,
        },
        db: {
            id: r.ri_row_id.toString(),
        },
    };
}

export function toResultsDomain(r: ResourceInboxResultsRow): ResourceEntry {
    return toDomain({
        ri_row_id: r.ris_row_id,
        ri_resource_id: r.ris_resource_id,
        ri_topic_id: r.ris_topic_id,
        ri_resource: r.ris_resource,
        ri_type_id: r.ris_type_id,
        ri_status: r.ris_status,
        fk_ext_bank_id: r.fk_ext_bank_id,
        system_date: r.system_date,
        created_by: r.created_by,
        created_ts: r.created_ts,
        expire_ts: r.expire_ts,
        start_ts: null,
        end_ts: null,
        next_ts: null,
        ri_attempts: null,
    });
}

export function toSystemDate(entry: ResourceEntry): string {
    // system_date is DATE; derive it from createdTs.
    // createdTs is Temporal.PlainDateTime (no zone) -> take its PlainDate.
    return entry.audit.createdTs.toPlainDate().toString();
}

export function toPgTimestamp(
    t: Temporal.PlainDateTime | Temporal.Instant,
): string {
    // For timestamp(6) without timezone, sending ISO-like strings is fine.
    // - PlainDateTime: "YYYY-MM-DDTHH:mm:ss.sss"
    // - Instant: "YYYY-MM-DDTHH:mm:ss.sssZ" (Postgres parses this too)
    return t.toString();
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
            millisecond: ts.getMilliseconds(),
        });
    }
    return Temporal.PlainDateTime.from(ts.replace(' ', 'T'));
}

export function toInstant(ts: string | Date): Temporal.Instant {
    if (ts instanceof Date) {
        return parseTemporalPlainDateTime(ts).toZonedDateTime('UTC').toInstant();
    }
    const normalized = ts.replace(' ', 'T');
    return Temporal.Instant.from(/[zZ]$|[+-]\d{2}(?::?\d{2})?$/u.test(normalized)
        ? normalized
        : `${normalized}Z`);
}
