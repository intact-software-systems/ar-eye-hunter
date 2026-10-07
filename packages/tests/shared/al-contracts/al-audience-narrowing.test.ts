import { describe, expect, it } from 'vitest';

import { toAuthorizedRoomAudience } from '@shared-server/rallar-system/websocket/ws-topic-room-authorizer.ts';
import { isALAudienceSession, isALLeaderRoomBroadcast, toALAudienceNarrowing } from '@shared/al-contracts/al-audience-narrowing.ts';
import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALPrincipalBroadcastMessage,
    newALRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { computeRtcRoomSnapshotAdmission } from '@shared/multicast/rtc-room-snapshot-admission.ts';
import { computeFrozenAudience, toRtcAudienceNarrowing } from '@shared/multicast/web-rtc-overlay-frozen-audience.ts';

import {
    createOriginOverlay,
    createOriginPrincipalSnapshot,
    ORIGIN_PRINCIPAL_REF,
    ORIGIN_ROOM
} from '../multicast/rtc-origin-overlay-fixture.ts';

const ROUTE = newALRoute('chat', ORIGIN_ROOM.groupId, 'narrowed');

describe('the audience a room send narrows to', () => {
    it.each(
        [
            { label: 'no narrowing', narrowing: undefined, expected: true },
            { label: 'its principal', narrowing: { kind: 'principal', principalId: 'principal-1' }, expected: true },
            { label: 'another principal', narrowing: { kind: 'principal', principalId: 'principal-2' }, expected: false },
            { label: 'a list that names it', narrowing: { kind: 'list', recipientPeerIds: ['s1'] }, expected: true },
            { label: 'a list that leaves it out', narrowing: { kind: 'list', recipientPeerIds: ['s2'] }, expected: false },
            { label: 'its leader session', narrowing: { kind: 'leader', sessionId: 's1' }, expected: true },
            { label: 'another leader session', narrowing: { kind: 'leader', sessionId: 's2' }, expected: false }
        ] as const
    )('holds a session under $label: $expected', ({ narrowing, expected }) => {
        expect(isALAudienceSession({ sessionId: 's1', principalId: 'principal-1' }, narrowing)).toBe(expected);
    });

    it.each([
        { label: 'a group-leader room broadcast that names its room', message: createLeaderSend({ groupRef: ORIGIN_ROOM }), expected: true },
        { label: 'a group-leader room broadcast that names no room', message: createLeaderSend({}), expected: false },
        { label: 'a receiver room broadcast', message: createListedSend(), expected: false },
        {
            label: 'a group-leader principal broadcast',
            message: newALPrincipalBroadcastMessage('a', ROUTE, { groupRef: ORIGIN_ROOM, principalRef: ORIGIN_PRINCIPAL_REF }, 'chat.message.v1', {}, {
                ack: 'group-leader'
            }),
            expected: false
        },
        {
            label: 'a group-leader room multicast',
            message: newALMulticastMessage('a', ROUTE, ORIGIN_ROOM, 'chat.message.v1', {}, { ack: 'group-leader' }),
            expected: false
        }
    ])('reads $label as addressing its room\'s leader: $expected', ({ message, expected }) => {
        expect(isALLeaderRoomBroadcast(message)).toBe(expected);
    });

    it('names no session for a principal broadcast that names no principal', () => {
        const narrowing = toALAudienceNarrowing({ mode: 'broadcast', scope: 'principal', groupRef: ORIGIN_ROOM });

        expect(isALAudienceSession({ sessionId: 's1', principalId: 'principal-1' }, narrowing)).toBe(false);
    });

    it.each([
        { label: 'a principal broadcast in its room', message: createPrincipalSend(), expected: ['b', 'd'] },
        { label: 'a listed room broadcast', message: createListedSend(), expected: ['c'] }
    ])('narrows $label to one audience on both carriers', ({ message, expected }) => {
        const snapshot = createOriginPrincipalSnapshot();

        expect(toRtcAudienceNarrowing(message)).toEqual(toALAudienceNarrowing(message.targets));
        expect(computeRtcFrozenRecipients(message, snapshot)).toEqual(expected);
        expect(
            toAuthorizedRoomAudience(snapshot, { ...message, targets: message.targets! }, Date.now()).sessions
                .map((session) => session.sessionId)
                .filter((sessionId) => sessionId !== 'a')
        ).toEqual(expected);
    });
});

function createPrincipalSend(): ALMessage {
    return newALPrincipalBroadcastMessage('a', ROUTE, { groupRef: ORIGIN_ROOM, principalRef: ORIGIN_PRINCIPAL_REF }, 'chat.message.v1', {});
}

function createLeaderSend(options: Readonly<{ groupRef?: typeof ORIGIN_ROOM; }>): ALMessage {
    return newALBroadcastMessage('a', ROUTE, 'room', 'chat.message.v1', {}, { ...options, ack: 'group-leader' });
}

function createListedSend(): ALMessage {
    return newALBroadcastMessage('a', ROUTE, 'room', 'chat.message.v1', {}, { groupRef: ORIGIN_ROOM, recipientPeerIds: ['c', 'z'] });
}

function computeRtcFrozenRecipients(message: ALMessage, snapshot: GroupSnapshot): readonly string[] {
    const admission = computeRtcRoomSnapshotAdmission({
        message,
        snapshot,
        overlay: createOriginOverlay(['b', 'c']),
        selfPeerId: 'a',
        fromPeerId: undefined,
        recipientPeerId: undefined,
        nowMs: Date.now()
    });
    if (admission.kind !== 'authorized') {
        throw new Error('The origin must be authorized in its own room');
    }
    return computeFrozenAudience({ admission, selfPeerId: 'a', narrowing: toRtcAudienceNarrowing(message), leader: undefined })
        .recipientPeerIds;
}
