import type { GroupEvent, GroupRef } from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';

import type { StateEventListQuery } from './state-event-listing.ts';

export interface GroupStateEventStore {
    appendGroupEvent(event: GroupEvent): Promise<void>;
    readGroupEvent(ref: GroupRef, eventId: string): Promise<GroupEvent | undefined>;
    listGroupEvents(ref: GroupRef): Promise<readonly GroupEvent[]>;
    listRecentGroupEvents(
        ref: GroupRef,
        query?: StateEventListQuery
    ): Promise<readonly GroupEvent[]>;
    listGroupEventPage(
        ref: GroupRef,
        query?: StateEventListQuery
    ): Promise<StateEventPage<GroupEvent>>;
}

export class GroupStateEventCollisionError extends Error {
    readonly code = 'group-state-event-collision';
    readonly status = 409;

    readonly event: Pick<GroupEvent, 'applicationId' | 'workspaceId' | 'groupId' | 'eventId'>;

    constructor(
        event: Pick<GroupEvent, 'applicationId' | 'workspaceId' | 'groupId' | 'eventId'>
    ) {
        super(`Group state event already exists with divergent content: ${event.eventId}`);
        this.event = event;
        this.name = 'GroupStateEventCollisionError';
    }
}
