import type { GroupEvent, GroupRef } from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';

import type { GroupStateEventStore, GroupStateEventWrite } from './group-state-event-store.ts';
import { toValidatedGroupStateEvent } from './postgres/group-state-event-row-codec.ts';
import { listRecentStateEvents, listStateEventsPage, type StateEventListQuery } from './state-event-listing.ts';
import { compareStateEventOrder } from './state-event-ordering.ts';

export class InMemoryGroupStateEventStore implements GroupStateEventStore {
    private readonly events: GroupStateEventWrite[] = [];

    async appendGroupEvent(computed: GroupStateEventWrite): Promise<void> {
        const existing = this.events.find((candidate) => isSameGroupEventIdentity(candidate, computed));
        if (existing === undefined) {
            this.events.push({ ...computed });
            return;
        }
        if (
            existing.workspaceKey !== computed.workspaceKey ||
            existing.eventType !== computed.eventType ||
            existing.snapshotVersion !== computed.snapshotVersion ||
            existing.occurredAtEpochMs !== computed.occurredAtEpochMs ||
            existing.eventJson !== computed.eventJson
        ) {
            throw computed.collision;
        }
    }

    async readGroupEvent(ref: GroupRef, eventId: string): Promise<GroupEvent | undefined> {
        const event = this.events.find((candidate) =>
            isGroupEventForRef(candidate, ref) && candidate.eventId === eventId
        );
        return event === undefined ? undefined : decodeStoredGroupEvent(event, ref);
    }

    async listGroupEvents(ref: GroupRef): Promise<readonly GroupEvent[]> {
        return this.events
            .filter((event) => isGroupEventForRef(event, ref))
            .sort(compareStateEventOrder)
            .map((event) => decodeStoredGroupEvent(event, ref));
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

function decodeStoredGroupEvent(computed: GroupStateEventWrite, ref: GroupRef): GroupEvent {
    return toValidatedGroupStateEvent({
        event_id: computed.eventId,
        event_type: computed.eventType,
        snapshot_version: computed.snapshotVersion,
        occurred_at_epoch_ms: computed.occurredAtEpochMs,
        event_json: computed.eventJson
    }, ref);
}

function isGroupEventForRef(event: GroupRef, ref: GroupRef): boolean {
    return event.applicationId === ref.applicationId &&
        event.workspaceId === ref.workspaceId &&
        event.groupId === ref.groupId;
}

function isSameGroupEventIdentity(left: GroupStateEventWrite, right: GroupStateEventWrite): boolean {
    return isGroupEventForRef(left, right) && left.eventId === right.eventId;
}
