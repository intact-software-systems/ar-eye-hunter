import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import {
    toPgTimestamp,
    toSystemDate,
    type ResourceInboxResultsRow
} from './resource-inbox-row-codec.ts';

export interface ResourceInboxResultReplacement {
    readonly resourceId: string;
    readonly topicId: string;
    readonly resource: string;
    readonly typeId: string;
    readonly status: ResourceEntry['status'];
    readonly contextId: string;
    readonly systemDate: string;
    readonly createdBy: string;
    readonly createdAt: string;
    readonly expiresAt: string;
}

export function computeResourceInboxResultReplacement(
    entry: ResourceEntry
): ResourceInboxResultReplacement {
    return {
        resourceId: entry.key.resourceId,
        topicId: entry.key.topicId,
        resource: entry.resource,
        typeId: entry.typeId,
        status: entry.status,
        contextId: entry.key.contextId,
        systemDate: toSystemDate(entry),
        createdBy: entry.audit.createdBy,
        createdAt: toPgTimestamp(entry.audit.createdTs),
        expiresAt: toPgTimestamp(entry.audit.expiryTs)
    };
}

export async function writeResourceInboxResultReplacement(
    transaction: PSqlSql,
    computed: ResourceInboxResultReplacement
): Promise<ResourceInboxResultsRow> {
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

    if (rows.length !== 1 || rows[0] === undefined) {
        throw new Error('Resource inbox result replacement expected exactly one row');
    }
    return rows[0];
}
