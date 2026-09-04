import type { GroupEvent, GroupRef } from '@shared/api/group-types.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import type { StateEventListQuery } from '../state-event-listing.ts';
import type { GroupStateEventCollisionRow, GroupStateEventRow } from './group-state-event-row-codec.ts';
import { groupStateEventWorkspaceKey } from './group-state-event-workspace-key.ts';

interface GroupStateEventRowsQuery {
    readonly sql: PSqlSql;
    readonly ref: GroupRef;
    readonly query: StateEventListQuery;
    readonly limit: number;
}

export async function insertPSqlGroupStateEvent(
    sql: PSqlSql,
    event: GroupEvent,
    eventJson: string
): Promise<boolean> {
    const inserted = await sql<{ event_id: string; }[]>`
        insert into group_state_events (application_id,
                                        workspace_key,
                                        group_id,
                                        event_id,
                                        event_type,
                                        snapshot_version,
                                        occurred_at_epoch_ms,
                                        event_json)
        values (${event.applicationId},
                ${groupStateEventWorkspaceKey(event.workspaceId)},
                ${event.groupId},
                ${event.eventId},
                ${event.eventType},
                ${event.snapshotVersion},
                ${event.occurredAtEpochMs},
                ${eventJson})
        on conflict (application_id, workspace_key, group_id, event_id)
            do nothing
        returning event_id
    `;
    return inserted.length === 1;
}

export async function readPSqlGroupStateEventCollision(
    sql: PSqlSql,
    event: GroupEvent
): Promise<GroupStateEventCollisionRow | undefined> {
    const [existing] = await sql<GroupStateEventCollisionRow[]>`
        select application_id, workspace_key, group_id, event_id,
               event_type, snapshot_version, occurred_at_epoch_ms, event_json
        from group_state_events
        where application_id = ${event.applicationId}
          and workspace_key = ${groupStateEventWorkspaceKey(event.workspaceId)}
          and group_id = ${event.groupId}
          and event_id = ${event.eventId}
    `;
    return existing;
}

export async function readAllPSqlGroupStateEventRows(
    sql: PSqlSql,
    ref: GroupRef
): Promise<readonly GroupStateEventRow[]> {
    return await sql<GroupStateEventRow[]>`
        select event_id, event_type, snapshot_version, occurred_at_epoch_ms, event_json
        from group_state_events
        where application_id = ${ref.applicationId}
          and workspace_key = ${groupStateEventWorkspaceKey(ref.workspaceId)}
          and group_id = ${ref.groupId}
        order by snapshot_version, occurred_at_epoch_ms, event_id
    `;
}

export async function readPSqlGroupStateEventRow(
    sql: PSqlSql,
    ref: GroupRef,
    eventId: string
): Promise<GroupStateEventRow | undefined> {
    const [row] = await sql<GroupStateEventRow[]>`
        select event_id, event_type, snapshot_version, occurred_at_epoch_ms, event_json
        from group_state_events
        where application_id = ${ref.applicationId}
          and workspace_key = ${groupStateEventWorkspaceKey(ref.workspaceId)}
          and group_id = ${ref.groupId}
          and event_id = ${eventId}
    `;
    return row;
}

export async function readRecentPSqlGroupStateEventRows(
    input: GroupStateEventRowsQuery
): Promise<readonly GroupStateEventRow[]> {
    const eventTypes = toEventTypes(input.query);
    return eventTypes === undefined
        ? await readRecentGroupRows(input)
        : await readRecentGroupRowsForTypes(input, eventTypes);
}

export async function readPSqlGroupStateEventPageRows(
    input: GroupStateEventRowsQuery
): Promise<readonly GroupStateEventRow[]> {
    const eventTypes = toEventTypes(input.query);
    const after = input.query.after;
    if (eventTypes !== undefined && after !== undefined) {
        return await readGroupPageRowsForTypesAfter(input, eventTypes);
    }
    if (eventTypes !== undefined) {
        return await readGroupPageRowsForTypes(input, eventTypes);
    }
    return after === undefined
        ? await readGroupPageRows(input)
        : await readGroupPageRowsAfter(input);
}

function toEventTypes(query: StateEventListQuery): readonly string[] | undefined {
    return query.eventTypes !== undefined && query.eventTypes.length > 0
        ? query.eventTypes
        : undefined;
}

async function readRecentGroupRows(
    input: GroupStateEventRowsQuery
): Promise<readonly GroupStateEventRow[]> {
    return await input.sql<GroupStateEventRow[]>`
        select event_id, event_type, snapshot_version, occurred_at_epoch_ms, event_json
        from (
            select event_json, event_type, snapshot_version, occurred_at_epoch_ms, event_id
            from group_state_events
            where application_id = ${input.ref.applicationId}
              and workspace_key = ${groupStateEventWorkspaceKey(input.ref.workspaceId)}
              and group_id = ${input.ref.groupId}
            order by snapshot_version desc, occurred_at_epoch_ms desc, event_id desc
            limit ${input.limit}
        ) recent_events
        order by snapshot_version, occurred_at_epoch_ms, event_id
    `;
}

async function readRecentGroupRowsForTypes(
    input: GroupStateEventRowsQuery,
    eventTypes: readonly string[]
): Promise<readonly GroupStateEventRow[]> {
    return await input.sql<GroupStateEventRow[]>`
        select event_id, event_type, snapshot_version, occurred_at_epoch_ms, event_json
        from (
            select event_json, event_type, snapshot_version, occurred_at_epoch_ms, event_id
            from group_state_events
            where application_id = ${input.ref.applicationId}
              and workspace_key = ${groupStateEventWorkspaceKey(input.ref.workspaceId)}
              and group_id = ${input.ref.groupId}
              and event_type in ${input.sql(eventTypes)}
            order by snapshot_version desc, occurred_at_epoch_ms desc, event_id desc
            limit ${input.limit}
        ) recent_events
        order by snapshot_version, occurred_at_epoch_ms, event_id
    `;
}

async function readGroupPageRows(
    input: GroupStateEventRowsQuery
): Promise<readonly GroupStateEventRow[]> {
    return await input.sql<GroupStateEventRow[]>`
        select event_id, event_type, snapshot_version, occurred_at_epoch_ms, event_json
        from group_state_events
        where application_id = ${input.ref.applicationId}
          and workspace_key = ${groupStateEventWorkspaceKey(input.ref.workspaceId)}
          and group_id = ${input.ref.groupId}
        order by snapshot_version, occurred_at_epoch_ms, event_id
        limit ${input.limit}
    `;
}

async function readGroupPageRowsAfter(
    input: GroupStateEventRowsQuery
): Promise<readonly GroupStateEventRow[]> {
    const after = input.query.after;
    if (after === undefined) {
        throw new TypeError('Group event page cursor is required');
    }
    return await input.sql<GroupStateEventRow[]>`
        select event_id, event_type, snapshot_version, occurred_at_epoch_ms, event_json
        from group_state_events
        where application_id = ${input.ref.applicationId}
          and workspace_key = ${groupStateEventWorkspaceKey(input.ref.workspaceId)}
          and group_id = ${input.ref.groupId}
          and (snapshot_version, occurred_at_epoch_ms, event_id) >
              (${after.snapshotVersion}, ${after.occurredAtEpochMs}, ${after.eventId})
        order by snapshot_version, occurred_at_epoch_ms, event_id
        limit ${input.limit}
    `;
}

async function readGroupPageRowsForTypes(
    input: GroupStateEventRowsQuery,
    eventTypes: readonly string[]
): Promise<readonly GroupStateEventRow[]> {
    return await input.sql<GroupStateEventRow[]>`
        select event_id, event_type, snapshot_version, occurred_at_epoch_ms, event_json
        from group_state_events
        where application_id = ${input.ref.applicationId}
          and workspace_key = ${groupStateEventWorkspaceKey(input.ref.workspaceId)}
          and group_id = ${input.ref.groupId}
          and event_type in ${input.sql(eventTypes)}
        order by snapshot_version, occurred_at_epoch_ms, event_id
        limit ${input.limit}
    `;
}

async function readGroupPageRowsForTypesAfter(
    input: GroupStateEventRowsQuery,
    eventTypes: readonly string[]
): Promise<readonly GroupStateEventRow[]> {
    const after = input.query.after;
    if (after === undefined) {
        throw new TypeError('Group event page cursor is required');
    }
    return await input.sql<GroupStateEventRow[]>`
        select event_id, event_type, snapshot_version, occurred_at_epoch_ms, event_json
        from group_state_events
        where application_id = ${input.ref.applicationId}
          and workspace_key = ${groupStateEventWorkspaceKey(input.ref.workspaceId)}
          and group_id = ${input.ref.groupId}
          and event_type in ${input.sql(eventTypes)}
          and (snapshot_version, occurred_at_epoch_ms, event_id) >
              (${after.snapshotVersion}, ${after.occurredAtEpochMs}, ${after.eventId})
        order by snapshot_version, occurred_at_epoch_ms, event_id
        limit ${input.limit}
    `;
}
