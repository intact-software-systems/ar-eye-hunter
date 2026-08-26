import type { StateEventCursor, StateEventPage } from '@shared/api/state-event-types.ts';

import { compareStateEventOrder, toStateEventCursor } from './state-event-ordering.ts';

export interface StateEventListQuery {
    readonly eventTypes?: readonly string[];
    readonly limit?: number;
    readonly after?: StateEventCursor;
}

export interface StateEventListable {
    readonly eventId: string;
    readonly eventType: string;
    readonly snapshotVersion: number;
    readonly occurredAtEpochMs: number;
}

export const DEFAULT_STATE_EVENT_LIST_LIMIT = 100;
export const MAX_STATE_EVENT_LIST_LIMIT = 500;

export function readStateEventListQuery(
    searchParams: URLSearchParams
): StateEventListQuery {
    const eventTypes = searchParams.getAll('eventType')
        .map((eventType) => eventType.trim())
        .filter((eventType) => eventType.length > 0);
    const limit = toEventListLimit(searchParams.get('limit'));
    const after = toStateEventCursorQuery(searchParams);

    return {
        ...(eventTypes.length > 0 ? { eventTypes } : {}),
        limit,
        ...(after ? { after } : {})
    };
}

export function listRecentStateEvents<TEvent extends StateEventListable>(
    events: readonly TEvent[],
    query: StateEventListQuery = {}
): readonly TEvent[] {
    const eventTypes = query.eventTypes && query.eventTypes.length > 0
        ? new Set<string>(query.eventTypes)
        : undefined;
    const filtered = eventTypes
        ? events.filter((event) => eventTypes.has(event.eventType))
        : [...events];
    const limit = query.limit ?? DEFAULT_STATE_EVENT_LIST_LIMIT;

    return filtered.slice(-limit);
}

export function listStateEventsPage<TEvent extends StateEventListable>(
    events: readonly TEvent[],
    query: StateEventListQuery = {}
): StateEventPage<TEvent> {
    const eventTypes = query.eventTypes && query.eventTypes.length > 0
        ? new Set<string>(query.eventTypes)
        : undefined;
    const filtered = eventTypes
        ? events.filter((event) => eventTypes.has(event.eventType))
        : [...events];
    const after = query.after;
    const eventsAfterCursor = after
        ? filtered.filter((event) => compareStateEventOrder(event, after) > 0)
        : filtered;
    const limit = query.limit ?? DEFAULT_STATE_EVENT_LIST_LIMIT;
    const eventsPlusOne = eventsAfterCursor.slice(0, limit + 1);
    const pageEvents = eventsPlusOne.slice(0, limit);
    const lastEvent = pageEvents.at(-1);

    return {
        events: pageEvents,
        ...(lastEvent ? { nextCursor: toStateEventCursor(lastEvent) } : {}),
        hasMore: eventsPlusOne.length > limit
    };
}

function toEventListLimit(value: string | null): number {
    if (value === null || value.trim() === '') {
        return DEFAULT_STATE_EVENT_LIST_LIMIT;
    }

    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        return DEFAULT_STATE_EVENT_LIST_LIMIT;
    }

    return Math.min(parsed, MAX_STATE_EVENT_LIST_LIMIT);
}

function toStateEventCursorQuery(
    searchParams: URLSearchParams
): StateEventCursor | undefined {
    const snapshotVersion = toSafeInteger(
        searchParams.get('afterSnapshotVersion')
    );
    const occurredAtEpochMs = toSafeInteger(
        searchParams.get('afterOccurredAtEpochMs')
    );
    const eventId = searchParams.get('afterEventId')?.trim();
    if (
        snapshotVersion === undefined ||
        occurredAtEpochMs === undefined ||
        !eventId
    ) {
        return undefined;
    }

    return {
        snapshotVersion,
        occurredAtEpochMs,
        eventId
    };
}

function toSafeInteger(value: string | null): number | undefined {
    if (value === null || value.trim() === '') {
        return undefined;
    }

    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}
