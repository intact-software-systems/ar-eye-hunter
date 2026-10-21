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

/** One observation of the multi-row lock, named as the statement's recordset columns. */
interface ResourceInboxObservationRow {
    readonly position: number;
    readonly rowId: string;
    readonly topicId: string;
    readonly resourceId: string;
    readonly contextId: string;
    readonly typeId: string;
    readonly resource: string;
    readonly status: string;
    readonly systemDate: string;
    readonly createdBy: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly nextAt: string | null;
    readonly attempts: number;
}

/**
 * Locks, in the order given and until the transaction ends, every row that still holds its observation; a row
 * missing from the answer moved.
 */
export async function lockObservedResourceInboxEntries(
    sql: PSqlSql,
    observations: readonly ResourceInboxObservation[]
): Promise<readonly Pick<ResourceInboxRow, 'ri_row_id'>[]> {
    return await sql<Pick<ResourceInboxRow, 'ri_row_id'>[]>`
        select resource_inbox.ri_row_id
        from jsonb_to_recordset(${observations.map(toObservationRow)}::jsonb)
            as observed(position integer, "rowId" bigint, "topicId" text, "resourceId" text, "contextId" text,
                        "typeId" text, resource text, status text, "systemDate" text, "createdBy" text,
                        "createdAt" text, "expiresAt" text, "startedAt" text, "finishedAt" text, "nextAt" text,
                        attempts bigint)
        join resource_inbox
          on resource_inbox.ri_row_id = observed."rowId"
         and resource_inbox.ri_topic_id = observed."topicId"
         and resource_inbox.ri_resource_id = observed."resourceId"
         and resource_inbox.fk_ext_bank_id = observed."contextId"
         and resource_inbox.ri_type_id = observed."typeId"
         and resource_inbox.ri_resource = observed.resource
         and resource_inbox.ri_status = observed.status
         and resource_inbox.system_date = observed."systemDate"::date
         and resource_inbox.created_by = observed."createdBy"
         and resource_inbox.created_ts = observed."createdAt"::timestamp(6)
         and resource_inbox.expire_ts = observed."expiresAt"::timestamp(6)
         and resource_inbox.start_ts is not distinct from observed."startedAt"::timestamp(6)
         and resource_inbox.end_ts is not distinct from observed."finishedAt"::timestamp(6)
         and resource_inbox.next_ts is not distinct from observed."nextAt"::timestamp(6)
         and resource_inbox.ri_attempts = observed.attempts
         and resource_inbox.expire_ts > (now() at time zone 'UTC')
        order by observed.position
        for update of resource_inbox
    `;
}

function toObservationRow(observation: ResourceInboxObservation, position: number): ResourceInboxObservationRow {
    const { expected } = observation;
    return {
        position,
        rowId: observation.expectedRowId.toString(),
        topicId: expected.entry.key.topicId,
        resourceId: expected.entry.key.resourceId,
        contextId: expected.entry.key.contextId,
        typeId: expected.entry.typeId,
        resource: expected.entry.resource,
        status: expected.entry.status,
        systemDate: expected.systemDate,
        createdBy: expected.entry.audit.createdBy,
        createdAt: expected.createdTimestamp,
        expiresAt: expected.expiryTimestamp,
        startedAt: expected.startTimestamp,
        finishedAt: expected.endTimestamp,
        nextAt: expected.nextTimestamp,
        attempts: expected.attempts
    };
}

/** Every column of the observed row, and a row still live: the compare of the replace. */
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
