import { readRallarMessageRoomId, toRallarMessageSelectorKey } from '@shared-web/browser/messages/rallar-message-selectors.ts';
import { matchesRallarMessageSelector, normalizeRallarMessageSelector } from '@shared-web/browser/rallar.ts';
import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALPrincipalBroadcastMessage,
    newALRoute
} from '@shared/al-contracts/al-contract.ts';
import { describe, expect, it } from 'vitest';

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

    it('reads room ids from multicast, room broadcast and principal broadcast messages only', () => {
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
        const principalBroadcast = newALPrincipalBroadcastMessage(
            'session-1',
            newALRoute('room.chat', 'context-4', 'message-4'),
            {
                groupRef: { ...groupRef, groupId: 'room-4' },
                principalRef: { applicationId: 'app-1', workspaceId: 'workspace-1', principalId: 'principal-1' }
            },
            'chat.message.v1',
            { text: 'hello' }
        );

        expect(readRallarMessageRoomId(principalBroadcast)).toBe('room-4');
        expect(readRallarMessageRoomId(worldBroadcast)).toBeUndefined();
    });
});
