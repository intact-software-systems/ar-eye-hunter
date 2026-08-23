import type { ClientEvent, ClientPrincipalRef } from '@shared/api/client-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';

import { ClientStateEventCollisionError, type ClientStateEventStore } from './client-state-event-store.ts';
import { listRecentStateEvents, listStateEventsPage, type StateEventListQuery } from './state-event-listing.ts';
import { compareStateEventOrder } from './state-event-ordering.ts';

export class InMemoryClientStateEventStore implements ClientStateEventStore {
    private readonly events: ClientEvent[] = [];

    async appendClientEvent(event: ClientEvent): Promise<void> {
        const existing = this.events.find((candidate) => isSameClientEventIdentity(candidate, event));
        if (existing === undefined) {
            this.events.push(event);
            return;
        }
        if (JSON.stringify(existing) !== JSON.stringify(event)) {
            throw new ClientStateEventCollisionError(event);
        }
    }

    async listClientEvents(ref: ClientPrincipalRef): Promise<readonly ClientEvent[]> {
        return this.events
            .filter((event) => isClientEventForRef(event, ref))
            .sort(compareStateEventOrder);
    }

    async listRecentClientEvents(
        ref: ClientPrincipalRef,
        query: StateEventListQuery = {}
    ): Promise<readonly ClientEvent[]> {
        return listRecentStateEvents(await this.listClientEvents(ref), query);
    }

    async listClientEventPage(
        ref: ClientPrincipalRef,
        query: StateEventListQuery = {}
    ): Promise<StateEventPage<ClientEvent>> {
        return listStateEventsPage(await this.listClientEvents(ref), query);
    }
}

function isClientEventForRef(event: ClientEvent, ref: ClientPrincipalRef): boolean {
    return event.applicationId === ref.applicationId &&
        event.workspaceId === ref.workspaceId &&
        event.principalId === ref.principalId;
}

function isSameClientEventIdentity(left: ClientEvent, right: ClientEvent): boolean {
    return isClientEventForRef(left, right) && left.eventId === right.eventId;
}
