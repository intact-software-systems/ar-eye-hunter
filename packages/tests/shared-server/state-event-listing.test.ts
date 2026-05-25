import { describe, expect, it } from 'vitest';
import type { ClientEvent } from '@shared/api/client-types.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';
import {
    DEFAULT_STATE_EVENT_LIST_LIMIT,
    filterStateEventsForList,
    listStateEventsPage,
    MAX_STATE_EVENT_LIST_LIMIT,
    readStateEventListQuery,
} from '@shared-server/rallar-system/state-event-listing.ts';

describe('state event listing', () => {
    it('filters events by repeated eventType query params', () => {
        const events = [
            createGroupEvent('event-1', 'group-created', 1_000),
            createGroupEvent('event-2', 'member-joined', 2_000),
            createGroupEvent('event-3', 'member-left', 3_000),
        ];
        const query = readStateEventListQuery(
            new URLSearchParams(
                'eventType=member-joined&eventType=member-left',
            ),
        );

        expect(
            filterStateEventsForList(events, query).map((event) => event.eventId),
        ).toEqual(['event-2', 'event-3']);
    });

    it('returns the latest limited events while preserving chronological order', () => {
        const events = [
            createClientEvent('event-1', 'principal-created', 1_000),
            createClientEvent('event-2', 'principal-updated', 2_000),
            createClientEvent('event-3', 'session-connected', 3_000),
        ];
        const query = readStateEventListQuery(new URLSearchParams('limit=2'));

        expect(
            filterStateEventsForList(events, query).map((event) => event.eventId),
        ).toEqual(['event-2', 'event-3']);
    });

    it('uses a default limit when no limit is requested', () => {
        const events = Array.from(
            { length: DEFAULT_STATE_EVENT_LIST_LIMIT + 2 },
            (_, index) =>
                createGroupEvent(
                    `event-${index + 1}`,
                    'member-joined',
                    index + 1,
                ),
        );
        const query = readStateEventListQuery(new URLSearchParams());

        expect(query.limit).toBe(DEFAULT_STATE_EVENT_LIST_LIMIT);
        expect(filterStateEventsForList(events, query)).toHaveLength(
            DEFAULT_STATE_EVENT_LIST_LIMIT,
        );
        expect(filterStateEventsForList(events, query)[0]?.eventId).toBe(
            'event-3',
        );
    });

    it('clamps overly large limit values', () => {
        const query = readStateEventListQuery(
            new URLSearchParams(`limit=${MAX_STATE_EVENT_LIST_LIMIT + 1}`),
        );

        expect(query.limit).toBe(MAX_STATE_EVENT_LIST_LIMIT);
    });

    it('uses the default limit for invalid limit values and empty event types', () => {
        const events = [
            createGroupEvent('event-1', 'group-created', 1_000),
            createGroupEvent('event-2', 'member-joined', 2_000),
        ];
        const query = readStateEventListQuery(
            new URLSearchParams('eventType=&limit=-1'),
        );

        expect(query.limit).toBe(DEFAULT_STATE_EVENT_LIST_LIMIT);
        expect(filterStateEventsForList(events, query)).toEqual(events);
    });

    it('reads cursor query params and returns forward event pages', () => {
        const events = [
            createGroupEvent('event-1', 'group-created', 1_000),
            createGroupEvent('event-2', 'member-joined', 2_000),
            createGroupEvent('event-3', 'member-left', 3_000),
            createGroupEvent('event-4', 'member-joined', 4_000),
        ];
        const firstQuery = readStateEventListQuery(
            new URLSearchParams(
                'afterSnapshotVersion=1000&afterOccurredAtEpochMs=1000&afterEventId=event-1&limit=2',
            ),
        );

        const firstPage = listStateEventsPage(events, firstQuery);
        const secondPage = listStateEventsPage(events, {
            after: firstPage.nextCursor,
            limit: 2,
        });

        expect(firstQuery.after).toEqual({
            snapshotVersion: 1_000,
            occurredAtEpochMs: 1_000,
            eventId: 'event-1',
        });
        expect(firstPage.events.map((event) => event.eventId)).toEqual([
            'event-2',
            'event-3',
        ]);
        expect(firstPage.nextCursor).toEqual({
            snapshotVersion: 3_000,
            occurredAtEpochMs: 3_000,
            eventId: 'event-3',
        });
        expect(firstPage.hasMore).toBe(true);
        expect(secondPage.events.map((event) => event.eventId)).toEqual([
            'event-4',
        ]);
        expect(secondPage.hasMore).toBe(false);
    });
});

function createGroupEvent(
    eventId: string,
    eventType: GroupEvent['eventType'],
    occurredAtEpochMs: number,
): GroupEvent {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1',
        eventId,
        eventType,
        snapshotVersion: occurredAtEpochMs,
        occurredAtEpochMs,
        actor: {
            serviceId: 'test',
        },
    };
}

function createClientEvent(
    eventId: string,
    eventType: ClientEvent['eventType'],
    occurredAtEpochMs: number,
): ClientEvent {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        principalId: 'alice',
        eventId,
        eventType,
        snapshotVersion: occurredAtEpochMs,
        occurredAtEpochMs,
        actor: {
            serviceId: 'test',
        },
    };
}
