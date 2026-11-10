import { describe, expect, it } from 'vitest';

import { newALMulticastMessage, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    isALCountedRecipient,
    resolveALCountedRecipientPeerIds
} from '@shared/alm/delivery/resolve-al-counted-recipient-peer-ids.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

function createRoomMulticast(): ALMessage {
    return newALMulticastMessage('a', { topicId: 'chat', resourceId: 'm', contextId: 'room' }, ROOM, 'chat.v1', {});
}

function createFrozenMulticast(recipientPeerIds: readonly string[]): ALMessage {
    const message = createRoomMulticast();
    return { ...message, targets: { mode: 'multicast', groupRef: ROOM, recipientPeerIds, snapshotVersion: 3 } };
}

describe('the sessions a receiver or leader receipt counts', () => {
    it('counts a frozen multicast\'s recipients under receiver', () => {
        const message = createFrozenMulticast(['b', 'c']);

        expect(resolveALCountedRecipientPeerIds(message, 'receiver')).toEqual(['b', 'c']);
        expect(isALCountedRecipient(message, 'receiver', 'c')).toBe(true);
        expect(isALCountedRecipient(message, 'receiver', 'd')).toBe(false);
    });

    it('counts a unicast\'s addressee under leader', () => {
        const message = newALUnicastMessage('a', { topicId: 'chat', resourceId: 'm', contextId: 'room' }, 'b', 'chat.v1', {});

        expect(resolveALCountedRecipientPeerIds(message, 'leader')).toEqual(['b']);
        expect(isALCountedRecipient(message, 'leader', 'b')).toBe(true);
    });

    it('counts no session under hop', () => {
        const message = createFrozenMulticast(['b', 'c']);

        expect(resolveALCountedRecipientPeerIds(message, 'hop')).toBeUndefined();
        expect(isALCountedRecipient(message, 'hop', 'b')).toBe(false);
    });

    it('counts no session of a multicast before its freeze', () => {
        const message = createRoomMulticast();

        expect(resolveALCountedRecipientPeerIds(message, 'receiver')).toBeUndefined();
        expect(isALCountedRecipient(message, 'receiver', 'b')).toBe(false);
    });
});
