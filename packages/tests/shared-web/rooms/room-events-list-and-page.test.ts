import { beforeEach, describe, expect, it } from 'vitest';

import { createRoomEvent, createRoomEventPage, readRoomEventMocks, resetRoomEventTestRuntime } from './room-event-test-runtime.ts';

describe('room event history compatibility', () => {
    beforeEach(resetRoomEventTestRuntime);

    it('lists scoped room events without connecting or hydrating state', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const mocks = readRoomEventMocks();
        const facade = createRallarFacade();
        const event = createRoomEvent({
            groupId: 'room-1',
            eventId: 'event-1',
            eventType: 'member-joined',
            applicationId: 'room-app',
            workspaceId: 'room-workspace'
        });
        mocks.listStateGroupEvents.mockResolvedValue([event]);
        mocks.initialiseApiMiddleware.mockRejectedValue(
            new Error('Room history reads must not initialize middleware')
        );
        mocks.hydrateStateCache.mockRejectedValue(
            new Error('Room history reads must not hydrate state')
        );

        await expect(
            facade.rooms.listEvents({
                roomRef: {
                    applicationId: 'room-app',
                    workspaceId: 'room-workspace',
                    groupId: 'room-1'
                },
                scope: { applicationId: 'ignored-app', workspaceId: 'ignored-workspace' },
                eventTypes: ['member-joined'],
                limit: 2
            })
        ).resolves.toEqual([event]);

        expect(mocks.listStateGroupEvents).toHaveBeenCalledWith(
            'room-1',
            { applicationId: 'room-app', workspaceId: 'room-workspace' },
            {
                eventTypes: ['member-joined'],
                limit: 2,
                signal: expect.any(AbortSignal)
            }
        );
    });

    it('uses facade defaults for string room event history reads', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const mocks = readRoomEventMocks();
        const facade = createRallarFacade();
        const event = createRoomEvent({ groupId: 'room-1', eventId: 'event-1', eventType: 'member-joined' });
        facade.setDefaults({
            applicationId: 'default-app',
            workspaceId: 'default-workspace'
        });
        mocks.listStateGroupEvents.mockResolvedValue([event]);
        mocks.initialiseApiMiddleware.mockRejectedValue(
            new Error('Room history reads must not initialize middleware')
        );

        await expect(facade.rooms.listEvents('room-1')).resolves.toEqual([event]);

        expect(mocks.listStateGroupEvents).toHaveBeenCalledWith(
            'room-1',
            { applicationId: 'default-app', workspaceId: 'default-workspace' },
            { signal: expect.any(AbortSignal) }
        );
    });

    it('lists room event pages with literal cursor and filter options', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const mocks = readRoomEventMocks();
        const facade = createRallarFacade();
        const event = createRoomEvent({
            groupId: 'room-1',
            eventId: 'event-2',
            eventType: 'member-left',
            snapshotVersion: 2,
            occurredAtEpochMs: 2_000
        });
        const page = createRoomEventPage([event], false);
        const after = {
            snapshotVersion: 1,
            occurredAtEpochMs: 1_000,
            eventId: 'event-1'
        };
        facade.setDefaults({
            applicationId: 'default-app',
            workspaceId: 'default-workspace'
        });
        mocks.listStateGroupEventPage.mockResolvedValue(page);
        mocks.initialiseApiMiddleware.mockRejectedValue(
            new Error('Room history reads must not initialize middleware')
        );
        mocks.hydrateStateCache.mockRejectedValue(
            new Error('Room history reads must not hydrate state')
        );

        await expect(
            facade.rooms.listEventPage({
                roomId: 'room-1',
                eventTypes: ['member-left'],
                limit: 2,
                after
            })
        ).resolves.toEqual({
            events: [event],
            nextCursor: {
                snapshotVersion: 2,
                occurredAtEpochMs: 2_000,
                eventId: 'event-2'
            },
            hasMore: false
        });

        expect(mocks.listStateGroupEventPage).toHaveBeenCalledWith(
            'room-1',
            { applicationId: 'default-app', workspaceId: 'default-workspace' },
            {
                eventTypes: ['member-left'],
                limit: 2,
                after,
                signal: expect.any(AbortSignal)
            }
        );
    });
});
