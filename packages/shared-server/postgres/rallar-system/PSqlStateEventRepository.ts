import type { ClientEvent, ClientPrincipalRef } from '@shared/api/client-types.ts';
import type { GroupEvent, GroupRef } from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import type {
    ClientStateEventStore,
    GroupStateEventStore,
} from '@shared-server/rallar-system/repositories/StateEventStore.ts';
import type { StateEventListQuery } from '@shared-server/rallar-system/state-event-listing.ts';
import { DEFAULT_STATE_EVENT_LIST_LIMIT } from '@shared-server/rallar-system/state-event-listing.ts';
import type { PSqlSql } from '../PostgresSqlClient.ts';
import { groupEventWorkspaceKey } from './group-event-workspace-key.ts';
import { validatePersistedGroupEvent } from '@shared-server/rallar-system/services/group-state-mutations.ts';

type ClientStateEventRow = Readonly<{
    event_json: string;
}>;

type GroupStateEventRow = Readonly<{
    event_id: string;
    event_type: string;
    snapshot_version: number | string;
    occurred_at_epoch_ms: number | string;
    event_json: string;
}>;

const DEFAULT_WORKSPACE_KEY = '_';

export class GroupStateEventCollisionError extends Error {
    readonly code = 'group-state-event-collision';
    readonly status = 409;

    constructor(
        readonly event: Pick<
            GroupEvent,
            'applicationId' | 'workspaceId' | 'groupId' | 'eventId'
        >,
    ) {
        super(`Group state event already exists: ${event.eventId}`);
        this.name = 'GroupStateEventCollisionError';
    }
}

export class PSqlClientStateEventRepository implements ClientStateEventStore {
    constructor(private readonly sql: PSqlSql) {}

    async appendClientEvent(event: ClientEvent): Promise<void> {
        await this.sql`
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
                    ${toWorkspaceKey(event.workspaceId)},
                    ${event.principalId},
                    ${event.eventId},
                    ${event.eventType},
                    ${event.snapshotVersion},
                    ${event.occurredAtEpochMs},
                    ${event.clientInstanceId ?? null},
                    ${event.sessionId ?? null},
                    ${JSON.stringify(event)})
            on conflict (application_id, workspace_key, principal_id, event_id)
                do nothing
        `;
    }

    async listClientEvents(
        ref: ClientPrincipalRef,
    ): Promise<readonly ClientEvent[]> {
        const rows = await this.sql<ClientStateEventRow[]>`
            select event_json
            from client_state_events
            where application_id = ${ref.applicationId}
              and workspace_key = ${toWorkspaceKey(ref.workspaceId)}
              and principal_id = ${ref.principalId}
            order by snapshot_version, occurred_at_epoch_ms, event_id
        `;

        return rows.map(toClientEvent);
    }

    async listRecentClientEvents(
        ref: ClientPrincipalRef,
        query: StateEventListQuery = {},
    ): Promise<readonly ClientEvent[]> {
        const limit = query.limit ?? DEFAULT_STATE_EVENT_LIST_LIMIT;
        const rows = await this.queryRecentClientRows(ref, query, limit);

        return rows.map(toClientEvent);
    }

    async listClientEventPage(
        ref: ClientPrincipalRef,
        query: StateEventListQuery = {},
    ): Promise<StateEventPage<ClientEvent>> {
        const limit = query.limit ?? DEFAULT_STATE_EVENT_LIST_LIMIT;
        const rows = await this.queryClientPageRows(ref, query, limit + 1);
        const eventsPlusOne = rows.map(toClientEvent);
        const events = eventsPlusOne.slice(0, limit);
        const lastEvent = events.at(-1);

        return {
            events,
            ...(lastEvent ? { nextCursor: toCursor(lastEvent) } : {}),
            hasMore: eventsPlusOne.length > limit,
        };
    }

    private async queryClientPageRows(
        ref: ClientPrincipalRef,
        query: StateEventListQuery,
        limit: number,
    ): Promise<ClientStateEventRow[]> {
        const eventTypes = query.eventTypes && query.eventTypes.length > 0
            ? query.eventTypes
            : undefined;
        const after = query.after;

        if (eventTypes && after) {
            return await this.sql<ClientStateEventRow[]>`
                select event_json
                from client_state_events
                where application_id = ${ref.applicationId}
                  and workspace_key = ${toWorkspaceKey(ref.workspaceId)}
                  and principal_id = ${ref.principalId}
                  and event_type in ${this.sql(eventTypes)}
                  and (snapshot_version, occurred_at_epoch_ms, event_id) >
                      (${after.snapshotVersion}, ${after.occurredAtEpochMs}, ${after.eventId})
                order by snapshot_version, occurred_at_epoch_ms, event_id
                limit ${limit}
            `;
        }

        if (eventTypes) {
            return await this.sql<ClientStateEventRow[]>`
                select event_json
                from client_state_events
                where application_id = ${ref.applicationId}
                  and workspace_key = ${toWorkspaceKey(ref.workspaceId)}
                  and principal_id = ${ref.principalId}
                  and event_type in ${this.sql(eventTypes)}
                order by snapshot_version, occurred_at_epoch_ms, event_id
                limit ${limit}
            `;
        }

        if (after) {
            return await this.sql<ClientStateEventRow[]>`
                select event_json
                from client_state_events
                where application_id = ${ref.applicationId}
                  and workspace_key = ${toWorkspaceKey(ref.workspaceId)}
                  and principal_id = ${ref.principalId}
                  and (snapshot_version, occurred_at_epoch_ms, event_id) >
                      (${after.snapshotVersion}, ${after.occurredAtEpochMs}, ${after.eventId})
                order by snapshot_version, occurred_at_epoch_ms, event_id
                limit ${limit}
            `;
        }

        return await this.sql<ClientStateEventRow[]>`
            select event_json
            from client_state_events
            where application_id = ${ref.applicationId}
              and workspace_key = ${toWorkspaceKey(ref.workspaceId)}
              and principal_id = ${ref.principalId}
            order by snapshot_version, occurred_at_epoch_ms, event_id
            limit ${limit}
        `;
    }

    private async queryRecentClientRows(
        ref: ClientPrincipalRef,
        query: StateEventListQuery,
        limit: number,
    ): Promise<ClientStateEventRow[]> {
        const eventTypes = query.eventTypes && query.eventTypes.length > 0
            ? query.eventTypes
            : undefined;

        if (eventTypes) {
            return await this.sql<ClientStateEventRow[]>`
                select event_json
                from (
                    select event_json, snapshot_version, occurred_at_epoch_ms, event_id
                    from client_state_events
                    where application_id = ${ref.applicationId}
                      and workspace_key = ${toWorkspaceKey(ref.workspaceId)}
                      and principal_id = ${ref.principalId}
                      and event_type in ${this.sql(eventTypes)}
                    order by snapshot_version desc, occurred_at_epoch_ms desc, event_id desc
                    limit ${limit}
                ) recent_events
                order by snapshot_version, occurred_at_epoch_ms, event_id
            `;
        }

        return await this.sql<ClientStateEventRow[]>`
            select event_json
            from (
                select event_json, snapshot_version, occurred_at_epoch_ms, event_id
                from client_state_events
                where application_id = ${ref.applicationId}
                  and workspace_key = ${toWorkspaceKey(ref.workspaceId)}
                  and principal_id = ${ref.principalId}
                order by snapshot_version desc, occurred_at_epoch_ms desc, event_id desc
                limit ${limit}
            ) recent_events
            order by snapshot_version, occurred_at_epoch_ms, event_id
        `;
    }
}

export class PSqlGroupStateEventRepository implements GroupStateEventStore {
    constructor(private readonly sql: PSqlSql) {}

    async appendGroupEvent(event: GroupEvent): Promise<void> {
        assertCompleteGroupEvent(event, event);
        const inserted = await this.sql<{ event_id: string }[]>`
            insert into group_state_events (application_id,
                                            workspace_key,
                                            group_id,
                                            event_id,
                                            event_type,
                                            snapshot_version,
                                            occurred_at_epoch_ms,
                                            event_json)
            values (${event.applicationId},
                    ${groupEventWorkspaceKey(event.workspaceId)},
                    ${event.groupId},
                    ${event.eventId},
                    ${event.eventType},
                    ${event.snapshotVersion},
                    ${event.occurredAtEpochMs},
                    ${JSON.stringify(event)})
            on conflict (application_id, workspace_key, group_id, event_id)
                do nothing
            returning event_id
        `;
        if (inserted.length !== 1) {
            throw new GroupStateEventCollisionError(event);
        }
    }

    async listGroupEvents(ref: GroupRef): Promise<readonly GroupEvent[]> {
        const rows = await this.sql<GroupStateEventRow[]>`
            select event_id, event_type, snapshot_version, occurred_at_epoch_ms, event_json
            from group_state_events
            where application_id = ${ref.applicationId}
              and workspace_key = ${groupEventWorkspaceKey(ref.workspaceId)}
              and group_id = ${ref.groupId}
            order by snapshot_version, occurred_at_epoch_ms, event_id
        `;

        return rows.map((row) => toValidatedGroupEvent(row, ref));
    }

    async listRecentGroupEvents(
        ref: GroupRef,
        query: StateEventListQuery = {},
    ): Promise<readonly GroupEvent[]> {
        const limit = query.limit ?? DEFAULT_STATE_EVENT_LIST_LIMIT;
        const rows = await this.queryRecentGroupRows(ref, query, limit);

        return rows.map((row) => toValidatedGroupEvent(row, ref));
    }

    async listGroupEventPage(
        ref: GroupRef,
        query: StateEventListQuery = {},
    ): Promise<StateEventPage<GroupEvent>> {
        const limit = query.limit ?? DEFAULT_STATE_EVENT_LIST_LIMIT;
        const rows = await this.queryGroupPageRows(ref, query, limit + 1);
        const eventsPlusOne = rows.map((row) => toValidatedGroupEvent(row, ref));
        const events = eventsPlusOne.slice(0, limit);
        const lastEvent = events.at(-1);

        return {
            events,
            ...(lastEvent ? { nextCursor: toCursor(lastEvent) } : {}),
            hasMore: eventsPlusOne.length > limit,
        };
    }

    private async queryGroupPageRows(
        ref: GroupRef,
        query: StateEventListQuery,
        limit: number,
    ): Promise<GroupStateEventRow[]> {
        const eventTypes = query.eventTypes && query.eventTypes.length > 0
            ? query.eventTypes
            : undefined;
        const after = query.after;

        if (eventTypes && after) {
            return await this.sql<GroupStateEventRow[]>`
                select event_id, event_type, snapshot_version, occurred_at_epoch_ms, event_json
                from group_state_events
                where application_id = ${ref.applicationId}
                  and workspace_key = ${groupEventWorkspaceKey(ref.workspaceId)}
                  and group_id = ${ref.groupId}
                  and event_type in ${this.sql(eventTypes)}
                  and (snapshot_version, occurred_at_epoch_ms, event_id) >
                      (${after.snapshotVersion}, ${after.occurredAtEpochMs}, ${after.eventId})
                order by snapshot_version, occurred_at_epoch_ms, event_id
                limit ${limit}
            `;
        }

        if (eventTypes) {
            return await this.sql<GroupStateEventRow[]>`
                select event_id, event_type, snapshot_version, occurred_at_epoch_ms, event_json
                from group_state_events
                where application_id = ${ref.applicationId}
                  and workspace_key = ${groupEventWorkspaceKey(ref.workspaceId)}
                  and group_id = ${ref.groupId}
                  and event_type in ${this.sql(eventTypes)}
                order by snapshot_version, occurred_at_epoch_ms, event_id
                limit ${limit}
            `;
        }

        if (after) {
            return await this.sql<GroupStateEventRow[]>`
                select event_id, event_type, snapshot_version, occurred_at_epoch_ms, event_json
                from group_state_events
                where application_id = ${ref.applicationId}
                  and workspace_key = ${groupEventWorkspaceKey(ref.workspaceId)}
                  and group_id = ${ref.groupId}
                  and (snapshot_version, occurred_at_epoch_ms, event_id) >
                      (${after.snapshotVersion}, ${after.occurredAtEpochMs}, ${after.eventId})
                order by snapshot_version, occurred_at_epoch_ms, event_id
                limit ${limit}
            `;
        }

        return await this.sql<GroupStateEventRow[]>`
            select event_id, event_type, snapshot_version, occurred_at_epoch_ms, event_json
            from group_state_events
            where application_id = ${ref.applicationId}
              and workspace_key = ${groupEventWorkspaceKey(ref.workspaceId)}
              and group_id = ${ref.groupId}
            order by snapshot_version, occurred_at_epoch_ms, event_id
            limit ${limit}
        `;
    }

    private async queryRecentGroupRows(
        ref: GroupRef,
        query: StateEventListQuery,
        limit: number,
    ): Promise<GroupStateEventRow[]> {
        const eventTypes = query.eventTypes && query.eventTypes.length > 0
            ? query.eventTypes
            : undefined;

        if (eventTypes) {
            return await this.sql<GroupStateEventRow[]>`
                select event_id, event_type, snapshot_version, occurred_at_epoch_ms, event_json
                from (
                    select event_json, event_type, snapshot_version, occurred_at_epoch_ms, event_id
                    from group_state_events
                    where application_id = ${ref.applicationId}
                      and workspace_key = ${groupEventWorkspaceKey(ref.workspaceId)}
                      and group_id = ${ref.groupId}
                      and event_type in ${this.sql(eventTypes)}
                    order by snapshot_version desc, occurred_at_epoch_ms desc, event_id desc
                    limit ${limit}
                ) recent_events
                order by snapshot_version, occurred_at_epoch_ms, event_id
            `;
        }

        return await this.sql<GroupStateEventRow[]>`
            select event_id, event_type, snapshot_version, occurred_at_epoch_ms, event_json
            from (
                select event_json, event_type, snapshot_version, occurred_at_epoch_ms, event_id
                from group_state_events
                where application_id = ${ref.applicationId}
                  and workspace_key = ${groupEventWorkspaceKey(ref.workspaceId)}
                  and group_id = ${ref.groupId}
                order by snapshot_version desc, occurred_at_epoch_ms desc, event_id desc
                limit ${limit}
            ) recent_events
            order by snapshot_version, occurred_at_epoch_ms, event_id
        `;
    }
}

function toWorkspaceKey(workspaceId: string | undefined): string {
    return workspaceId ?? DEFAULT_WORKSPACE_KEY;
}

function toClientEvent(row: ClientStateEventRow): ClientEvent {
    return JSON.parse(row.event_json) as ClientEvent;
}

function toGroupEvent(row: GroupStateEventRow): GroupEvent {
    return JSON.parse(row.event_json) as GroupEvent;
}

export class GroupStateEventRepositoryInvariantCorruptionError extends Error {
    readonly code = 'group-state-event-repository-invariant-corruption';

    constructor(message: string) {
        super(message);
        this.name = 'GroupStateEventRepositoryInvariantCorruptionError';
    }
}

function toValidatedGroupEvent(
    row: GroupStateEventRow,
    expected: GroupRef,
): GroupEvent {
    let event: GroupEvent;
    try {
        event = toGroupEvent(row);
        validatePersistedGroupEvent(event, expected);
    } catch (error) {
        throw new GroupStateEventRepositoryInvariantCorruptionError(
            error instanceof Error ? error.message : 'Stored group event JSON is invalid',
        );
    }
    if (
        event.applicationId !== expected.applicationId ||
        event.workspaceId !== expected.workspaceId ||
        event.groupId !== expected.groupId ||
        event.eventId !== row.event_id ||
        event.eventType !== row.event_type ||
        event.snapshotVersion !== Number(row.snapshot_version) ||
        event.occurredAtEpochMs !== Number(row.occurred_at_epoch_ms)
    ) {
        throw new GroupStateEventRepositoryInvariantCorruptionError(
            'Stored group event identity differs from the requested group',
        );
    }
    return event;
}

function assertCompleteGroupEvent(event: unknown, expected: GroupRef): asserts event is GroupEvent {
    try {
        validatePersistedGroupEvent(event, expected);
    } catch (error) {
        throw new GroupStateEventRepositoryInvariantCorruptionError(
            error instanceof Error ? error.message : 'Stored group event is invalid',
        );
    }
}

function toCursor(event: {
    snapshotVersion: number;
    occurredAtEpochMs: number;
    eventId: string;
}) {
    return {
        snapshotVersion: event.snapshotVersion,
        occurredAtEpochMs: event.occurredAtEpochMs,
        eventId: event.eventId,
    };
}
