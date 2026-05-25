import type {
    StateEventCursor,
    StateEventPage,
} from '@shared/api/state-event-types.ts';

export type StateEventListQuery<TEventType extends string = string> = Readonly<{
    eventTypes?: readonly TEventType[];
    limit?: number;
    after?: StateEventCursor;
}>;

export type StateEventListable<TEventType extends string = string> = Readonly<{
    eventId: string;
    eventType: TEventType;
    snapshotVersion: number;
    occurredAtEpochMs: number;
}>;

export const DEFAULT_STATE_EVENT_LIST_LIMIT = 100;
export const MAX_STATE_EVENT_LIST_LIMIT = 500;

export function readStateEventListQuery(
    searchParams: URLSearchParams,
): StateEventListQuery {
    const eventTypes = searchParams.getAll('eventType')
        .map((eventType) => eventType.trim())
        .filter((eventType) => eventType.length > 0);
    const limit = toEventListLimit(searchParams.get('limit'));
    const after = toStateEventCursor(searchParams);

    return {
        ...(eventTypes.length > 0 ? { eventTypes } : {}),
        limit,
        ...(after ? { after } : {}),
    };
}

export function filterStateEventsForList<
    TEvent extends StateEventListable<TEventType>,
    TEventType extends string = string,
>(
    events: readonly TEvent[],
    query: StateEventListQuery<TEventType> = {},
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

export function listStateEventsPage<
    TEvent extends StateEventListable<TEventType>,
    TEventType extends string = string,
>(
    events: readonly TEvent[],
    query: StateEventListQuery<TEventType> = {},
): StateEventPage<TEvent> {
    const eventTypes = query.eventTypes && query.eventTypes.length > 0
        ? new Set<string>(query.eventTypes)
        : undefined;
    const filtered = eventTypes
        ? events.filter((event) => eventTypes.has(event.eventType))
        : [...events];
    const after = query.after;
    const eventsAfterCursor = after
        ? filtered.filter((event) => compareEventToCursor(event, after) > 0)
        : filtered;
    const limit = query.limit ?? DEFAULT_STATE_EVENT_LIST_LIMIT;
    const eventsPlusOne = eventsAfterCursor.slice(0, limit + 1);
    const pageEvents = eventsPlusOne.slice(0, limit);
    const lastEvent = pageEvents.at(-1);

    return {
        events: pageEvents,
        ...(lastEvent ? { nextCursor: toCursor(lastEvent) } : {}),
        hasMore: eventsPlusOne.length > limit,
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

function toStateEventCursor(
    searchParams: URLSearchParams,
): StateEventCursor | undefined {
    const snapshotVersion = toSafeInteger(
        searchParams.get('afterSnapshotVersion'),
    );
    const occurredAtEpochMs = toSafeInteger(
        searchParams.get('afterOccurredAtEpochMs'),
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
        eventId,
    };
}

function toSafeInteger(value: string | null): number | undefined {
    if (value === null || value.trim() === '') {
        return undefined;
    }

    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function compareEventToCursor(
    event: StateEventListable,
    cursor: StateEventCursor,
): number {
    return event.snapshotVersion - cursor.snapshotVersion ||
        event.occurredAtEpochMs - cursor.occurredAtEpochMs ||
        event.eventId.localeCompare(cursor.eventId);
}

function toCursor(event: StateEventListable): StateEventCursor {
    return {
        snapshotVersion: event.snapshotVersion,
        occurredAtEpochMs: event.occurredAtEpochMs,
        eventId: event.eventId,
    };
}
