import { describe, expect, it } from 'vitest';

import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { toRtcGrantedListedLeg } from '@shared/multicast/publication/to-rtc-granted-listed-leg.ts';

import { ORIGIN_ROOM } from '../rtc-origin-overlay-fixture.ts';

const ROUTE = { topicId: 'room.granted-feed', resourceId: 'feed-1', contextId: ORIGIN_ROOM.groupId };

describe('toRtcGrantedListedLeg', () => {
    it('turns a room unicast into the one-entry listed room broadcast of its room', () => {
        const unicast = newALUnicastMessage({
            createdAtEpochMs: Date.now(),
            senderId: 'a',
            route: ROUTE,
            toPeerId: 'b',
            typeId: 'room.granted-feed.v1',
            resource: {},
            options: { ack: 'receiver', groupRef: ORIGIN_ROOM }
        });

        const listed = toRtcGrantedListedLeg(unicast);

        expect(listed.targets).toEqual({ mode: 'broadcast', scope: 'room', groupRef: ORIGIN_ROOM, recipientPeerIds: ['b'] });
        const { targets: _listedTargets, ...listedFields } = listed;
        for (const [field, value] of Object.entries(listedFields)) {
            expect(value).toBe(unicast[field as keyof ALMessage]);
        }
        expect(Object.keys(listed).sort()).toEqual(Object.keys(unicast).sort());
    });

    it('leaves a multicast, a room broadcast and a unicast naming no room as the same reference', () => {
        const multicast = newALMulticastMessage({
            createdAtEpochMs: Date.now(),
            senderId: 'a',
            route: ROUTE,
            groupRef: ORIGIN_ROOM,
            typeId: 'room.granted-feed.v1',
            resource: {},
            options: { ack: 'none' }
        });
        const roomBroadcast = newALBroadcastMessage({
            createdAtEpochMs: Date.now(),
            senderId: 'a',
            route: ROUTE,
            scope: 'room',
            typeId: 'room.granted-feed.v1',
            resource: {},
            options: { ack: 'none', groupRef: ORIGIN_ROOM }
        });
        const roomlessUnicast = newALUnicastMessage({
            createdAtEpochMs: Date.now(),
            senderId: 'a',
            route: ROUTE,
            toPeerId: 'b',
            typeId: 'room.granted-feed.v1',
            resource: {},
            options: { ack: 'none' }
        });

        expect(toRtcGrantedListedLeg(multicast)).toBe(multicast);
        expect(toRtcGrantedListedLeg(roomBroadcast)).toBe(roomBroadcast);
        expect(toRtcGrantedListedLeg(roomlessUnicast)).toBe(roomlessUnicast);
    });
});
