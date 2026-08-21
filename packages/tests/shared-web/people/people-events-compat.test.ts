import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppTopics } from '@shared/api/api-config.ts';

import {
    createPeopleEvent,
    createPeopleEventPage,
    createPeopleRoomSnapshot,
    createPeopleSnapshot,
    findPeopleWsCallback,
    readPeopleEventMocks,
    resetPeopleEventTestRuntime,
    toPeopleEventMessage
} from './people-event-test-runtime.ts';

describe('people event compatibility', () => {
    beforeEach(resetPeopleEventTestRuntime);

    it('delivers client state events through people.onEvent with filtering and unsubscribe', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const eventListener = vi.fn();

        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
        const unsubscribe = facade.people.onEvent(eventListener, {
            principalId: 'alice',
            eventTypes: ['session-connected']
        });
        await facade.connect();

        const callback = findPeopleWsCallback();
        await callback?.onMessage?.(
            toPeopleEventMessage(createPeopleEvent('alice', 'client-event-1', 'session-connected'))
        );
        await callback?.onMessage?.(
            toPeopleEventMessage(createPeopleEvent('alice', 'client-event-1', 'session-connected'))
        );
        await callback?.onMessage?.(
            toPeopleEventMessage(createPeopleEvent('bob', 'client-event-2', 'session-connected'))
        );
        await callback?.onMessage?.(
            toPeopleEventMessage(createPeopleEvent('alice', 'client-event-3', 'principal-updated'))
        );
        await callback?.onMessage?.(
            toPeopleEventMessage(
                createPeopleEvent('alice', 'client-event-4', 'session-connected', {
                    workspaceId: 'workspace-2'
                })
            )
        );
        unsubscribe();
        await callback?.onMessage?.(
            toPeopleEventMessage(createPeopleEvent('alice', 'client-event-5', 'session-connected'))
        );

        expect(eventListener).toHaveBeenCalledOnce();
        expect(eventListener.mock.calls[0]?.[0]).toMatchObject({
            principalId: 'alice',
            eventId: 'client-event-1',
            eventType: 'session-connected',
            snapshotVersion: 1
        });
        expect(eventListener.mock.calls[0]?.[1]).toMatchObject({
            transport: 'ws',
            typeId: AppTopics.clientStateEvent,
            topicId: AppTopics.clientStateEvent
        });
    });

    it('drops malformed authoritative client events received over WS', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const listener = vi.fn();
        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
        facade.people.onEvent(listener, { principalId: 'alice' });
        await facade.connect();
        const callback = findPeopleWsCallback();
        const event = createPeopleEvent('alice', 'client-event-valid', 'session-connected');
        const { requestId: omitted, ...missingRequestId } = event;

        expect(omitted).not.toBeUndefined();
        await callback?.onMessage?.(toPeopleEventMessage(missingRequestId as typeof event));
        await callback?.onMessage?.(toPeopleEventMessage(event));

        expect(listener).toHaveBeenCalledOnce();
        expect(listener.mock.calls[0]?.[0]).toEqual(event);
    });

    it('uses refresh snapshots as convergence without replaying missed event callbacks', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const mocks = readPeopleEventMocks();
        const facade = createRallarFacade();
        const roomEventListener = vi.fn();
        const peopleEventListener = vi.fn();
        const groupSnapshot = createPeopleRoomSnapshot('room-1', ['session-1']);
        const clientSnapshot = createPeopleSnapshot('principal-1', 'session-1');

        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
        facade.rooms.onEvent(roomEventListener);
        facade.people.onEvent(peopleEventListener);
        mocks.refreshStateSnapshots.mockResolvedValue({
            clients: [clientSnapshot],
            groups: [groupSnapshot]
        });

        await facade.rooms.refresh();
        await facade.people.refresh();

        expect(roomEventListener).not.toHaveBeenCalled();
        expect(peopleEventListener).not.toHaveBeenCalled();
        expect(mocks.refreshStateSnapshots).toHaveBeenCalledTimes(2);
        expect(mocks.hydrateStateCaches).toHaveBeenCalledWith(
            mocks.context.middleware.webRtcGroupManager,
            expect.objectContaining({ clientId: 'principal-1', sessionId: 'session-1' }),
            [clientSnapshot],
            [groupSnapshot],
            {
                scope: { applicationId: 'app-1', workspaceId: 'workspace-1' }
            }
        );
    });

    it('lists people events without connecting or hydrating state caches', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const mocks = readPeopleEventMocks();
        const facade = createRallarFacade();
        const event = createPeopleEvent('alice', 'client-event-1', 'session-connected', {
            applicationId: 'people-app',
            workspaceId: 'people-workspace'
        });
        mocks.listStateClientEvents.mockResolvedValue([event]);

        await expect(
            facade.people.listEvents('alice', {
                scope: { applicationId: 'people-app', workspaceId: 'people-workspace' },
                eventTypes: ['session-connected'],
                limit: 3
            })
        ).resolves.toEqual([event]);

        expect(mocks.initMiddleware).not.toHaveBeenCalled();
        expect(mocks.hydrateStateCaches).not.toHaveBeenCalled();
        expect(mocks.listStateClientEvents).toHaveBeenCalledWith(
            'alice',
            { applicationId: 'people-app', workspaceId: 'people-workspace' },
            {
                eventTypes: ['session-connected'],
                limit: 3,
                signal: expect.any(AbortSignal)
            }
        );
    });

    it('lists people event pages with cursor options', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const mocks = readPeopleEventMocks();
        const facade = createRallarFacade();
        const event = createPeopleEvent('alice', 'client-event-2', 'session-disconnected', {
            snapshotVersion: 3,
            occurredAtEpochMs: 3_000
        });
        const page = createPeopleEventPage([event], true);
        const after = {
            snapshotVersion: 1,
            occurredAtEpochMs: 1_000,
            eventId: 'event-1'
        };
        facade.setDefaults({
            applicationId: 'default-app',
            workspaceId: 'default-workspace'
        });
        mocks.listStateClientEventPage.mockResolvedValue(page);

        await expect(
            facade.people.listEventPage('alice', {
                eventTypes: ['session-disconnected'],
                limit: 3,
                after
            })
        ).resolves.toEqual(page);

        expect(mocks.initMiddleware).not.toHaveBeenCalled();
        expect(mocks.hydrateStateCaches).not.toHaveBeenCalled();
        expect(mocks.listStateClientEventPage).toHaveBeenCalledWith(
            'alice',
            { applicationId: 'default-app', workspaceId: 'default-workspace' },
            {
                eventTypes: ['session-disconnected'],
                limit: 3,
                after,
                signal: expect.any(AbortSignal)
            }
        );
    });

    it('replays people events explicitly and deduplicates live overlap', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const mocks = readPeopleEventMocks();
        const facade = createRallarFacade();
        const listener = vi.fn();
        const event = createPeopleEvent('alice', 'client-event-1', 'session-connected');
        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
        facade.people.onEvent(listener, { principalId: 'alice' });
        mocks.listStateClientEventPage.mockResolvedValue(createPeopleEventPage([event], false));
        await facade.connect();

        const result = await facade.people.replayEvents('alice');
        await findPeopleWsCallback(true)?.onMessage?.(toPeopleEventMessage(event));

        expect(listener).toHaveBeenCalledOnce();
        expect(listener.mock.calls[0]?.[0]).toEqual(event);
        expect(listener.mock.calls[0]?.[1]).toMatchObject({
            transport: 'replay',
            typeId: AppTopics.clientStateEvent,
            topicId: AppTopics.clientStateEvent
        });
        expect(result).toMatchObject({
            events: [event],
            duplicateCount: 0,
            replayedCount: 1,
            pageCount: 1,
            hasMore: false
        });
    });
});
