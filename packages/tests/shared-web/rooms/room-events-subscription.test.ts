import { beforeEach, describe, expect, it } from 'vitest';

import type { RallarMessage } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';

import {
    createRoomEvent,
    dispatchRoomWsMessage,
    readRoomEventMocks,
    resetRoomEventTestRuntime,
    toRoomEventEnvelopeMessage
} from './room-event-test-runtime.ts';

describe('room event subscriptions', () => {
    beforeEach(resetRoomEventTestRuntime);

    it('delivers one matching WS event without emitting a room state change', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        let roomChangeCount = 0;
        const events: GroupEvent[] = [];
        const messages: RallarMessage<GroupEvent>[] = [];
        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
        facade.rooms.onChange(() => {
            roomChangeCount += 1;
        }, { emitCurrent: false });
        facade.rooms.onEvent((event, message) => {
            events.push(event);
            messages.push(message);
        }, {
            roomId: 'room-1',
            eventTypes: ['member-joined']
        });
        await facade.connect();
        roomChangeCount = 0;
        const matching = createRoomEvent({ groupId: 'room-1', eventId: 'event-1', eventType: 'member-joined' });

        await dispatchRoomWsMessage(toRoomEventEnvelopeMessage(matching));
        await dispatchRoomWsMessage(toRoomEventEnvelopeMessage(matching));
        await dispatchRoomWsMessage(
            toRoomEventEnvelopeMessage(createRoomEvent({ groupId: 'room-2', eventId: 'event-2', eventType: 'member-joined' }))
        );
        await dispatchRoomWsMessage(
            toRoomEventEnvelopeMessage(createRoomEvent({ groupId: 'room-1', eventId: 'event-3', eventType: 'member-left' }))
        );
        await dispatchRoomWsMessage(
            toRoomEventEnvelopeMessage(
                createRoomEvent({
                    groupId: 'room-1',
                    eventId: 'event-4',
                    eventType: 'member-joined',
                    workspaceId: 'other-workspace'
                })
            )
        );

        expect(roomChangeCount).toBe(0);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            groupId: 'room-1',
            eventId: 'event-1',
            eventType: 'member-joined',
            snapshotVersion: 1
        });
        expect(messages[0]).toMatchObject({
            transport: 'ws',
            typeId: AppTopics.groupStateEvent,
            topicId: AppTopics.groupStateEvent
        });
        expect({ event: events[0], message: messages[0] }).toEqual({
            event: matching,
            message: expect.objectContaining({
                transport: 'ws',
                typeId: AppTopics.groupStateEvent,
                topicId: AppTopics.groupStateEvent,
                receivedAtEpochMs: expect.any(Number)
            })
        });
    });

    it('dispatches unwrapped events from delta envelopes and dedupes repeated envelopes', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const events: GroupEvent[] = [];
        const messages: RallarMessage<GroupEvent>[] = [];
        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
        facade.rooms.onEvent((event, message) => {
            events.push(event);
            messages.push(message);
        }, { roomId: 'room-1' });
        await facade.connect();
        const wrapped = createRoomEvent({ groupId: 'room-1', eventId: 'event-wrapped', eventType: 'member-joined' });
        const duplicated = createRoomEvent({ groupId: 'room-1', eventId: 'event-duplicated', eventType: 'member-left' });

        await dispatchRoomWsMessage(toRoomEventEnvelopeMessage(wrapped));
        await dispatchRoomWsMessage(toRoomEventEnvelopeMessage(duplicated));
        await dispatchRoomWsMessage(toRoomEventEnvelopeMessage(duplicated));
        await dispatchRoomWsMessage(toRoomEventEnvelopeMessage(wrapped));

        expect(events.map((event) => event.eventId)).toEqual([
            'event-wrapped',
            'event-duplicated'
        ]);
        expect(events[0]).toEqual(wrapped);
        expect(messages[0]).toMatchObject({
            transport: 'ws',
            typeId: AppTopics.groupStateEvent,
            payload: wrapped
        });
    });

    it('drops incomplete group state delta envelopes', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const events: GroupEvent[] = [];
        const event = createRoomEvent({ groupId: 'room-1', eventId: 'incomplete-envelope', eventType: 'member-joined' });
        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
        facade.rooms.onEvent((event) => {
            events.push(event);
        }, { roomId: 'room-1' });
        await facade.connect();
        await dispatchRoomWsMessage(
            toRoomEventEnvelopeMessage(event, { omitGroup: true })
        );

        expect(events).toEqual([]);
    });

    it('drops malformed room events and stops after unsubscribe', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const events: GroupEvent[] = [];
        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
        const unsubscribe = facade.rooms.onEvent((event) => {
            events.push(event);
        }, { roomId: 'room-1' });
        await facade.connect();
        const event = createRoomEvent({ groupId: 'room-1', eventId: 'valid-event', eventType: 'member-joined' });

        await dispatchRoomWsMessage(
            toRoomEventEnvelopeMessage({
                ...event,
                actor: { kind: 'session', principalId: 'alice', sessionId: '' }
            })
        );
        await dispatchRoomWsMessage(toRoomEventEnvelopeMessage(event));
        unsubscribe();
        await dispatchRoomWsMessage(
            toRoomEventEnvelopeMessage(createRoomEvent({ groupId: 'room-1', eventId: 'later-event', eventType: 'member-left' }))
        );

        expect(events).toEqual([event]);
    });

    it('does not replay missed events when a room subscription reconnects', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const mocks = readRoomEventMocks();
        const facade = createRallarFacade();
        const eventIds: string[] = [];
        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
        facade.rooms.onEvent((event) => {
            eventIds.push(event.eventId);
        }, { roomId: 'room-1' });
        await facade.connect();

        await dispatchRoomWsMessage(
            toRoomEventEnvelopeMessage(createRoomEvent({ groupId: 'room-1', eventId: 'event-1', eventType: 'member-joined' }))
        );
        expect(eventIds).toEqual(['event-1']);

        await facade.disconnect();
        expect(
            mocks.ctx.middleware.webSocketQueueBox.removeAnyInboxMessageCallback
        ).toHaveBeenCalledWith('rallar:ws:any-message');
        await facade.connect();

        expect(eventIds).toEqual(['event-1']);

        await dispatchRoomWsMessage(
            toRoomEventEnvelopeMessage(createRoomEvent({ groupId: 'room-1', eventId: 'event-3', eventType: 'member-left' }))
        );
        expect(eventIds).toEqual(['event-1', 'event-3']);
    });
});
