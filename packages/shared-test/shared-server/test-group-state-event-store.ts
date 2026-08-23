import {
    GroupStateEventCollisionError,
    type GroupStateEventStore
} from '@shared-server/rallar-system/state-events/group-state-event-store.ts';
import {
    listRecentStateEvents,
    listStateEventsPage,
    type StateEventListQuery
} from '@shared-server/rallar-system/state-events/state-event-listing.ts';
import { compareStateEventOrder } from '@shared-server/rallar-system/state-events/state-event-ordering.ts';
import type { GroupEvent, GroupRef } from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';

export class TestGroupStateEventStore implements GroupStateEventStore {
    readonly events: GroupEvent[] = [];

    async appendGroupEvent(event: GroupEvent): Promise<void> {
        const existing = this.events.find((candidate) => isSameEventIdentity(candidate, event));
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
            .filter((event) => isEventForRef(event, ref))
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

function isEventForRef(event: GroupEvent, ref: GroupRef): boolean {
    return event.applicationId === ref.applicationId &&
        event.workspaceId === ref.workspaceId &&
        event.groupId === ref.groupId;
}

function isSameEventIdentity(left: GroupEvent, right: GroupEvent): boolean {
    return isEventForRef(left, right) && left.eventId === right.eventId;
}
