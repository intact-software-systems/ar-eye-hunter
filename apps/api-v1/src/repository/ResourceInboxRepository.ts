import {sql as defaultSql} from "./db.ts";
import {Sql, TransactionSql} from "postgres";
import {EntityStatus, type Key, type ResourceEntry,} from "@shared/queuebox/ResourceEntry.ts";

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
    start_ts: string | null;
    end_ts: string | null;
    next_ts: string | null;
    ri_attempts: bigint | null;
};

export class ResourceInboxRepository {
    static readonly MAX_ROWS_TO_RETURN = 50;

    constructor(private readonly sql: Sql = defaultSql as unknown as Sql) {
    }

    /**
     * Run repository operations inside a transaction.
     * Required for SELECT ... FOR UPDATE SKIP LOCKED to be meaningful.
     */
    async begin<T>(fn: (repo: ResourceInboxRepository) => Promise<T>): Promise<T> {
        const newVar = await this.sql.begin<T>(
            async (sql : TransactionSql) => {
                return await fn(new ResourceInboxRepository(sql as unknown as Sql));
            }
        );

        return newVar as T;
    }

    // ---------------------------------
    // Inserts / Reads
    // ---------------------------------

    async write(entry: ResourceEntry): Promise<ResourceEntry> {
        // ri_row_id uses DEFAULT nextval(...) so we don't supply it.
        const systemDate = toSystemDate(entry);

        const rows = await this.sql<ResourceInboxRow[]>`
            insert into resource_inbox (ri_resource_id,
                                        ri_topic_id,
                                        ri_resource,
                                        ri_type_id,
                                        ri_status,
                                        fk_ext_bank_id,
                                        system_date,
                                        created_by,
                                        created_ts,
                                        start_ts,
                                        end_ts,
                                        next_ts,
                                        ri_attempts)
            values (${entry.key.resourceId},
                    ${entry.key.topicId},
                    ${entry.resource},
                    ${entry.typeId},
                    ${entry.status},
                    ${entry.key.contextId},
                    ${systemDate},
                    ${entry.audit.createdBy},
                    ${toPgTimestamp(entry.audit.createdTs)},
                    ${entry.dequeueAudit.startTs ? toPgTimestamp(entry.dequeueAudit.startTs) : null},
                    ${entry.dequeueAudit.endTs ? toPgTimestamp(entry.dequeueAudit.endTs) : null},
                    ${entry.dequeueAudit.nextTs ? toPgTimestamp(entry.dequeueAudit.nextTs) : null},
                    ${entry.dequeueAudit.attempts ?? 0})
            returning *
        `;

        if (rows.length !== 1) throw new Error("Insert failed: expected exactly one row");
        return toDomain(rows[0]);
    }

    async findByKey(key: Key): Promise<ResourceEntry | null> {
        const rows = await this.sql<ResourceInboxRow[]>`
            select *
            from resource_inbox
            where ri_topic_id = ${key.topicId}
              and ri_resource_id = ${key.resourceId}
              and fk_ext_bank_id = ${key.contextId}
            limit 1
        `;

        return rows.length === 0 ? null : toDomain(rows[0]);
    }

    async findByTopicId(topicId: string): Promise<Map<string, ResourceEntry>> {
        const rows = await this.sql<ResourceInboxRow[]>`
            select *
            from resource_inbox
            where ri_topic_id = ${topicId}
            order by ri_row_id
            limit ${ResourceInboxRepository.MAX_ROWS_TO_RETURN}
        `;
        return rowsToMap(rows);
    }

    async findByTypeId(typeId: string): Promise<Map<string, ResourceEntry>> {
        const rows = await this.sql<ResourceInboxRow[]>`
            select *
            from resource_inbox
            where ri_type_id = ${typeId}
            order by ri_row_id
            limit ${ResourceInboxRepository.MAX_ROWS_TO_RETURN}
        `;
        return rowsToMap(rows);
    }

    // ---------------------------------
    // SKIP LOCKED selectors (must be in tx)
    // ---------------------------------

    async findEntriesSkipLocked(
        typeIds: ReadonlySet<string>,
        statusIds: ReadonlySet<EntityStatus>,
        maxToReserve: number,
    ): Promise<Map<string, ResourceEntry>> {
        if (typeIds.size === 0 || statusIds.size === 0) return new Map();

        const now = new Date();

        const rows = await this.sql<ResourceInboxRow[]>`
            select *
            from resource_inbox
            where ri_type_id in ${this.sql([...typeIds])}
              and ri_status in ${this.sql([...statusIds])}
              and (start_ts is null or next_ts < ${now})
            order by ri_row_id
                for update skip locked
            limit ${maxToReserve}
        `;

        return rowsToMap(rows);
    }

    async findTimedOutReservedEntriesSkipLocked(
        typeIds: ReadonlySet<string>,
        timeSinceStartMs: number,
        maxToReserve: number,
    ): Promise<Map<string, ResourceEntry>> {
        if (typeIds.size === 0) return new Map();

        const timedOutBefore = new Date(Date.now() - timeSinceStartMs);

        const rows = await this.sql<ResourceInboxRow[]>`
            select *
            from resource_inbox
            where ri_type_id in ${this.sql([...typeIds])}
              and ri_status = ${EntityStatus.RESERVED}
              and start_ts is not null
              and start_ts < ${timedOutBefore}
            order by ri_row_id
                for update skip locked
            limit ${maxToReserve}
        `;

        return rowsToMap(rows);
    }

    // ---------------------------------
    // Existence checks
    // ---------------------------------

    async isEntriesToLock(typeIds: ReadonlySet<string>, statusIds: ReadonlySet<EntityStatus>): Promise<boolean> {
        if (typeIds.size === 0 || statusIds.size === 0) return false;
        const now = new Date();

        const rows = await this.sql<{ one: number }[]>`
            select 1 as one
            from resource_inbox
            where ri_type_id in ${this.sql([...typeIds])}
              and ri_status in ${this.sql([...statusIds])}
              and (start_ts is null or next_ts < ${now})
            limit 1
        `;

        return rows.length > 0;
    }

    async isAnyWithStatuses(statuses: ReadonlySet<EntityStatus>): Promise<boolean> {
        if (statuses.size === 0) return false;

        const rows = await this.sql<{ one: number }[]>`
            select 1 as one
            from resource_inbox
            where ri_status in ${this.sql([...statuses])}
            limit 1
        `;

        return rows.length > 0;
    }

    async isTimeoutOnReservedEntries(typeIds: ReadonlySet<string>, timeSinceStartTs: Temporal.Duration): Promise<boolean> {
        if (typeIds.size === 0) return false;

        const now = new Date();
        const timeoutTs = new Date(now.getTime() - timeSinceStartTs.total('milliseconds'));


        const rows =
            await this.sql<{ one: number }[]>
                `
                    select 1 as one
                    from resource_inbox
                    where ri_type_id in ${this.sql([...typeIds])}
                      and ri_status in ${this.sql([EntityStatus.RESERVED])}
                      and start_ts is not null
                      and next_ts < ${timeoutTs}
                    limit 1
                `;

        return rows.length > 0;
    }

    // ---------------------------------
    // State transitions
    // ---------------------------------

    async startProcessingEntity(entry: ResourceEntry): Promise<ResourceEntry | null> {
        const serverStart = new Date();
        const attempts = (entry.dequeueAudit.attempts ?? 0) + 1;

        const rows = await this.sql<ResourceInboxRow[]>`
            update resource_inbox
            set ri_status   = ${EntityStatus.RESERVED},
                ri_attempts = ${attempts},
                start_ts    = ${serverStart},
                end_ts      = ${null},
                next_ts     = ${null}
            where ri_topic_id = ${entry.key.topicId}
              and ri_resource_id = ${entry.key.resourceId}
              and fk_ext_bank_id = ${entry.key.contextId}
            returning *
        `;

        return rows.length === 0 ? null : toDomain(rows[0]);
    }

    async updateResourceEntry(
        key: Key,
        newStatus: EntityStatus,
        timeUntilNextAttemptMs?: number | null,
    ): Promise<number> {
        const endTs = new Date();
        const nextTs = timeUntilNextAttemptMs != null ? new Date(Date.now() + timeUntilNextAttemptMs) : null;

        const rows = await this.sql<{ ri_row_id: bigint }[]>`
            update resource_inbox
            set ri_status = ${newStatus},
                end_ts    = ${endTs},
                next_ts   = ${nextTs}
            where ri_topic_id = ${key.topicId}
              and ri_resource_id = ${key.resourceId}
              and fk_ext_bank_id = ${key.contextId}
            returning ri_row_id
        `;

        return rows.length;
    }

    // ---------------------------------
    // Deletes
    // ---------------------------------

    async deleteByKey(key: Key): Promise<boolean> {
        const rows = await this.sql<{ ri_row_id: bigint }[]>`
            delete
            from resource_inbox
            where ri_topic_id = ${key.topicId}
              and ri_resource_id = ${key.resourceId}
              and fk_ext_bank_id = ${key.contextId}
            returning ri_row_id
        `;

        return rows.length === 1;
    }
}

// ---------------------------------
// Helpers
// ---------------------------------

function keyToString(k: Key): string {
    return `${k.contextId}::${k.topicId}::${k.resourceId}`;
}

function rowsToMap(rows: ResourceInboxRow[]): Map<string, ResourceEntry> {
    const m = new Map<string, ResourceEntry>();
    for (const r of rows) {
        const e = toDomain(r);
        m.set(keyToString(e.key), e);
    }
    return m;
}

function toDomain(r: ResourceInboxRow): ResourceEntry {
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
            date: Temporal.PlainTime.from(parseTemporalPlainDateTime(r.created_ts).toPlainTime().toString()),
            createdBy: r.created_by,
            createdTs: parseTemporalPlainDateTime(r.created_ts),
        },
        status: r.ri_status as EntityStatus,
        dequeueAudit: {
            startTs: r.start_ts ? Temporal.Instant.from(ensureIsoInstant(r.start_ts)) : undefined,
            endTs: r.end_ts ? Temporal.Instant.from(ensureIsoInstant(r.end_ts)) : undefined,
            nextTs: r.next_ts ? Temporal.Instant.from(ensureIsoInstant(r.next_ts)) : undefined,
            attempts,
        },
        db: {
            id: r.ri_row_id.toString(),
        },
    };
}

function toSystemDate(entry: ResourceEntry): string {
    // system_date is DATE; derive it from createdTs.
    // createdTs is Temporal.PlainDateTime (no zone) -> take its PlainDate.
    return entry.audit.createdTs.toPlainDate().toString();
}

function toPgTimestamp(t: Temporal.PlainDateTime | Temporal.Instant): string {
    // For timestamp(6) without timezone, sending ISO-like strings is fine.
    // - PlainDateTime: "YYYY-MM-DDTHH:mm:ss.sss"
    // - Instant: "YYYY-MM-DDTHH:mm:ss.sssZ" (Postgres parses this too)
    return t.toString();
}

function parseTemporalPlainDateTime(ts: string): Temporal.PlainDateTime {
    // Postgres may return "YYYY-MM-DD HH:mm:ss" or ISO-ish strings.
    // Normalize space to 'T' so Temporal.PlainDateTime can parse.
    const normalized = ts.includes("T") ? ts : ts.replace(" ", "T");
    return Temporal.PlainDateTime.from(normalized);
}

function ensureIsoInstant(ts: string): string {
    // Temporal.Instant requires an offset (e.g. Z). If Postgres returned a naive timestamp,
    // assume UTC by appending 'Z'.
    if (ts.endsWith("Z") || ts.includes("+") || ts.includes("-")) return ts;
    const normalized = ts.includes("T") ? ts : ts.replace(" ", "T");
    return `${normalized}Z`;
}
