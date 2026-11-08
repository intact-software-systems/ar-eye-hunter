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
        const unicast = newALUnicastMessage('a', ROUTE, 'b', 'room.granted-feed.v1', {}, { ack: 'receiver', groupRef: ORIGIN_ROOM });

        const listed = toRtcGrantedListedLeg(unicast);

        expect(listed.targets).toEqual({ mode: 'broadcast', scope: 'room', groupRef: ORIGIN_ROOM, recipientPeerIds: ['b'] });
        const { targets: _listedTargets, ...listedFields } = listed;
        for (const [field, value] of Object.entries(listedFields)) {
            expect(value).toBe(unicast[field as keyof ALMessage]);
        }
        expect(Object.keys(listed).sort()).toEqual(Object.keys(unicast).sort());
    });

    it('leaves a multicast, a room broadcast and a unicast naming no room as the same reference', () => {
        const multicast = newALMulticastMessage('a', ROUTE, ORIGIN_ROOM, 'room.granted-feed.v1', {}, { ack: 'none' });
        const roomBroadcast = newALBroadcastMessage('a', ROUTE, 'room', 'room.granted-feed.v1', {}, { ack: 'none', groupRef: ORIGIN_ROOM });
        const roomlessUnicast = newALUnicastMessage('a', ROUTE, 'b', 'room.granted-feed.v1', {}, { ack: 'none' });

        expect(toRtcGrantedListedLeg(multicast)).toBe(multicast);
        expect(toRtcGrantedListedLeg(roomBroadcast)).toBe(roomBroadcast);
        expect(toRtcGrantedListedLeg(roomlessUnicast)).toBe(roomlessUnicast);
    });
});
