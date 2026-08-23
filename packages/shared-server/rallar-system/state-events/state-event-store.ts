import type { ClientEvent, ClientPrincipalRef } from '@shared/api/client-types.ts';
import type { GroupEvent, GroupRef } from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import type { RuntimeStateRepositoryLike } from '../../runtime-state/RuntimeStateRepository.ts';
import { listRecentStateEvents, listStateEventsPage, type StateEventListQuery } from './state-event-listing.ts';

export type ClientStateEventStore = Readonly<{
    appendClientEvent(event: ClientEvent): Promise<void>;
    listClientEvents(ref: ClientPrincipalRef): Promise<readonly ClientEvent[]>;
    listRecentClientEvents?(
        ref: ClientPrincipalRef,
        query: StateEventListQuery
    ): Promise<readonly ClientEvent[]>;
    listClientEventPage(
        ref: ClientPrincipalRef,
        query: StateEventListQuery
    ): Promise<StateEventPage<ClientEvent>>;
}>;

export type GroupStateEventStore = Readonly<{
    appendGroupEvent(event: GroupEvent): Promise<void>;
    listGroupEvents(ref: GroupRef): Promise<readonly GroupEvent[]>;
    listRecentGroupEvents?(
        ref: GroupRef,
        query: StateEventListQuery
    ): Promise<readonly GroupEvent[]>;
    listGroupEventPage(
        ref: GroupRef,
        query: StateEventListQuery
    ): Promise<StateEventPage<GroupEvent>>;
}>;

export class InMemoryClientStateEventStore implements ClientStateEventStore {
    readonly events: ClientEvent[] = [];
    appendEventCalls = 0;
    listEventsCalls = 0;
    listRecentEventsCalls = 0;
    listEventPageCalls = 0;

    async appendClientEvent(event: ClientEvent): Promise<void> {
        this.appendEventCalls += 1;
        const existingIndex = this.events.findIndex((candidate) => isSameClientEvent(candidate, event));
        if (existingIndex >= 0) {
            return;
        }

        this.events.push(event);
    }

    async listClientEvents(
        ref: ClientPrincipalRef
    ): Promise<readonly ClientEvent[]> {
        this.listEventsCalls += 1;
        return this.events
            .filter((event) => isClientEventForRef(event, ref))
            .sort(compareStateEventsForReplay);
    }

    async listRecentClientEvents(
        ref: ClientPrincipalRef,
        query: StateEventListQuery = {}
    ): Promise<readonly ClientEvent[]> {
        this.listRecentEventsCalls += 1;
        return listRecentStateEvents(
            this.events
                .filter((event) => isClientEventForRef(event, ref))
                .sort(compareStateEventsForReplay),
            query
        );
    }

    async listClientEventPage(
        ref: ClientPrincipalRef,
        query: StateEventListQuery = {}
    ): Promise<StateEventPage<ClientEvent>> {
        this.listEventPageCalls += 1;
        return listStateEventsPage(
            this.events
                .filter((event) => isClientEventForRef(event, ref))
                .sort(compareStateEventsForReplay),
            query
        );
    }
}

export class InMemoryGroupStateEventStore implements GroupStateEventStore {
    readonly events: GroupEvent[] = [];
    appendEventCalls = 0;
    listEventsCalls = 0;
    listRecentEventsCalls = 0;
    listEventPageCalls = 0;

    async appendGroupEvent(event: GroupEvent): Promise<void> {
        this.appendEventCalls += 1;
        const existingIndex = this.events.findIndex((candidate) => isSameGroupEvent(candidate, event));
        if (existingIndex >= 0) {
            return;
        }

        this.events.push(event);
    }

    async listGroupEvents(ref: GroupRef): Promise<readonly GroupEvent[]> {
        this.listEventsCalls += 1;
        return this.events
            .filter((event) => isGroupEventForRef(event, ref))
            .sort(compareStateEventsForReplay);
    }

    async listRecentGroupEvents(
        ref: GroupRef,
        query: StateEventListQuery = {}
    ): Promise<readonly GroupEvent[]> {
        this.listRecentEventsCalls += 1;
        return listRecentStateEvents(
            this.events
                .filter((event) => isGroupEventForRef(event, ref))
                .sort(compareStateEventsForReplay),
            query
        );
    }

    async listGroupEventPage(
        ref: GroupRef,
        query: StateEventListQuery = {}
    ): Promise<StateEventPage<GroupEvent>> {
        this.listEventPageCalls += 1;
        return listStateEventsPage(
            this.events
                .filter((event) => isGroupEventForRef(event, ref))
                .sort(compareStateEventsForReplay),
            query
        );
    }
}

const defaultClientEventStores = new WeakMap<RuntimeStateRepositoryLike, InMemoryClientStateEventStore>();
const defaultGroupEventStores = new WeakMap<RuntimeStateRepositoryLike, InMemoryGroupStateEventStore>();

export function defaultClientStateEventStoreFor(
    repository: RuntimeStateRepositoryLike
): InMemoryClientStateEventStore {
    const existing = defaultClientEventStores.get(repository);
    if (existing) {
        return existing;
    }

    const created = new InMemoryClientStateEventStore();
    defaultClientEventStores.set(repository, created);
    return created;
}

export function defaultGroupStateEventStoreFor(
    repository: RuntimeStateRepositoryLike
): InMemoryGroupStateEventStore {
    const existing = defaultGroupEventStores.get(repository);
    if (existing) {
        return existing;
    }

    const created = new InMemoryGroupStateEventStore();
    defaultGroupEventStores.set(repository, created);
    return created;
}

export function compareStateEventsForReplay(
    left: { snapshotVersion: number; occurredAtEpochMs: number; eventId: string; },
    right: { snapshotVersion: number; occurredAtEpochMs: number; eventId: string; }
): number {
    return left.snapshotVersion - right.snapshotVersion ||
        left.occurredAtEpochMs - right.occurredAtEpochMs ||
        left.eventId.localeCompare(right.eventId);
}

function isClientEventForRef(
    event: ClientEvent,
    ref: ClientPrincipalRef
): boolean {
    return event.applicationId === ref.applicationId &&
        event.workspaceId === ref.workspaceId &&
        event.principalId === ref.principalId;
}

function isGroupEventForRef(event: GroupEvent, ref: GroupRef): boolean {
    return event.applicationId === ref.applicationId &&
        event.workspaceId === ref.workspaceId &&
        event.groupId === ref.groupId;
}

function isSameClientEvent(left: ClientEvent, right: ClientEvent): boolean {
    return isClientEventForRef(left, right) && left.eventId === right.eventId;
}

function isSameGroupEvent(left: GroupEvent, right: GroupEvent): boolean {
    return isGroupEventForRef(left, right) && left.eventId === right.eventId;
}
