import { PSqlFragment } from '../../postgres/p-sql-fragment.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import {
    RESOURCE_INBOX_ENTRY_CONTENT_RECORDSET_COLUMNS,
    toResourceInboxEntryInsertRow,
    type ResourceInboxEntryInsertRow,
    type ResourceInboxEntryInsertValues
} from './resource-inbox-entry-insert-values.ts';
import type { ResourceInboxRow } from './resource-inbox-row-codec.ts';

/** A row exactly as one read or claim returned it; every statement below compares every one of its columns. */
export interface ResourceInboxObservation {
    readonly expected: ResourceInboxEntryInsertValues;
    readonly expectedRowId: bigint;
}

export interface ResourceInboxObservedReplacement extends ResourceInboxObservation {
    readonly replacement: ResourceInboxEntryInsertValues;
}

/** One observation of a multi-row statement, named as its recordset columns: the row identity, then what it held. */
interface ResourceInboxObservedColumns {
    readonly expectedRowId: string;
    readonly topicId: string;
    readonly resourceId: string;
    readonly contextId: string;
    readonly expectedTypeId: string;
    readonly expectedResource: string;
    readonly expectedStatus: string;
    readonly expectedSystemDate: string;
    readonly expectedCreatedBy: string;
    readonly expectedCreatedAt: string;
    readonly expectedExpiresAt: string;
    readonly expectedStartedAt: string | null;
    readonly expectedFinishedAt: string | null;
    readonly expectedNextAt: string | null;
    readonly expectedAttempts: number;
}

interface ResourceInboxPositionedObservationRow extends ResourceInboxObservedColumns {
    readonly position: number;
}

/** The replacement row's own key is the observed one, which the replace never changes. */
type ResourceInboxObservedReplacementRow = ResourceInboxEntryInsertRow & ResourceInboxObservedColumns;

const OBSERVED_RECORDSET_COLUMNS = PSqlFragment.of`"expectedRowId" bigint, "topicId" text, "resourceId" text,
                        "contextId" text, "expectedTypeId" text, "expectedResource" text, "expectedStatus" text,
                        "expectedSystemDate" text, "expectedCreatedBy" text, "expectedCreatedAt" text,
                        "expectedExpiresAt" text, "expectedStartedAt" text, "expectedFinishedAt" text,
                        "expectedNextAt" text, "expectedAttempts" bigint`;

/** Every column of the observed row, and a row still live: the compare of the multi-row lock and replace alike. */
const OBSERVED_ROW_PREDICATE = PSqlFragment.of`resource_inbox.ri_row_id = observed."expectedRowId"
          and resource_inbox.ri_topic_id = observed."topicId"
          and resource_inbox.ri_resource_id = observed."resourceId"
          and resource_inbox.fk_ext_bank_id = observed."contextId"
          and resource_inbox.ri_type_id = observed."expectedTypeId"
          and resource_inbox.ri_resource = observed."expectedResource"
          and resource_inbox.ri_status = observed."expectedStatus"
          and resource_inbox.system_date = observed."expectedSystemDate"::date
          and resource_inbox.created_by = observed."expectedCreatedBy"
          and resource_inbox.created_ts = observed."expectedCreatedAt"::timestamp(6)
          and resource_inbox.expire_ts = observed."expectedExpiresAt"::timestamp(6)
          and resource_inbox.start_ts is not distinct from observed."expectedStartedAt"::timestamp(6)
          and resource_inbox.end_ts is not distinct from observed."expectedFinishedAt"::timestamp(6)
          and resource_inbox.next_ts is not distinct from observed."expectedNextAt"::timestamp(6)
          and resource_inbox.ri_attempts = observed."expectedAttempts"
          and resource_inbox.expire_ts > (now() at time zone 'UTC')`;

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

/**
 * Locks, in the order given and until the transaction ends, every row that still holds its observation; a row
 * missing from the answer moved.
 */
export async function lockObservedResourceInboxEntries(
    sql: PSqlSql,
    observations: readonly ResourceInboxObservation[]
): Promise<readonly Pick<ResourceInboxRow, 'ri_row_id'>[]> {
    const statement = PSqlFragment.of`
        select resource_inbox.ri_row_id
        from jsonb_to_recordset(${observations.map(toPositionedObservationRow)}::jsonb)
            as observed(position integer, ${OBSERVED_RECORDSET_COLUMNS})
        join resource_inbox on ${OBSERVED_ROW_PREDICATE}
        order by observed.position
        for update of resource_inbox
    `.toPlannedPerExecution();
    return await sql<Pick<ResourceInboxRow, 'ri_row_id'>[]>(...statement.toStatement());
}

/** Every replacement in one statement, each of a distinct row: the replaced rows, none for a row that moved. */
export async function replaceObservedResourceInboxEntries(
    sql: PSqlSql,
    replacements: readonly ResourceInboxObservedReplacement[]
): Promise<readonly ResourceInboxRow[]> {
    const statement = PSqlFragment.of`
        update resource_inbox
        set ri_resource = observed.resource,
            ri_type_id = observed."typeId",
            ri_status = observed.status,
            system_date = observed."systemDate"::date,
            created_by = observed."createdBy",
            created_ts = observed."createdAt"::timestamp(6),
            expire_ts = observed."expiresAt"::timestamp(6),
            start_ts = observed."startedAt"::timestamp(6),
            end_ts = observed."finishedAt"::timestamp(6),
            next_ts = observed."nextAt"::timestamp(6),
            ri_attempts = observed.attempts
        from jsonb_to_recordset(${replacements.map(toObservedReplacementRow)}::jsonb)
            as observed(${OBSERVED_RECORDSET_COLUMNS}, ${RESOURCE_INBOX_ENTRY_CONTENT_RECORDSET_COLUMNS})
        where ${OBSERVED_ROW_PREDICATE}
        returning resource_inbox.*
    `.toPlannedPerExecution();
    return await sql<ResourceInboxRow[]>(...statement.toStatement());
}

function toPositionedObservationRow(
    observation: ResourceInboxObservation,
    position: number
): ResourceInboxPositionedObservationRow {
    return { position, ...toObservedColumns(observation) };
}

function toObservedReplacementRow(computed: ResourceInboxObservedReplacement): ResourceInboxObservedReplacementRow {
    return { ...toResourceInboxEntryInsertRow(computed.replacement), ...toObservedColumns(computed) };
}

function toObservedColumns(observation: ResourceInboxObservation): ResourceInboxObservedColumns {
    const { expected } = observation;
    return {
        expectedRowId: observation.expectedRowId.toString(),
        topicId: expected.entry.key.topicId,
        resourceId: expected.entry.key.resourceId,
        contextId: expected.entry.key.contextId,
        expectedTypeId: expected.entry.typeId,
        expectedResource: expected.entry.resource,
        expectedStatus: expected.entry.status,
        expectedSystemDate: expected.systemDate,
        expectedCreatedBy: expected.entry.audit.createdBy,
        expectedCreatedAt: expected.createdTimestamp,
        expectedExpiresAt: expected.expiryTimestamp,
        expectedStartedAt: expected.startTimestamp,
        expectedFinishedAt: expected.endTimestamp,
        expectedNextAt: expected.nextTimestamp,
        expectedAttempts: expected.attempts
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
