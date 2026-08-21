import { readRallarMessageRoomId, toRallarMessageSelectorKey } from '@shared-web/browser/rallar-message-selectors.ts';
import { createRallarFacade, matchesRallarMessageSelector, normalizeRallarMessageSelector } from '@shared-web/browser/rallar.ts';
import { newALBroadcastMessage, newALMulticastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import { describe, expect, it, vi } from 'vitest';

describe('Rallar message selectors', () => {
    it('keeps string shorthand as a typeId selector', () => {
        expect(normalizeRallarMessageSelector('chat.message.v1')).toEqual({
            typeId: 'chat.message.v1'
        });
    });

    it('matches messages by topic, type, or both', () => {
        const message = newALMulticastMessage(
            'session-1',
            newALRoute('room.chat', 'room-1', 'message-1'),
            {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1'
            },
            'chat.message.v1',
            { text: 'hello' }
        );

        expect(message.targets).not.toHaveProperty('groupId');

        expect(
            matchesRallarMessageSelector(
                { topicId: 'room.chat', typeId: 'chat.message.v1' },
                message
            )
        ).toBe(true);
        expect(
            matchesRallarMessageSelector({ topicId: 'room.chat' }, message)
        ).toBe(true);
        expect(
            matchesRallarMessageSelector({ typeId: 'chat.message.v1' }, message)
        ).toBe(true);
        expect(
            matchesRallarMessageSelector(
                { topicId: 'room.cursor', typeId: 'chat.message.v1' },
                message
            )
        ).toBe(false);
        expect(
            matchesRallarMessageSelector(
                { topicId: 'room.chat', typeId: 'cursor.position.v1' },
                message
            )
        ).toBe(false);
    });

    it('builds stable selector registry keys', () => {
        expect(
            toRallarMessageSelectorKey({
                topicId: 'room.chat',
                typeId: 'chat.message.v1'
            })
        ).toBe('room.chat/chat.message.v1');
        expect(toRallarMessageSelectorKey({ topicId: 'room.chat' })).toBe(
            'room.chat/*'
        );
        expect(
            toRallarMessageSelectorKey({ typeId: 'chat.message.v1' })
        ).toBe('*/chat.message.v1');
    });

    it('reads room ids from multicast and room broadcast messages only', () => {
        const groupRef = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1'
        };
        const multicast = newALMulticastMessage(
            'session-1',
            newALRoute('room.chat', 'context-1', 'message-1'),
            groupRef,
            'chat.message.v1',
            { text: 'hello' }
        );
        const roomBroadcast = newALBroadcastMessage(
            'session-1',
            newALRoute('room.chat', 'room-2', 'message-2'),
            'room',
            'chat.message.v1',
            { text: 'hello' },
            { groupRef: { ...groupRef, groupId: 'room-2' } }
        );
        const worldBroadcast = newALBroadcastMessage(
            'session-1',
            newALRoute('room.chat', 'room-3', 'message-3'),
            'world',
            'chat.message.v1',
            { text: 'hello' }
        );

        expect(readRallarMessageRoomId(multicast)).toBe('room-1');
        expect(readRallarMessageRoomId(roomBroadcast)).toBe('room-2');
        expect(readRallarMessageRoomId(worldBroadcast)).toBeUndefined();
    });

    it('allows RTC subscriptions to use topic and type selectors', () => {
        const facade = createRallarFacade();

        const unsubscribe = facade.messages.rtc.onMessage(
            { topicId: 'room.chat', typeId: 'chat.message.v1' },
            vi.fn()
        );

        expect(unsubscribe).toEqual(expect.any(Function));
        unsubscribe();
    });

    it('keeps RTC string subscriptions backward compatible', () => {
        const facade = createRallarFacade();

        const unsubscribe = facade.messages.rtc.onMessage(
            'chat.message.v1',
            vi.fn()
        );

        expect(unsubscribe).toEqual(expect.any(Function));
        unsubscribe();
    });

    it('rejects RTC topic-only subscriptions because the low-level RTC callback is type keyed', () => {
        const facade = createRallarFacade();

        expect(() => facade.messages.rtc.onMessage({ topicId: 'room.chat' }, vi.fn())).toThrow('RTC message subscriptions require a typeId.');
    });

    it('allows WS topic-only subscriptions', () => {
        const facade = createRallarFacade();

        const unsubscribe = facade.messages.ws.onMessage(
            { topicId: 'room.chat' },
            vi.fn()
        );

        expect(unsubscribe).toEqual(expect.any(Function));
        unsubscribe();
    });
});
