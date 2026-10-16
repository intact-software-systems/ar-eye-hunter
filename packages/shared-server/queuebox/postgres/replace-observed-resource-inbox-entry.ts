import { PSqlFragment } from '../../postgres/p-sql-fragment.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import type { ResourceInboxEntryInsertValues } from './resource-inbox-entry-insert-values.ts';
import type { ResourceInboxRow } from './resource-inbox-row-codec.ts';

/** A row exactly as one read or claim returned it; both statements below compare every one of its columns. */
export interface ResourceInboxObservation {
    readonly expected: ResourceInboxEntryInsertValues;
    readonly expectedRowId: bigint;
}

export interface ResourceInboxObservedReplacement extends ResourceInboxObservation {
    readonly replacement: ResourceInboxEntryInsertValues;
}

export async function replaceObservedResourceInboxEntry(
    sql: PSqlSql,
    computed: ResourceInboxObservedReplacement
): Promise<ResourceInboxRow[]> {
    const { replacement } = computed;
    const statement = PSqlFragment.of`
        update resource_inbox
        set ri_resource = ${replacement.entry.resource},
            ri_type_id = ${replacement.entry.typeId},
            ri_status = ${replacement.entry.status},
            system_date = ${replacement.systemDate},
            created_by = ${replacement.entry.audit.createdBy},
            created_ts = ${replacement.createdTimestamp},
            expire_ts = ${replacement.expiryTimestamp},
            start_ts = ${replacement.startTimestamp},
            end_ts = ${replacement.endTimestamp},
            next_ts = ${replacement.nextTimestamp},
            ri_attempts = ${replacement.attempts}
        where ${toObservedResourceInboxRowPredicate(computed)}
        returning *
    `;
    return await sql<ResourceInboxRow[]>(...statement.toStatement());
}

/** Locks the row until the transaction ends while it still holds the observation; no row means it moved. */
export async function lockObservedResourceInboxEntry(
    sql: PSqlSql,
    observation: ResourceInboxObservation
): Promise<readonly Pick<ResourceInboxRow, 'ri_row_id'>[]> {
    const statement = PSqlFragment.of`
        select ri_row_id
        from resource_inbox
        where ${toObservedResourceInboxRowPredicate(observation)}
        for update
    `;
    return await sql<Pick<ResourceInboxRow, 'ri_row_id'>[]>(...statement.toStatement());
}

/** Every column of the observed row, and a row still live: the compare of the replace and of the lock alike. */
function toObservedResourceInboxRowPredicate(observation: ResourceInboxObservation): PSqlFragment {
    const { expected, expectedRowId } = observation;
    return PSqlFragment.of`ri_row_id = ${expectedRowId}
          and ri_topic_id = ${expected.entry.key.topicId}
          and ri_resource_id = ${expected.entry.key.resourceId}
          and fk_ext_bank_id = ${expected.entry.key.contextId}
          and ri_type_id = ${expected.entry.typeId}
          and ri_resource = ${expected.entry.resource}
          and ri_status = ${expected.entry.status}
          and system_date = ${expected.systemDate}
          and created_by = ${expected.entry.audit.createdBy}
          and created_ts = ${expected.createdTimestamp}
          and expire_ts = ${expected.expiryTimestamp}
          and start_ts is not distinct from ${expected.startTimestamp}
          and end_ts is not distinct from ${expected.endTimestamp}
          and next_ts is not distinct from ${expected.nextTimestamp}
          and ri_attempts = ${expected.attempts}
          and expire_ts > (now() at time zone 'UTC')`;
}
