import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RallarMessage } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';

import {
    createPeopleEvent,
    createPeopleEventPage,
    createPeopleRoomSnapshot,
    createPeopleSnapshot,
    dispatchPeopleWsMessage,
    readPeopleEventMocks,
    resetPeopleEventTestRuntime,
    toPeopleEventMessage
} from './people-event-test-runtime.ts';

describe('people events', () => {
    beforeEach(resetPeopleEventTestRuntime);

    it('delivers client state events through people.onEvent with filtering and unsubscribe', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const events: ClientEvent[] = [];
        const messages: RallarMessage<ClientEvent>[] = [];

        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
        const unsubscribe = facade.people.onEvent((event, message) => {
            events.push(event);
            messages.push(message);
        }, {
            principalId: 'alice',
            eventTypes: ['session-connected']
        });
        await facade.connect();

        await dispatchPeopleWsMessage(
            toPeopleEventMessage(createPeopleEvent({ principalId: 'alice', eventId: 'client-event-1', eventType: 'session-connected' }))
        );
        await dispatchPeopleWsMessage(
            toPeopleEventMessage(createPeopleEvent({ principalId: 'alice', eventId: 'client-event-1', eventType: 'session-connected' }))
        );
        await dispatchPeopleWsMessage(
            toPeopleEventMessage(createPeopleEvent({ principalId: 'bob', eventId: 'client-event-2', eventType: 'session-connected' }))
        );
        await dispatchPeopleWsMessage(
            toPeopleEventMessage(createPeopleEvent({ principalId: 'alice', eventId: 'client-event-3', eventType: 'principal-updated' }))
        );
        await dispatchPeopleWsMessage(
            toPeopleEventMessage(
                createPeopleEvent({
                    principalId: 'alice',
                    eventId: 'client-event-4',
                    eventType: 'session-connected',
                    workspaceId: 'workspace-2'
                })
            )
        );
        unsubscribe();
        await dispatchPeopleWsMessage(
            toPeopleEventMessage(createPeopleEvent({ principalId: 'alice', eventId: 'client-event-5', eventType: 'session-connected' }))
        );

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            principalId: 'alice',
            eventId: 'client-event-1',
            eventType: 'session-connected',
            snapshotVersion: 1
        });
        expect(messages[0]).toMatchObject({
            transport: 'ws',
            typeId: AppTopics.clientStateEvent,
            topicId: AppTopics.clientStateEvent
        });
    });

    it('drops malformed authoritative client events received over WS', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const events: ClientEvent[] = [];
        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
        facade.people.onEvent((clientEvent) => {
            events.push(clientEvent);
        }, { principalId: 'alice' });
        await facade.connect();
        const event = createPeopleEvent({ principalId: 'alice', eventId: 'client-event-valid', eventType: 'session-connected' });
        const { requestId: omitted, ...missingRequestId } = event;

        expect(omitted).not.toBeUndefined();
        await dispatchPeopleWsMessage(toPeopleEventMessage(missingRequestId as typeof event));
        await dispatchPeopleWsMessage(toPeopleEventMessage(event));

        expect(events).toEqual([event]);
    });

    it('uses refresh snapshots as convergence without replaying missed event callbacks', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const mocks = readPeopleEventMocks();
        const facade = createRallarFacade();
        let roomEventCount = 0;
        const peopleEvents: ClientEvent[] = [];
        const groupSnapshot = createPeopleRoomSnapshot('room-1', ['session-1']);
        const clientSnapshot = createPeopleSnapshot('principal-1', 'session-1');

        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
        facade.rooms.onEvent(() => {
            roomEventCount += 1;
        });
        facade.people.onEvent((event) => {
            peopleEvents.push(event);
        });
        mocks.refreshStateSnapshots.mockResolvedValue({
            clients: [clientSnapshot],
            groups: [groupSnapshot]
        });

        await facade.rooms.refresh();
        await facade.people.refresh();

        expect(roomEventCount).toBe(0);
        expect(peopleEvents).toEqual([]);
        expect(mocks.hydrateStateCache).toHaveBeenCalledWith({
            webRtcGroupManager: mocks.context.middleware.webRtcGroupManager,
            clientData: expect.objectContaining({
                clientId: 'principal-1',
                sessionId: 'session-1'
            }),
            clientSnapshots: [clientSnapshot],
            groupSnapshots: [groupSnapshot],
            options: {
                scope: { applicationId: 'app-1', workspaceId: 'workspace-1' }
            }
        });
    });

    it('lists people events without connecting or hydrating state caches', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const mocks = readPeopleEventMocks();
        const facade = createRallarFacade();
        const event = createPeopleEvent({
            principalId: 'alice',
            eventId: 'client-event-1',
            eventType: 'session-connected',
            applicationId: 'people-app',
            workspaceId: 'people-workspace'
        });
        mocks.listStateClientEvents.mockResolvedValue([event]);
        mocks.initialiseApiMiddleware.mockRejectedValue(
            new Error('People history reads must not initialize middleware')
        );
        mocks.hydrateStateCache.mockRejectedValue(
            new Error('People history reads must not hydrate state')
        );

        await expect(
            facade.people.listEvents('alice', {
                scope: { applicationId: 'people-app', workspaceId: 'people-workspace' },
                eventTypes: ['session-connected'],
                limit: 3
            })
        ).resolves.toEqual([event]);

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
        const event = createPeopleEvent({
            principalId: 'alice',
            eventId: 'client-event-2',
            eventType: 'session-disconnected',
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
        mocks.initialiseApiMiddleware.mockRejectedValue(
            new Error('People history reads must not initialize middleware')
        );
        mocks.hydrateStateCache.mockRejectedValue(
            new Error('People history reads must not hydrate state')
        );

        await expect(
            facade.people.listEventPage('alice', {
                eventTypes: ['session-disconnected'],
                limit: 3,
                after
            })
        ).resolves.toEqual(page);

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
        const events: ClientEvent[] = [];
        const messages: RallarMessage<ClientEvent>[] = [];
        const event = createPeopleEvent({ principalId: 'alice', eventId: 'client-event-1', eventType: 'session-connected' });
        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
        facade.people.onEvent((clientEvent, message) => {
            events.push(clientEvent);
            messages.push(message);
        }, { principalId: 'alice' });
        mocks.listStateClientEventPage.mockResolvedValue(createPeopleEventPage([event], false));
        await facade.connect();

        const result = await facade.people.replayEvents('alice');
        await dispatchPeopleWsMessage(toPeopleEventMessage(event));

        expect(events).toEqual([event]);
        expect(messages[0]).toMatchObject({
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
