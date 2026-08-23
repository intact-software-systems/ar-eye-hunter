import type { ClientEvent, ClientPrincipalRef } from '@shared/api/client-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';

import type { StateEventListQuery } from './state-event-listing.ts';

export interface ClientStateEventStore {
    appendClientEvent(event: ClientEvent): Promise<void>;
    listClientEvents(ref: ClientPrincipalRef): Promise<readonly ClientEvent[]>;
    listRecentClientEvents(
        ref: ClientPrincipalRef,
        query?: StateEventListQuery
    ): Promise<readonly ClientEvent[]>;
    listClientEventPage(
        ref: ClientPrincipalRef,
        query?: StateEventListQuery
    ): Promise<StateEventPage<ClientEvent>>;
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
