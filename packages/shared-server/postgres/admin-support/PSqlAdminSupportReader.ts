import type { Key } from '@shared/queuebox/ResourceEntry.ts';
import type {
    AdminSupportQueueEntryRead,
    AdminSupportReader
} from '../../rallar-system/admin-support/admin-support-contracts.ts';
import type { PSqlSql } from '../p-sql-sql.ts';
import {
    toAdminSupportInboxRead,
    toAdminSupportResultRead,
    type AdminSupportInboxRow,
    type AdminSupportResultRow
} from './admin-support-row-codec.ts';

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
            ? await this.sql<AdminSupportInboxRow[]>`
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
            : await this.sql<AdminSupportInboxRow[]>`
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

        return rows[0] ? toAdminSupportInboxRead(rows[0]) : undefined;
    }

    async readQueueResult(
        key: Key,
        includeExpired: boolean
    ): Promise<AdminSupportQueueEntryRead | undefined> {
        const rows = includeExpired
            ? await this.sql<AdminSupportResultRow[]>`
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
            : await this.sql<AdminSupportResultRow[]>`
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

        return rows[0] ? toAdminSupportResultRead(rows[0]) : undefined;
    }
}
