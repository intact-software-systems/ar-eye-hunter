import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppTopics } from '@shared/api/api-config.ts';

import { createRoomEvent, findRoomWsCallback, readRoomEventMocks, resetRoomEventTestRuntime, toRoomEventEnvelopeMessage } from './room-event-test-runtime.ts';

describe('room event subscriptions', () => {
    beforeEach(resetRoomEventTestRuntime);

    it('delivers one matching WS event without emitting a room state change', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const roomListener = vi.fn();
        const eventListener = vi.fn();
        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
        facade.rooms.onChange(roomListener, { emitCurrent: false });
        facade.rooms.onEvent(eventListener, {
            roomId: 'room-1',
            eventTypes: ['member-joined']
        });
        await facade.connect();
        roomListener.mockClear();
        const callback = findRoomWsCallback();
        const matching = createRoomEvent('room-1', 'event-1', 'member-joined');

        await callback?.onMessage?.(toRoomEventEnvelopeMessage(matching));
        await callback?.onMessage?.(toRoomEventEnvelopeMessage(matching));
        await callback?.onMessage?.(
            toRoomEventEnvelopeMessage(createRoomEvent('room-2', 'event-2', 'member-joined'))
        );
        await callback?.onMessage?.(
            toRoomEventEnvelopeMessage(createRoomEvent('room-1', 'event-3', 'member-left'))
        );
        await callback?.onMessage?.(
            toRoomEventEnvelopeMessage(
                createRoomEvent('room-1', 'event-4', 'member-joined', {
                    workspaceId: 'other-workspace'
                })
            )
        );

        expect(roomListener).not.toHaveBeenCalled();
        expect(eventListener).toHaveBeenCalledOnce();
        expect(eventListener.mock.calls[0]?.[0]).toMatchObject({
            groupId: 'room-1',
            eventId: 'event-1',
            eventType: 'member-joined',
            snapshotVersion: 1
        });
        expect(eventListener.mock.calls[0]?.[1]).toMatchObject({
            transport: 'ws',
            typeId: AppTopics.groupStateEvent,
            topicId: AppTopics.groupStateEvent
        });
        expect(eventListener).toHaveBeenCalledWith(
            matching,
            expect.objectContaining({
                transport: 'ws',
                typeId: AppTopics.groupStateEvent,
                topicId: AppTopics.groupStateEvent,
                receivedAtEpochMs: expect.any(Number)
            })
        );
    });

    it('dispatches unwrapped events from delta envelopes and dedupes repeated envelopes', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const listener = vi.fn();
        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
        facade.rooms.onEvent(listener, { roomId: 'room-1' });
        await facade.connect();
        const callback = findRoomWsCallback();
        const wrapped = createRoomEvent('room-1', 'event-wrapped', 'member-joined');
        const duplicated = createRoomEvent('room-1', 'event-duplicated', 'member-left');

        await callback?.onMessage?.(toRoomEventEnvelopeMessage(wrapped));
        await callback?.onMessage?.(toRoomEventEnvelopeMessage(duplicated));
        await callback?.onMessage?.(toRoomEventEnvelopeMessage(duplicated));
        await callback?.onMessage?.(toRoomEventEnvelopeMessage(wrapped));

        expect(listener).toHaveBeenCalledTimes(2);
        expect(listener.mock.calls.map((call) => call[0].eventId)).toEqual([
            'event-wrapped',
            'event-duplicated'
        ]);
        expect(listener.mock.calls[0]?.[0]).toEqual(wrapped);
        expect(listener.mock.calls[0]?.[1]).toMatchObject({
            transport: 'ws',
            typeId: AppTopics.groupStateEvent,
            payload: wrapped
        });
    });

    it('drops incomplete group state delta envelopes', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const listener = vi.fn();
        const event = createRoomEvent('room-1', 'incomplete-envelope', 'member-joined');
        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
        facade.rooms.onEvent(listener, { roomId: 'room-1' });
        await facade.connect();
        await findRoomWsCallback()?.onMessage?.(
            toRoomEventEnvelopeMessage(event, { omitGroup: true })
        );

        expect(listener).not.toHaveBeenCalled();
    });

    it('drops malformed room events and stops after unsubscribe', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const listener = vi.fn();
        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
        const unsubscribe = facade.rooms.onEvent(listener, { roomId: 'room-1' });
        await facade.connect();
        const callback = findRoomWsCallback();
        const event = createRoomEvent('room-1', 'valid-event', 'member-joined');

        await callback?.onMessage?.(
            toRoomEventEnvelopeMessage({
                ...event,
                actor: { kind: 'session', principalId: 'alice', sessionId: '' }
            })
        );
        await callback?.onMessage?.(toRoomEventEnvelopeMessage(event));
        unsubscribe();
        await callback?.onMessage?.(
            toRoomEventEnvelopeMessage(createRoomEvent('room-1', 'later-event', 'member-left'))
        );

        expect(listener).toHaveBeenCalledOnce();
        expect(listener.mock.calls[0]?.[0]).toEqual(event);
    });

    it('does not replay missed events when a room subscription reconnects', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const mocks = readRoomEventMocks();
        const facade = createRallarFacade();
        const listener = vi.fn();
        facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
        facade.rooms.onEvent(listener, { roomId: 'room-1' });
        await facade.connect();

        await findRoomWsCallback(true)?.onMessage?.(
            toRoomEventEnvelopeMessage(createRoomEvent('room-1', 'event-1', 'member-joined'))
        );
        expect(listener).toHaveBeenCalledTimes(1);

        await facade.disconnect();
        expect(
            mocks.ctx.middleware.webSocketQueueBox.removeAnyInboxMessageCallback
        ).toHaveBeenCalledWith('rallar:ws:any-message');
        await facade.connect();

        expect(listener).toHaveBeenCalledTimes(1);
        expect(mocks.listStateGroupEventPage).not.toHaveBeenCalled();

        await findRoomWsCallback(true)?.onMessage?.(
            toRoomEventEnvelopeMessage(createRoomEvent('room-1', 'event-3', 'member-left'))
        );
        expect(listener).toHaveBeenCalledTimes(2);
        expect(listener.mock.calls.map((call) => call[0].eventId)).toEqual(['event-1', 'event-3']);
    });
});
