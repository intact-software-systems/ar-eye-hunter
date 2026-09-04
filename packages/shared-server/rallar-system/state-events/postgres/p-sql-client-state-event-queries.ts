import type { ClientEvent, ClientPrincipalRef } from '@shared/api/client-types.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { clientStateWorkspaceStorageKey } from '../../client-state/persistence/client-state-workspace-storage-key.ts';
import type { StateEventListQuery } from '../state-event-listing.ts';
import type { ClientStateEventCollisionRow, ClientStateEventRow } from './client-state-event-row-codec.ts';

interface ClientStateEventRowsQuery {
    readonly sql: PSqlSql;
    readonly ref: ClientPrincipalRef;
    readonly query: StateEventListQuery;
    readonly limit: number;
}

export interface InsertPSqlClientStateEventInput {
    readonly sql: PSqlSql;
    readonly event: ClientEvent;
    readonly workspaceKey: string;
    readonly eventJson: string;
}

export async function insertPSqlClientStateEvent(
    input: InsertPSqlClientStateEventInput
): Promise<boolean> {
    const { sql, event, workspaceKey, eventJson } = input;
    const inserted = await sql<{ event_id: string; }[]>`
        insert into client_state_events (application_id,
                                         workspace_key,
                                         principal_id,
                                         event_id,
                                         event_type,
                                         snapshot_version,
                                         occurred_at_epoch_ms,
                                         client_instance_id,
                                         session_id,
                                         event_json)
        values (${event.applicationId},
                ${workspaceKey},
                ${event.principalId},
                ${event.eventId},
                ${event.eventType},
                ${event.snapshotVersion},
                ${event.occurredAtEpochMs},
                ${event.clientInstanceId ?? null},
                ${event.sessionId ?? null},
                ${eventJson})
        on conflict (application_id, workspace_key, principal_id, event_id)
            do nothing
        returning event_id
    `;
    return inserted.length === 1;
}

export async function readPSqlClientStateEventCollision(
    sql: PSqlSql,
    event: ClientEvent
): Promise<ClientStateEventCollisionRow | undefined> {
    const [existing] = await sql<ClientStateEventCollisionRow[]>`
        select application_id, workspace_key, principal_id, event_id,
               event_type, snapshot_version, occurred_at_epoch_ms,
               client_instance_id, session_id, event_json
        from client_state_events
        where application_id = ${event.applicationId}
          and workspace_key = ${clientStateWorkspaceStorageKey(event.workspaceId)}
          and principal_id = ${event.principalId}
          and event_id = ${event.eventId}
    `;
    return existing;
}

export async function readAllPSqlClientStateEventRows(
    sql: PSqlSql,
    ref: ClientPrincipalRef
): Promise<readonly ClientStateEventRow[]> {
    return await sql<ClientStateEventRow[]>`
        select event_id, event_type, snapshot_version, occurred_at_epoch_ms,
               client_instance_id, session_id, event_json
        from client_state_events
        where application_id = ${ref.applicationId}
          and workspace_key = ${clientStateWorkspaceStorageKey(ref.workspaceId)}
          and principal_id = ${ref.principalId}
        order by snapshot_version, occurred_at_epoch_ms, event_id
    `;
}

export async function readRecentPSqlClientStateEventRows(
    input: ClientStateEventRowsQuery
): Promise<readonly ClientStateEventRow[]> {
    const eventTypes = toEventTypes(input.query);
    return eventTypes === undefined
        ? await readRecentClientRows(input)
        : await readRecentClientRowsForTypes(input, eventTypes);
}

export async function readPSqlClientStateEventPageRows(
    input: ClientStateEventRowsQuery
): Promise<readonly ClientStateEventRow[]> {
    const eventTypes = toEventTypes(input.query);
    const after = input.query.after;
    if (eventTypes !== undefined && after !== undefined) {
        return await readClientPageRowsForTypesAfter(input, eventTypes);
    }
    if (eventTypes !== undefined) {
        return await readClientPageRowsForTypes(input, eventTypes);
    }
    return after === undefined
        ? await readClientPageRows(input)
        : await readClientPageRowsAfter(input);
}

function toEventTypes(query: StateEventListQuery): readonly string[] | undefined {
    return query.eventTypes !== undefined && query.eventTypes.length > 0
        ? query.eventTypes
        : undefined;
}

async function readRecentClientRows(
    input: ClientStateEventRowsQuery
): Promise<readonly ClientStateEventRow[]> {
    return await input.sql<ClientStateEventRow[]>`
        select event_id, event_type, snapshot_version, occurred_at_epoch_ms,
               client_instance_id, session_id, event_json
        from (
            select event_json, event_type, snapshot_version,
                   occurred_at_epoch_ms, event_id, client_instance_id,
                   session_id
            from client_state_events
            where application_id = ${input.ref.applicationId}
              and workspace_key = ${clientStateWorkspaceStorageKey(input.ref.workspaceId)}
              and principal_id = ${input.ref.principalId}
            order by snapshot_version desc, occurred_at_epoch_ms desc, event_id desc
            limit ${input.limit}
        ) recent_events
        order by snapshot_version, occurred_at_epoch_ms, event_id
    `;
}

async function readRecentClientRowsForTypes(
    input: ClientStateEventRowsQuery,
    eventTypes: readonly string[]
): Promise<readonly ClientStateEventRow[]> {
    return await input.sql<ClientStateEventRow[]>`
        select event_id, event_type, snapshot_version, occurred_at_epoch_ms,
               client_instance_id, session_id, event_json
        from (
            select event_json, event_type, snapshot_version,
                   occurred_at_epoch_ms, event_id, client_instance_id,
                   session_id
            from client_state_events
            where application_id = ${input.ref.applicationId}
              and workspace_key = ${clientStateWorkspaceStorageKey(input.ref.workspaceId)}
              and principal_id = ${input.ref.principalId}
              and event_type in ${input.sql(eventTypes)}
            order by snapshot_version desc, occurred_at_epoch_ms desc, event_id desc
            limit ${input.limit}
        ) recent_events
        order by snapshot_version, occurred_at_epoch_ms, event_id
    `;
}

async function readClientPageRows(
    input: ClientStateEventRowsQuery
): Promise<readonly ClientStateEventRow[]> {
    return await input.sql<ClientStateEventRow[]>`
        select event_id, event_type, snapshot_version, occurred_at_epoch_ms,
               client_instance_id, session_id, event_json
        from client_state_events
        where application_id = ${input.ref.applicationId}
          and workspace_key = ${clientStateWorkspaceStorageKey(input.ref.workspaceId)}
          and principal_id = ${input.ref.principalId}
        order by snapshot_version, occurred_at_epoch_ms, event_id
        limit ${input.limit}
    `;
}

async function readClientPageRowsAfter(
    input: ClientStateEventRowsQuery
): Promise<readonly ClientStateEventRow[]> {
    const after = input.query.after;
    if (after === undefined) {
        throw new TypeError('Client event page cursor is required');
    }
    return await input.sql<ClientStateEventRow[]>`
        select event_id, event_type, snapshot_version, occurred_at_epoch_ms,
               client_instance_id, session_id, event_json
        from client_state_events
        where application_id = ${input.ref.applicationId}
          and workspace_key = ${clientStateWorkspaceStorageKey(input.ref.workspaceId)}
          and principal_id = ${input.ref.principalId}
          and (snapshot_version, occurred_at_epoch_ms, event_id) >
              (${after.snapshotVersion}, ${after.occurredAtEpochMs}, ${after.eventId})
        order by snapshot_version, occurred_at_epoch_ms, event_id
        limit ${input.limit}
    `;
}

async function readClientPageRowsForTypes(
    input: ClientStateEventRowsQuery,
    eventTypes: readonly string[]
): Promise<readonly ClientStateEventRow[]> {
    return await input.sql<ClientStateEventRow[]>`
        select event_id, event_type, snapshot_version, occurred_at_epoch_ms,
               client_instance_id, session_id, event_json
        from client_state_events
        where application_id = ${input.ref.applicationId}
          and workspace_key = ${clientStateWorkspaceStorageKey(input.ref.workspaceId)}
          and principal_id = ${input.ref.principalId}
          and event_type in ${input.sql(eventTypes)}
        order by snapshot_version, occurred_at_epoch_ms, event_id
        limit ${input.limit}
    `;
}

async function readClientPageRowsForTypesAfter(
    input: ClientStateEventRowsQuery,
    eventTypes: readonly string[]
): Promise<readonly ClientStateEventRow[]> {
    const after = input.query.after;
    if (after === undefined) {
        throw new TypeError('Client event page cursor is required');
    }
    return await input.sql<ClientStateEventRow[]>`
        select event_id, event_type, snapshot_version, occurred_at_epoch_ms,
               client_instance_id, session_id, event_json
        from client_state_events
        where application_id = ${input.ref.applicationId}
          and workspace_key = ${clientStateWorkspaceStorageKey(input.ref.workspaceId)}
          and principal_id = ${input.ref.principalId}
          and event_type in ${input.sql(eventTypes)}
          and (snapshot_version, occurred_at_epoch_ms, event_id) >
              (${after.snapshotVersion}, ${after.occurredAtEpochMs}, ${after.eventId})
        order by snapshot_version, occurred_at_epoch_ms, event_id
        limit ${input.limit}
    `;
}
