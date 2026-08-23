import type { GroupEvent, GroupRef } from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';

import { GroupStateEventCollisionError, type GroupStateEventStore } from './group-state-event-store.ts';
import { listRecentStateEvents, listStateEventsPage, type StateEventListQuery } from './state-event-listing.ts';
import { compareStateEventOrder } from './state-event-ordering.ts';

export class InMemoryGroupStateEventStore implements GroupStateEventStore {
    private readonly events: GroupEvent[] = [];

    async appendGroupEvent(event: GroupEvent): Promise<void> {
        const existing = this.events.find((candidate) => isSameGroupEventIdentity(candidate, event));
        if (existing === undefined) {
            this.events.push(event);
            return;
        }
        if (JSON.stringify(existing) !== JSON.stringify(event)) {
            throw new GroupStateEventCollisionError(event);
        }
    }

    async listGroupEvents(ref: GroupRef): Promise<readonly GroupEvent[]> {
        return this.events
            .filter((event) => isGroupEventForRef(event, ref))
            .sort(compareStateEventOrder);
    }

    async listRecentGroupEvents(
        ref: GroupRef,
        query: StateEventListQuery = {}
    ): Promise<readonly GroupEvent[]> {
        return listRecentStateEvents(await this.listGroupEvents(ref), query);
    }

    async listGroupEventPage(
        ref: GroupRef,
        query: StateEventListQuery = {}
    ): Promise<StateEventPage<GroupEvent>> {
        return listStateEventsPage(await this.listGroupEvents(ref), query);
    }
}

function isGroupEventForRef(event: GroupEvent, ref: GroupRef): boolean {
    return event.applicationId === ref.applicationId &&
        event.workspaceId === ref.workspaceId &&
        event.groupId === ref.groupId;
}

function isSameGroupEventIdentity(left: GroupEvent, right: GroupEvent): boolean {
    return isGroupEventForRef(left, right) && left.eventId === right.eventId;
}
