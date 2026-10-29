import { describe, expect, it } from 'vitest';

import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALPrincipalBroadcastMessage,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import {
    toALPublicationLaneKey,
    toALPublicationStreamKey
} from '@shared/al-contracts/publication/to-al-publication-stream-key.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const OTHER_ROOM = { ...ROOM, groupId: 'other-room' };
const PRINCIPAL = { applicationId: 'app', workspaceId: 'workspace', principalId: 'principal-1' };

function route(resourceId = 'entity-1') {
    return { topicId: 'live', resourceId, contextId: 'room' };
}

function roomMulticast(overrides: { groupRef?: typeof ROOM; resourceId?: string; senderId?: string; } = {}) {
    return newALMulticastMessage(
        overrides.senderId ?? 'sender',
        route(overrides.resourceId),
        overrides.groupRef ?? ROOM,
        'pose.v1',
        { x: 1 }
    );
}

function fixedList(peerIds: readonly string[]): ALMessage {
    return newALBroadcastMessage('sender', route(), 'room', 'pose.v1', { x: 1 }, {
        groupRef: ROOM,
        recipientPeerIds: peerIds
    });
}

describe('toALPublicationStreamKey (D467)', () => {
    it('is stable for the same message and independent of the payload and msgId', () => {
        expect(toALPublicationStreamKey(roomMulticast())).toBe(toALPublicationStreamKey(roomMulticast()));
        expect(toALPublicationStreamKey(roomMulticast()))
            .toBe(toALPublicationStreamKey(newALMulticastMessage('sender', route(), ROOM, 'pose.v1', { x: 2 })));
    });

    it('is the JSON of the fourteen-field tuple with absent fields as null', () => {
        expect(JSON.parse(toALPublicationStreamKey(roomMulticast()))).toEqual([
            'sender',
            'multicast',
            'app',
            'workspace',
            'room',
            null,
            null,
            null,
            null,
            null,
            'live',
            'room',
            'pose.v1',
            'entity-1'
        ]);
    });

    it('differs for two groupIds', () => {
        expect(toALPublicationStreamKey(roomMulticast({ groupRef: OTHER_ROOM })))
            .not.toBe(toALPublicationStreamKey(roomMulticast()));
    });

    it('differs for two resourceIds', () => {
        expect(toALPublicationStreamKey(roomMulticast({ resourceId: 'entity-2' })))
            .not.toBe(toALPublicationStreamKey(roomMulticast()));
    });

    it('differs for two senders', () => {
        expect(toALPublicationStreamKey(roomMulticast({ senderId: 'other' })))
            .not.toBe(toALPublicationStreamKey(roomMulticast()));
    });

    it('differs for a room multicast and a fixed list of the same room', () => {
        expect(toALPublicationStreamKey(fixedList(['peer-a', 'peer-b'])))
            .not.toBe(toALPublicationStreamKey(roomMulticast()));
    });

    it('differs for two fixed lists and is equal for the same list in another order', () => {
        const key = toALPublicationStreamKey(fixedList(['peer-a', 'peer-b']));

        expect(toALPublicationStreamKey(fixedList(['peer-b', 'peer-a']))).toBe(key);
        expect(toALPublicationStreamKey(fixedList(['peer-a', 'peer-c']))).not.toBe(key);
    });

    it('differs for two room broadcasts differing only in exceptPeerIds and ignores their order', () => {
        const toKey = (exceptPeerIds: readonly string[] | undefined) =>
            toALPublicationStreamKey(
                newALBroadcastMessage('sender', route(), 'room', 'pose.v1', { x: 1 }, { groupRef: ROOM, exceptPeerIds })
            );

        expect(toKey(['peer-a'])).not.toBe(toKey(['peer-b']));
        expect(toKey(['peer-a'])).not.toBe(toKey(undefined));
        expect(toKey(['peer-a', 'peer-b'])).toBe(toKey(['peer-b', 'peer-a']));
    });

    it('ignores the fences minSnapshotVersion and rosterVersion', () => {
        const toKey = (minSnapshotVersion: number) =>
            toALPublicationStreamKey(
                newALBroadcastMessage('sender', route(), 'room', 'pose.v1', { x: 1 }, {
                    groupRef: ROOM,
                    minSnapshotVersion,
                    rosterVersion: minSnapshotVersion
                })
            );

        expect(toKey(1)).toBe(toKey(2));
    });

    it('does not reorder the message it reads', () => {
        const message = fixedList(['peer-b', 'peer-a']);

        toALPublicationStreamKey(message);

        expect(message.targets).toMatchObject({ recipientPeerIds: ['peer-b', 'peer-a'] });
    });

    it('differs for a principal broadcast, a room broadcast and a room multicast of one room', () => {
        const principal = newALPrincipalBroadcastMessage(
            'sender',
            route(),
            { groupRef: ROOM, principalRef: PRINCIPAL },
            'pose.v1',
            { x: 1 }
        );
        const roomBroadcast = newALBroadcastMessage('sender', route(), 'room', 'pose.v1', { x: 1 }, {
            groupRef: ROOM
        });
        const keys = [principal, roomBroadcast, roomMulticast()].map(toALPublicationStreamKey);

        expect(new Set(keys).size).toBe(3);
    });

    it('differs for two principals', () => {
        const toKey = (principalId: string) =>
            toALPublicationStreamKey(newALPrincipalBroadcastMessage(
                'sender',
                route(),
                { groupRef: ROOM, principalRef: { ...PRINCIPAL, principalId } },
                'pose.v1',
                { x: 1 }
            ));

        expect(toKey('principal-2')).not.toBe(toKey('principal-1'));
    });

    it('differs for a world broadcast, an all broadcast and a unicast with equal resourceId', () => {
        const world = newALBroadcastMessage('sender', route(), 'world', 'pose.v1', { x: 1 });
        const everyone = newALBroadcastMessage('sender', route(), 'all', 'pose.v1', { x: 1 });
        const unicast = newALUnicastMessage('sender', route(), 'peer-a', 'pose.v1', { x: 1 });
        const otherUnicast = newALUnicastMessage('sender', route(), 'peer-b', 'pose.v1', { x: 1 });
        const keys = [world, everyone, unicast, otherUnicast].map(toALPublicationStreamKey);

        expect(new Set(keys).size).toBe(4);
    });

    it('never collides when a field carries a delimiter look-alike', () => {
        const left = newALUnicastMessage('a', route('b/c'), 'peer', 'pose.v1', {});
        const right = newALUnicastMessage('a', route('b'), 'peer', 'c/pose.v1', {});

        expect(toALPublicationStreamKey(left)).not.toBe(toALPublicationStreamKey(right));
    });

    it('keeps an absent field distinct from the string null', () => {
        const absent = newALBroadcastMessage('sender', route(), 'world', 'pose.v1', {});
        const literal = newALBroadcastMessage('sender', route('null'), 'world', 'pose.v1', {});

        expect(toALPublicationStreamKey(absent)).not.toBe(toALPublicationStreamKey(literal));
    });
});

describe('toALPublicationLaneKey (D467)', () => {
    it('is the channel: topicId/typeId', () => {
        expect(toALPublicationLaneKey(roomMulticast())).toBe('live/pose.v1');
    });

    it('is shared by every stream of the channel', () => {
        expect(toALPublicationLaneKey(roomMulticast({ resourceId: 'entity-2' })))
            .toBe(toALPublicationLaneKey(roomMulticast({ groupRef: OTHER_ROOM })));
    });
});
