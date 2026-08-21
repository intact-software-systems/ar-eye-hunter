import type { Key } from '@shared/queuebox/ResourceEntry.ts';
import type {
    AdminSupportQueueEntryRead,
    AdminSupportReader
} from '../../rallar-system/admin-support/AdminSupportService.ts';
import type { PSqlSql } from '../PostgresSqlClient.ts';

type InboxRow = Readonly<{
    ri_resource_id: string;
    ri_topic_id: string;
    ri_resource: string;
    ri_type_id: string;
    ri_status: string;
    fk_ext_bank_id: string;
    created_ts: Date | string | null;
    start_ts: Date | string | null;
    end_ts: Date | string | null;
    next_ts: Date | string | null;
    expire_ts: Date | string | null;
    ri_attempts: number | string | null;
}>;

type ResultRow = Readonly<{
    ris_resource_id: string;
    ris_topic_id: string;
    ris_resource: string;
    ris_type_id: string;
    ris_status: string;
    fk_ext_bank_id: string;
    created_ts: Date | string | null;
    expire_ts: Date | string | null;
}>;

export class PSqlAdminSupportReader implements AdminSupportReader {
    private readonly sql: PSqlSql;

    constructor(sql: PSqlSql) {
        this.sql = sql;
    }

    async readQueueEntry(
        key: Key,
        includeExpired: boolean
    ): Promise<AdminSupportQueueEntryRead | undefined> {
        const rows = includeExpired
            ? await this.sql<InboxRow[]>`
          select ri_resource_id,
                 ri_topic_id,
                 ri_resource,
                 ri_type_id,
                 ri_status,
                 fk_ext_bank_id,
                 created_ts,
                 start_ts,
                 end_ts,
                 next_ts,
                 expire_ts,
                 ri_attempts
          from resource_inbox
          where ri_topic_id = ${key.topicId}
            and ri_resource_id = ${key.resourceId}
            and fk_ext_bank_id = ${key.contextId}
          limit 1
        `
            : await this.sql<InboxRow[]>`
          select ri_resource_id,
                 ri_topic_id,
                 ri_resource,
                 ri_type_id,
                 ri_status,
                 fk_ext_bank_id,
                 created_ts,
                 start_ts,
                 end_ts,
                 next_ts,
                 expire_ts,
                 ri_attempts
          from resource_inbox
          where ri_topic_id = ${key.topicId}
            and ri_resource_id = ${key.resourceId}
            and fk_ext_bank_id = ${key.contextId}
            and expire_ts > now()
          limit 1
        `;

        return rows[0] ? toInboxRead(rows[0]) : undefined;
    }

    async readQueueResult(
        key: Key,
        includeExpired: boolean
    ): Promise<AdminSupportQueueEntryRead | undefined> {
        const rows = includeExpired
            ? await this.sql<ResultRow[]>`
          select ris_resource_id,
                 ris_topic_id,
                 ris_resource,
                 ris_type_id,
                 ris_status,
                 fk_ext_bank_id,
                 created_ts,
                 expire_ts
          from resource_inbox_results
          where ris_topic_id = ${key.topicId}
            and ris_resource_id = ${key.resourceId}
            and fk_ext_bank_id = ${key.contextId}
          limit 1
        `
            : await this.sql<ResultRow[]>`
          select ris_resource_id,
                 ris_topic_id,
                 ris_resource,
                 ris_type_id,
                 ris_status,
                 fk_ext_bank_id,
                 created_ts,
                 expire_ts
          from resource_inbox_results
          where ris_topic_id = ${key.topicId}
            and ris_resource_id = ${key.resourceId}
            and fk_ext_bank_id = ${key.contextId}
            and expire_ts > now()
          limit 1
        `;

        return rows[0] ? toResultRead(rows[0]) : undefined;
    }
}

function toInboxRead(row: InboxRow): AdminSupportQueueEntryRead {
    return {
        source: 'resource_inbox',
        key: {
            topicId: row.ri_topic_id,
            resourceId: row.ri_resource_id,
            contextId: row.fk_ext_bank_id
        },
        typeId: row.ri_type_id,
        status: row.ri_status,
        attempts: toNumber(row.ri_attempts),
        createdAtEpochMs: toEpochMs(row.created_ts),
        startedAtEpochMs: toEpochMs(row.start_ts),
        endedAtEpochMs: toEpochMs(row.end_ts),
        nextRetryAtEpochMs: toEpochMs(row.next_ts),
        expiresAtEpochMs: toEpochMs(row.expire_ts),
        payload: row.ri_resource
    };
}

function toResultRead(row: ResultRow): AdminSupportQueueEntryRead {
    return {
        source: 'resource_inbox_results',
        key: {
            topicId: row.ris_topic_id,
            resourceId: row.ris_resource_id,
            contextId: row.fk_ext_bank_id
        },
        typeId: row.ris_type_id,
        status: row.ris_status,
        attempts: 0,
        createdAtEpochMs: toEpochMs(row.created_ts),
        expiresAtEpochMs: toEpochMs(row.expire_ts),
        payload: row.ris_resource
    };
}

function toEpochMs(value: Date | string | null): number | undefined {
    if (value === null) {
        return undefined;
    }
    const ms = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(ms) ? ms : undefined;
}

function toNumber(value: number | string | null): number {
    if (value === null) {
        return 0;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
