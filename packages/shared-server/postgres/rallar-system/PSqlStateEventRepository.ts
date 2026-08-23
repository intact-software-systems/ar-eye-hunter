import {
    decodePersistedClientEvent
} from '@shared-server/rallar-system/client-state/persistence/client-state-persistence-codec.ts';
import {
    clientStateWorkspaceStorageKey
} from '@shared-server/rallar-system/client-state/persistence/client-state-storage-keys.ts';
import {
    validatePersistedClientEvent
} from '@shared-server/rallar-system/client-state/persistence/validate-persisted-client-state.ts';
import {
    decodePersistedGroupEvent,
    validatePersistedGroupEvent
} from '@shared-server/rallar-system/group-state/persistence/persisted-group-event.ts';
import type { StateEventListQuery } from '@shared-server/rallar-system/state-events/state-event-listing.ts';
import { DEFAULT_STATE_EVENT_LIST_LIMIT } from '@shared-server/rallar-system/state-events/state-event-listing.ts';
import type {
    ClientStateEventStore,
    GroupStateEventStore
} from '@shared-server/rallar-system/state-events/state-event-store.ts';
import type { ClientEvent, ClientPrincipalRef } from '@shared/api/client-types.ts';
import type { GroupEvent, GroupRef } from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import type { PSqlSql } from '../p-sql-sql.ts';
import { groupEventWorkspaceKey } from './group-event-workspace-key.ts';

type ClientStateEventRow = Readonly<{
    event_id: string;
    event_type: string;
    snapshot_version: number | string;
    occurred_at_epoch_ms: number | string;
    client_instance_id: string | null;
    session_id: string | null;
    event_json: string;
}>;

type ClientStateEventCollisionRow =
    & ClientStateEventRow
    & Readonly<{
        application_id: string;
        workspace_key: string;
        principal_id: string;
    }>;

type GroupStateEventRow = Readonly<{
    event_id: string;
    event_type: string;
    snapshot_version: number | string;
    occurred_at_epoch_ms: number | string;
    event_json: string;
}>;

type GroupStateEventCollisionRow =
    & GroupStateEventRow
    & Readonly<{
        application_id: string;
        workspace_key: string;
        group_id: string;
    }>;

export class GroupStateEventCollisionError extends Error {
    readonly code = 'group-state-event-collision';
    readonly status = 409;

    readonly event: Pick<GroupEvent, 'applicationId' | 'workspaceId' | 'groupId' | 'eventId'>;

    constructor(
        event: Pick<GroupEvent, 'applicationId' | 'workspaceId' | 'groupId' | 'eventId'>
    ) {
        super(`Group state event already exists: ${event.eventId}`);
        this.event = event;
        this.name = 'GroupStateEventCollisionError';
    }
}

export class ClientStateEventCollisionError extends Error {
    readonly code = 'client-state-event-collision';
    readonly status = 409;

    readonly event: Pick<ClientEvent, 'applicationId' | 'workspaceId' | 'principalId' | 'eventId'>;

    constructor(
        event: Pick<ClientEvent, 'applicationId' | 'workspaceId' | 'principalId' | 'eventId'>
    ) {
        super(`Client state event already exists with divergent content: ${event.eventId}`);
        this.event = event;
        this.name = 'ClientStateEventCollisionError';
    }
}

export class PSqlClientStateEventRepository implements ClientStateEventStore {
    private readonly sql: PSqlSql;

    constructor(sql: PSqlSql) {
        this.sql = sql;
    }

    async appendClientEvent(event: ClientEvent): Promise<void> {
        assertCompleteClientEvent(event, event);
        const eventJson = JSON.stringify(event);
        const inserted = await this.sql<{ event_id: string; }[]>`
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
                    ${clientStateWorkspaceStorageKey(event.workspaceId)},
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
        if (inserted.length === 1) {
            return;
        }

        const [existing] = await this.sql<ClientStateEventCollisionRow[]>`
            select application_id, workspace_key, principal_id, event_id,
                   event_type, snapshot_version, occurred_at_epoch_ms,
                   client_instance_id, session_id, event_json
            from client_state_events
            where application_id = ${event.applicationId}
              and workspace_key = ${clientStateWorkspaceStorageKey(event.workspaceId)}
              and principal_id = ${event.principalId}
              and event_id = ${event.eventId}
        `;
        if (!existing || !isExactPersistedClientEvent(existing, event, eventJson)) {
            throw new ClientStateEventCollisionError(event);
        }
    }

    async listClientEvents(
        ref: ClientPrincipalRef
    ): Promise<readonly ClientEvent[]> {
        const rows = await this.sql<ClientStateEventRow[]>`
            select event_id, event_type, snapshot_version, occurred_at_epoch_ms,
                   client_instance_id, session_id, event_json
            from client_state_events
            where application_id = ${ref.applicationId}
              and workspace_key = ${clientStateWorkspaceStorageKey(ref.workspaceId)}
              and principal_id = ${ref.principalId}
            order by snapshot_version, occurred_at_epoch_ms, event_id
        `;

        return rows.map((row) => toValidatedClientEvent(row, ref));
    }

    async listRecentClientEvents(
        ref: ClientPrincipalRef,
        query: StateEventListQuery = {}
    ): Promise<readonly ClientEvent[]> {
        const limit = query.limit ?? DEFAULT_STATE_EVENT_LIST_LIMIT;
        const rows = await this.queryRecentClientRows(ref, query, limit);

        return rows.map((row) => toValidatedClientEvent(row, ref));
    }

    async listClientEventPage(
        ref: ClientPrincipalRef,
        query: StateEventListQuery = {}
    ): Promise<StateEventPage<ClientEvent>> {
        const limit = query.limit ?? DEFAULT_STATE_EVENT_LIST_LIMIT;
        const rows = await this.queryClientPageRows(ref, query, limit + 1);
        const eventsPlusOne = rows.map((row) => toValidatedClientEvent(row, ref));
        const events = eventsPlusOne.slice(0, limit);
        const lastEvent = events.at(-1);

        return {
            events,
            ...(lastEvent ? { nextCursor: toCursor(lastEvent) } : {}),
            hasMore: eventsPlusOne.length > limit
        };
    }

    private async queryClientPageRows(
        ref: ClientPrincipalRef,
        query: StateEventListQuery,
        limit: number
    ): Promise<ClientStateEventRow[]> {
        const eventTypes = query.eventTypes && query.eventTypes.length > 0
            ? query.eventTypes
            : undefined;
        const after = query.after;

        if (eventTypes && after) {
            return await this.sql<ClientStateEventRow[]>`
                select event_id, event_type, snapshot_version, occurred_at_epoch_ms,
                       client_instance_id, session_id, event_json
                from client_state_events
                where application_id = ${ref.applicationId}
                  and workspace_key = ${clientStateWorkspaceStorageKey(ref.workspaceId)}
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
                select event_id, event_type, snapshot_version, occurred_at_epoch_ms,
                       client_instance_id, session_id, event_json
                from client_state_events
                where application_id = ${ref.applicationId}
                  and workspace_key = ${clientStateWorkspaceStorageKey(ref.workspaceId)}
                  and principal_id = ${ref.principalId}
                  and event_type in ${this.sql(eventTypes)}
                order by snapshot_version, occurred_at_epoch_ms, event_id
                limit ${limit}
            `;
        }

        if (after) {
            return await this.sql<ClientStateEventRow[]>`
                select event_id, event_type, snapshot_version, occurred_at_epoch_ms,
                       client_instance_id, session_id, event_json
                from client_state_events
                where application_id = ${ref.applicationId}
                  and workspace_key = ${clientStateWorkspaceStorageKey(ref.workspaceId)}
                  and principal_id = ${ref.principalId}
                  and (snapshot_version, occurred_at_epoch_ms, event_id) >
                      (${after.snapshotVersion}, ${after.occurredAtEpochMs}, ${after.eventId})
                order by snapshot_version, occurred_at_epoch_ms, event_id
                limit ${limit}
            `;
        }

        return await this.sql<ClientStateEventRow[]>`
            select event_id, event_type, snapshot_version, occurred_at_epoch_ms,
                   client_instance_id, session_id, event_json
            from client_state_events
            where application_id = ${ref.applicationId}
              and workspace_key = ${clientStateWorkspaceStorageKey(ref.workspaceId)}
              and principal_id = ${ref.principalId}
            order by snapshot_version, occurred_at_epoch_ms, event_id
            limit ${limit}
        `;
    }

    private async queryRecentClientRows(
        ref: ClientPrincipalRef,
        query: StateEventListQuery,
        limit: number
    ): Promise<ClientStateEventRow[]> {
        const eventTypes = query.eventTypes && query.eventTypes.length > 0
            ? query.eventTypes
            : undefined;

        if (eventTypes) {
            return await this.sql<ClientStateEventRow[]>`
                select event_id, event_type, snapshot_version, occurred_at_epoch_ms,
                       client_instance_id, session_id, event_json
                from (
                    select event_json, event_type, snapshot_version,
                           occurred_at_epoch_ms, event_id, client_instance_id,
                           session_id
                    from client_state_events
                    where application_id = ${ref.applicationId}
                      and workspace_key = ${clientStateWorkspaceStorageKey(ref.workspaceId)}
                      and principal_id = ${ref.principalId}
                      and event_type in ${this.sql(eventTypes)}
                    order by snapshot_version desc, occurred_at_epoch_ms desc, event_id desc
                    limit ${limit}
                ) recent_events
                order by snapshot_version, occurred_at_epoch_ms, event_id
            `;
        }

        return await this.sql<ClientStateEventRow[]>`
            select event_id, event_type, snapshot_version, occurred_at_epoch_ms,
                   client_instance_id, session_id, event_json
            from (
                select event_json, event_type, snapshot_version,
                       occurred_at_epoch_ms, event_id, client_instance_id,
                       session_id
                from client_state_events
                where application_id = ${ref.applicationId}
                  and workspace_key = ${clientStateWorkspaceStorageKey(ref.workspaceId)}
                  and principal_id = ${ref.principalId}
                order by snapshot_version desc, occurred_at_epoch_ms desc, event_id desc
                limit ${limit}
            ) recent_events
            order by snapshot_version, occurred_at_epoch_ms, event_id
        `;
    }
}

export class PSqlGroupStateEventRepository implements GroupStateEventStore {
    private readonly sql: PSqlSql;

    constructor(sql: PSqlSql) {
        this.sql = sql;
    }

    async appendGroupEvent(event: GroupEvent): Promise<void> {
        assertCompleteGroupEvent(event, event);
        const eventJson = JSON.stringify(event);
        const inserted = await this.sql<{ event_id: string; }[]>`
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
                    ${eventJson})
            on conflict (application_id, workspace_key, group_id, event_id)
                do nothing
            returning event_id
        `;
        if (inserted.length === 1) {
            return;
        }

        const [existing] = await this.sql<GroupStateEventCollisionRow[]>`
            select application_id, workspace_key, group_id, event_id,
                   event_type, snapshot_version, occurred_at_epoch_ms, event_json
            from group_state_events
            where application_id = ${event.applicationId}
              and workspace_key = ${groupEventWorkspaceKey(event.workspaceId)}
              and group_id = ${event.groupId}
              and event_id = ${event.eventId}
        `;
        if (existing && isExactPersistedGroupEvent(existing, event, eventJson)) {
            return;
        }
        throw new GroupStateEventCollisionError(event);
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
        query: StateEventListQuery = {}
    ): Promise<readonly GroupEvent[]> {
        const limit = query.limit ?? DEFAULT_STATE_EVENT_LIST_LIMIT;
        const rows = await this.queryRecentGroupRows(ref, query, limit);

        return rows.map((row) => toValidatedGroupEvent(row, ref));
    }

    async listGroupEventPage(
        ref: GroupRef,
        query: StateEventListQuery = {}
    ): Promise<StateEventPage<GroupEvent>> {
        const limit = query.limit ?? DEFAULT_STATE_EVENT_LIST_LIMIT;
        const rows = await this.queryGroupPageRows(ref, query, limit + 1);
        const eventsPlusOne = rows.map((row) => toValidatedGroupEvent(row, ref));
        const events = eventsPlusOne.slice(0, limit);
        const lastEvent = events.at(-1);

        return {
            events,
            ...(lastEvent ? { nextCursor: toCursor(lastEvent) } : {}),
            hasMore: eventsPlusOne.length > limit
        };
    }

    private async queryGroupPageRows(
        ref: GroupRef,
        query: StateEventListQuery,
        limit: number
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
        limit: number
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

function isExactPersistedGroupEvent(
    row: GroupStateEventCollisionRow,
    event: GroupEvent,
    eventJson: string
): boolean {
    return row.application_id === event.applicationId &&
        row.workspace_key === groupEventWorkspaceKey(event.workspaceId) &&
        row.group_id === event.groupId &&
        row.event_id === event.eventId &&
        row.event_type === event.eventType &&
        Number(row.snapshot_version) === event.snapshotVersion &&
        Number(row.occurred_at_epoch_ms) === event.occurredAtEpochMs &&
        row.event_json === eventJson;
}

function isExactPersistedClientEvent(
    row: ClientStateEventCollisionRow,
    event: ClientEvent,
    eventJson: string
): boolean {
    return row.application_id === event.applicationId &&
        row.workspace_key === clientStateWorkspaceStorageKey(event.workspaceId) &&
        row.principal_id === event.principalId &&
        row.event_id === event.eventId &&
        row.event_type === event.eventType &&
        Number(row.snapshot_version) === event.snapshotVersion &&
        Number(row.occurred_at_epoch_ms) === event.occurredAtEpochMs &&
        row.client_instance_id === event.clientInstanceId &&
        row.session_id === event.sessionId &&
        row.event_json === eventJson;
}

export class ClientStateEventRepositoryInvariantCorruptionError extends Error {
    readonly code = 'client-state-event-repository-invariant-corruption';

    constructor(message: string) {
        super(message);
        this.name = 'ClientStateEventRepositoryInvariantCorruptionError';
    }
}

function toValidatedClientEvent(
    row: ClientStateEventRow,
    expected: ClientPrincipalRef
): ClientEvent {
    let event: ClientEvent;
    try {
        event = decodePersistedClientEvent(
            JSON.parse(row.event_json),
            expected
        );
    }
    catch (error) {
        throw new ClientStateEventRepositoryInvariantCorruptionError(
            error instanceof Error ? error.message : 'Stored client event JSON is invalid'
        );
    }
    if (
        event.applicationId !== expected.applicationId ||
        event.workspaceId !== expected.workspaceId ||
        event.principalId !== expected.principalId ||
        event.eventId !== row.event_id ||
        event.eventType !== row.event_type ||
        event.snapshotVersion !== Number(row.snapshot_version) ||
        event.occurredAtEpochMs !== Number(row.occurred_at_epoch_ms) ||
        event.clientInstanceId !== row.client_instance_id ||
        event.sessionId !== row.session_id
    ) {
        throw new ClientStateEventRepositoryInvariantCorruptionError(
            'Stored client event identity differs from its physical columns'
        );
    }
    return event;
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
    expected: GroupRef
): GroupEvent {
    let event: GroupEvent;
    try {
        const decoded: unknown = JSON.parse(row.event_json);
        event = decodePersistedGroupEvent(decoded, expected);
    }
    catch (error) {
        throw new GroupStateEventRepositoryInvariantCorruptionError(
            error instanceof Error ? error.message : 'Stored group event JSON is invalid'
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
            'Stored group event identity differs from the requested group'
        );
    }
    return event;
}

function assertCompleteClientEvent(
    event: unknown,
    expected: ClientPrincipalRef
): asserts event is ClientEvent {
    try {
        validatePersistedClientEvent(event, expected);
    }
    catch (error) {
        throw new ClientStateEventRepositoryInvariantCorruptionError(
            error instanceof Error ? error.message : 'Stored client event is invalid'
        );
    }
}

function assertCompleteGroupEvent(event: unknown, expected: GroupRef): asserts event is GroupEvent {
    try {
        validatePersistedGroupEvent(event, expected);
    }
    catch (error) {
        throw new GroupStateEventRepositoryInvariantCorruptionError(
            error instanceof Error ? error.message : 'Stored group event is invalid'
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
        eventId: event.eventId
    };
}
