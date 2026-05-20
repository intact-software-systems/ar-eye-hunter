import type {
    PSqlSql,
    PSqlTransactionSql,
} from '@shared-server/postgres/PostgresSqlClient.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import {
    ResourceInboxResultsRow,
    toPgTimestamp,
    toResultsDomain,
    toSystemDate,
} from '@shared-server/postgres/resource-inbox/repository-utils.ts';

export class ResourceInboxResultsRepository {
    constructor(private readonly sql: PSqlSql) {}

    /**
     * Run repository operations inside a transaction.
     * Required for SELECT ... FOR UPDATE SKIP LOCKED to be meaningful.
     */
    async begin<T>(
        fn: (repo: ResourceInboxResultsRepository) => Promise<T>,
    ): Promise<T> {
        const newVar = await this.sql.begin<T>(
            async (sql: PSqlTransactionSql) => {
                return await fn(new ResourceInboxResultsRepository(sql));
            },
        );

        return newVar as T;
    }

    async writeIfAbsentOrReplaceExpired(
        entry: ResourceEntry,
    ): Promise<ResourceEntry> {
        const systemDate = toSystemDate(entry);

        const rows = await this.sql<ResourceInboxResultsRow[]>`
            insert into resource_inbox_results (ris_resource_id,
                                                ris_topic_id,
                                                ris_resource,
                                                ris_type_id,
                                                ris_status,
                                                fk_ext_bank_id,
                                                system_date,
                                                created_by,
                                                created_ts,
                                                expire_ts)
            values (${entry.key.resourceId},
                    ${entry.key.topicId},
                    ${entry.resource},
                    ${entry.typeId},
                    ${entry.status},
                    ${entry.key.contextId},
                    ${systemDate},
                    ${entry.audit.createdBy},
                    ${toPgTimestamp(entry.audit.createdTs)},
                    ${toPgTimestamp(entry.audit.expiryTs)})
            on conflict (fk_ext_bank_id, ris_resource_id, ris_topic_id)
                do update set ris_resource = excluded.ris_resource,
                              ris_type_id  = excluded.ris_type_id,
                              ris_status   = excluded.ris_status,
                              system_date  = excluded.system_date,
                              created_by   = excluded.created_by,
                              created_ts   = excluded.created_ts,
                              expire_ts    = excluded.expire_ts
            where resource_inbox_results.expire_ts <= now()
            returning *
        `;

        if (rows.length === 1) {
            return toResultsDomain(rows[0]);
        }

        const existing = await this.findAnyByKey(entry.key);
        if (existing) {
            return existing;
        }

        throw new Error(
            'Write-if-absent failed: conflicting row was not returned and no active row exists',
        );
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
        const rows = await this.sql<{ ris_row_id: bigint }[]>`
            delete
            from resource_inbox_results
            where expire_ts <= now()
            returning ris_row_id
        `;

        return rows.length;
    }
}
