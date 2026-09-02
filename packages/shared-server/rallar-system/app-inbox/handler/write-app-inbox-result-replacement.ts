import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import type { ResourceInboxResultsRow } from '../../../queuebox/postgres/resource-inbox-row-codec.ts';
import type { AppInboxResultReplacement } from './app-inbox-completion-computation.ts';

export async function writeAppInboxResultReplacement(
    transaction: PSqlSql,
    computed: AppInboxResultReplacement
): Promise<void> {
    const rows = await transaction<readonly ResourceInboxResultsRow[]>`
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
        values (${computed.resourceId},
                ${computed.topicId},
                ${computed.resource},
                ${computed.typeId},
                ${computed.status},
                ${computed.contextId},
                ${computed.systemDate},
                ${computed.createdBy},
                ${computed.createdAt},
                ${computed.expiresAt})
        on conflict (fk_ext_bank_id, ris_resource_id, ris_topic_id)
            do update set ris_resource = excluded.ris_resource,
                          ris_type_id  = excluded.ris_type_id,
                          ris_status   = excluded.ris_status,
                          system_date  = excluded.system_date,
                          created_by   = excluded.created_by,
                          created_ts   = excluded.created_ts,
                          expire_ts    = excluded.expire_ts
        returning *
    `;

    if (rows.length !== 1) {
        throw new Error('AppInbox result replacement expected exactly one row');
    }
}

