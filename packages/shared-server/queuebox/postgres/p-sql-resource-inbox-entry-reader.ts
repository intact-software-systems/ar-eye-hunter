import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import {
    rowsToMap,
    toDomain,
    type ResourceInboxRow
} from './resource-inbox-row-codec.ts';

const MAX_ROWS_TO_RETURN = 50;

export class PSqlResourceInboxEntryReader {
    private readonly sql: PSqlSql;

    constructor(sql: PSqlSql) {
        this.sql = sql;
    }

    async findByKey(key: Key): Promise<ResourceEntry | null> {
        const now = new Date();
        const rows = await this.sql<ResourceInboxRow[]>`
            select *
            from resource_inbox
            where ri_topic_id = ${key.topicId}
              and ri_resource_id = ${key.resourceId}
              and fk_ext_bank_id = ${key.contextId}
              and expire_ts > ${now}
            limit 1
        `;

        return rows.length === 0 ? null : toDomain(rows[0]);
    }

    async findAnyByKey(key: Key): Promise<ResourceEntry | null> {
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

    async findAllByTopicAndResourceId(
        topicId: string,
        resourceId: string
    ): Promise<readonly ResourceEntry[]> {
        const rows = await this.sql<ResourceInboxRow[]>`
            select *
            from resource_inbox
            where ri_topic_id = ${topicId}
              and ri_resource_id = ${resourceId}
              and expire_ts > (now() at time zone 'UTC')
            order by ri_row_id
        `;
        return rows.map(toDomain);
    }

    async findAllKeys(): Promise<Key[]> {
        const now = new Date();
        const rows = await this.sql<Pick<ResourceInboxRow, 'ri_topic_id' | 'ri_resource_id' | 'fk_ext_bank_id'>[]>`
            select ri_topic_id, ri_resource_id, fk_ext_bank_id
            from resource_inbox
            where expire_ts > ${now}
            order by ri_row_id
        `;

        return rows.map((row) => ({
            topicId: row.ri_topic_id,
            resourceId: row.ri_resource_id,
            contextId: row.fk_ext_bank_id
        }));
    }

    async findByTopicId(topicId: string): Promise<Map<string, ResourceEntry>> {
        const now = new Date();
        const rows = await this.sql<ResourceInboxRow[]>`
            select *
            from resource_inbox
            where ri_topic_id = ${topicId}
              and expire_ts > ${now}
            order by ri_row_id
            limit ${MAX_ROWS_TO_RETURN}
        `;
        return rowsToMap(rows);
    }

    async findByTypeId(typeId: string): Promise<Map<string, ResourceEntry>> {
        const now = new Date();
        const rows = await this.sql<ResourceInboxRow[]>`
            select *
            from resource_inbox
            where ri_type_id = ${typeId}
              and expire_ts > ${now}
            order by ri_row_id
            limit ${MAX_ROWS_TO_RETURN}
        `;
        return rowsToMap(rows);
    }

    async isAnyWithStatuses(statuses: ReadonlySet<EntityStatus>): Promise<boolean> {
        if (statuses.size === 0) {
            return false;
        }

        const now = new Date();
        const rows = await this.sql<{ one: number; }[]>`
            select 1 as one
            from resource_inbox
            where ri_status in ${this.sql([...statuses])}
              and expire_ts > ${now}
            limit 1
        `;

        return rows.length > 0;
    }

    async isEntryWithStatus(key: Key, statuses: EntityStatus[]): Promise<boolean> {
        if (statuses.length === 0) {
            return false;
        }

        const now = new Date();
        const rows = await this.sql<{ one: number; }[]>`
            select 1 as one
            from resource_inbox
            where ri_status in ${this.sql(statuses)}
              and ri_topic_id = ${key.topicId}
              and ri_resource_id = ${key.resourceId}
              and fk_ext_bank_id = ${key.contextId}
              and expire_ts > ${now}
            limit 1
        `;

        return rows.length > 0;
    }
}
