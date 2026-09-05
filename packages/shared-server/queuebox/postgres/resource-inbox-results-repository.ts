import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import {
    toResultsDomain,
    type ResourceInboxResultsRow
} from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import {
    computeResourceInboxResultReplacement,
    writeResourceInboxResultReplacement
} from './resource-inbox-result-replacement.ts';

export class ResourceInboxResultsRepository {
    private readonly sql: PSqlSql;

    constructor(sql: PSqlSql) {
        this.sql = sql;
    }

    async replace(entry: ResourceEntry): Promise<ResourceEntry> {
        const row = await writeResourceInboxResultReplacement(
            this.sql,
            computeResourceInboxResultReplacement(entry)
        );
        return toResultsDomain(row);
    }

    async findAnyByKey(key: Key): Promise<ResourceEntry | null> {
        const rows = await this.sql<ResourceInboxResultsRow[]>`
            select *
            from resource_inbox_results
            where ris_topic_id = ${key.topicId}
              and ris_resource_id = ${key.resourceId}
              and fk_ext_bank_id = ${key.contextId}
            limit 1
        `;

        return rows.length === 0 ? null : toResultsDomain(rows[0]);
    }

    async findByKey(key: Key): Promise<ResourceEntry | undefined> {
        const now = new Date();

        const rows = await this.sql<ResourceInboxResultsRow[]>`
            select *
            from resource_inbox_results
            where ris_topic_id = ${key.topicId}
              and ris_resource_id = ${key.resourceId}
              and fk_ext_bank_id = ${key.contextId}
              and expire_ts > ${now}
            limit 1
        `;

        return rows.length === 0 ? undefined : toResultsDomain(rows[0]);
    }

    async deleteExpired(): Promise<number> {
        const rows = await this.sql<{ ris_row_id: bigint; }[]>`
            delete
            from resource_inbox_results
            where expire_ts <= (now() at time zone 'UTC')
            returning ris_row_id
        `;

        return rows.length;
    }
}
