import type { StateEventCursor } from '@shared/api/state-event-types.ts';

export interface StateEventOrder {
    readonly snapshotVersion: number;
    readonly occurredAtEpochMs: number;
    readonly eventId: string;
}

export function compareStateEventOrder(left: StateEventOrder, right: StateEventOrder): number {
    return left.snapshotVersion - right.snapshotVersion ||
        left.occurredAtEpochMs - right.occurredAtEpochMs ||
        left.eventId.localeCompare(right.eventId);
}

export function toStateEventCursor(event: StateEventOrder): StateEventCursor {
    return {
        snapshotVersion: event.snapshotVersion,
        occurredAtEpochMs: event.occurredAtEpochMs,
        eventId: event.eventId
    };
}
