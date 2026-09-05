import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import {
    hasMatchingImmutableResourceInboxContent,
    isValidResourceInboxLifecycle,
    type ResourceInboxRow
} from './resource-inbox-row-codec.ts';

export interface ResourceInboxEntryInsertValues {
    readonly entry: ResourceEntry;
    readonly systemDate: string;
    readonly createdTimestamp: string;
    readonly expiryTimestamp: string;
    readonly startTimestamp: string | null;
    readonly endTimestamp: string | null;
    readonly nextTimestamp: string | null;
    readonly attempts: number;
}

type ResourceInboxEntryWriteOutcome =
    | Readonly<{ outcome: 'inserted' | 'matched'; }>
    | Readonly<{ outcome: 'corruption'; message: string; }>;

export async function writeResourceInboxEntryIfAbsentOrMatch(
    sql: PSqlSql,
    values: ResourceInboxEntryInsertValues
): Promise<ResourceInboxEntryWriteOutcome> {
    const { entry } = values;
    const inserted = await sql<ResourceInboxRow[]>`
        insert into resource_inbox (ri_resource_id,
                                    ri_topic_id,
                                    ri_resource,
                                    ri_type_id,
                                    ri_status,
                                    fk_ext_bank_id,
                                    system_date,
                                    created_by,
                                    created_ts,
                                    expire_ts,
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
                ${values.systemDate},
                ${entry.audit.createdBy},
                ${values.createdTimestamp},
                ${values.expiryTimestamp},
                ${values.startTimestamp},
                ${values.endTimestamp},
                ${values.nextTimestamp},
                ${values.attempts})
        on conflict (fk_ext_bank_id, ri_resource_id, ri_topic_id)
            do nothing
        returning *
    `;

    if (inserted.length === 1) {
        return { outcome: 'inserted' };
    }
    if (inserted.length !== 0) {
        return {
            outcome: 'corruption',
            message: 'Resource inbox insert returned an unexpected row count'
        };
    }

    const rows = await sql<ResourceInboxRow[]>`
        select ri_row_id,
               ri_resource_id,
               ri_topic_id,
               ri_resource,
               ri_type_id,
               ri_status,
               fk_ext_bank_id,
               case
                   when extract(year from system_date) > 9999
                       then '+' || lpad(extract(year from system_date)::text, 6, '0') ||
                            to_char(system_date, '-MM-DD')
                   else to_char(system_date, 'YYYY-MM-DD')
                   end as system_date,
               created_by,
               case
                   when extract(year from created_ts) > 9999
                       then '+' || lpad(extract(year from created_ts)::text, 6, '0') ||
                            to_char(created_ts, '-MM-DD"T"HH24:MI:SS.US')
                   else to_char(created_ts, 'YYYY-MM-DD"T"HH24:MI:SS.US')
                   end as created_ts,
               case
                   when extract(year from expire_ts) > 9999
                       then '+' || lpad(extract(year from expire_ts)::text, 6, '0') ||
                            to_char(expire_ts, '-MM-DD"T"HH24:MI:SS.US')
                   else to_char(expire_ts, 'YYYY-MM-DD"T"HH24:MI:SS.US')
                   end as expire_ts,
               case
                   when extract(year from start_ts) > 9999
                       then '+' || lpad(extract(year from start_ts)::text, 6, '0') ||
                            to_char(start_ts, '-MM-DD"T"HH24:MI:SS.US')
                   else to_char(start_ts, 'YYYY-MM-DD"T"HH24:MI:SS.US')
                   end as start_ts,
               case
                   when extract(year from end_ts) > 9999
                       then '+' || lpad(extract(year from end_ts)::text, 6, '0') ||
                            to_char(end_ts, '-MM-DD"T"HH24:MI:SS.US')
                   else to_char(end_ts, 'YYYY-MM-DD"T"HH24:MI:SS.US')
                   end as end_ts,
               case
                   when extract(year from next_ts) > 9999
                       then '+' || lpad(extract(year from next_ts)::text, 6, '0') ||
                            to_char(next_ts, '-MM-DD"T"HH24:MI:SS.US')
                   else to_char(next_ts, 'YYYY-MM-DD"T"HH24:MI:SS.US')
                   end as next_ts,
               ri_attempts
        from resource_inbox
        where ri_topic_id = ${entry.key.topicId}
          and ri_resource_id = ${entry.key.resourceId}
          and fk_ext_bank_id = ${entry.key.contextId}
        limit 1
    `;
    const existing = rows[0];
    if (
        rows.length !== 1 ||
        !existing ||
        !isValidResourceInboxLifecycle(existing) ||
        !hasMatchingImmutableResourceInboxContent(existing, entry)
    ) {
        return {
            outcome: 'corruption',
            message: 'Resource inbox immutable content or lifecycle differs'
        };
    }

    return { outcome: 'matched' };
}
