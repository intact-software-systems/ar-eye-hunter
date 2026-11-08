import { describe, expect, it } from 'vitest';

import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALPrincipalBroadcastMessage,
    newALUnicastMessage,
    type ALAckMode,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import {
    computeRtcGrantedPublicationRefusal,
    resolveRtcGrantedPublicationShapeRefusal,
    RTC_GRANTED_PUBLICATION_REFUSALS
} from '@shared/multicast/publication/compute-rtc-granted-publication-refusal.ts';

import { ORIGIN_PRINCIPAL_REF, ORIGIN_ROOM, toOriginFrozenTargets } from '../rtc-origin-overlay-fixture.ts';

const ROUTE = { topicId: 'room.granted-feed', resourceId: 'feed-1', contextId: ORIGIN_ROOM.groupId };
const PROOF = { alg: 'ES256', keyId: 'k'.repeat(43), signature: 's'.repeat(86) } as const;

describe('computeRtcGrantedPublicationRefusal', () => {
    it.each<ALAckMode>(['none', 'receiver', 'group-leader'])('carries a signed room multicast asking ack %s unchanged', (ack) => {
        const message = { ...createMulticast(ack), proof: PROOF };

        expect(computeRtcGrantedPublicationRefusal({ carried: message, original: message, storedSend: true }).right).toBe(message);
    });

    it('carries a first admission\'s room multicast unsigned, which its admission signs after the read', () => {
        const message = createMulticast('none');

        expect(computeRtcGrantedPublicationRefusal({ carried: message, original: message, storedSend: false }).right).toBe(message);
    });

    it('carries a first admission\'s unicast, room list and principal broadcast in its room unsigned, which its admission signs after the read', () => {
        for (const message of [createUnicast(), createRoomBroadcast(), createPrincipalBroadcast()]) {
            expect(computeRtcGrantedPublicationRefusal({ carried: message, original: message, storedSend: false }).right).toBe(message);
        }
    });

    it('refuses an exclusions-only room broadcast, a world broadcast, a roomless principal broadcast and a unicast naming no room as unsupported', () => {
        for (const message of [createExclusionsBroadcast(), createWorldBroadcast(), createRoomlessPrincipalBroadcast(), createRoomlessUnicast()]) {
            expect(computeRtcGrantedPublicationRefusal({ carried: message, original: message, storedSend: false }).left).toEqual({
                msg: message,
                dropReason: RTC_GRANTED_PUBLICATION_REFUSALS.unfrozenAudience,
                dropReasonCode: 'unsupported',
                lane: 'volatile',
                preparedMessages: []
            });
        }
    });

    it('refuses a stored multicast without a proof as unsupported on the volatile lane with no copies', () => {
        const message = createMulticast('none');

        expect(computeRtcGrantedPublicationRefusal({ carried: message, original: message, storedSend: true }).left).toEqual({
            msg: message,
            dropReason: RTC_GRANTED_PUBLICATION_REFUSALS.unsigned,
            dropReasonCode: 'unsupported',
            lane: 'volatile',
            preparedMessages: []
        });
    });

    it('refuses a stored list or unicast without a proof as unsigned', () => {
        for (const message of [createRoomBroadcast(), createUnicast()]) {
            expect(computeRtcGrantedPublicationRefusal({ carried: message, original: message, storedSend: true }).left)
                .toMatchObject({ dropReason: RTC_GRANTED_PUBLICATION_REFUSALS.unsigned, dropReasonCode: 'unsupported' });
        }
    });

    it('refuses a stored list or unicast carrying a proof, which only a leg freezes', () => {
        for (const message of [{ ...createRoomBroadcast(), proof: PROOF }, { ...createUnicast(), proof: PROOF }]) {
            expect(computeRtcGrantedPublicationRefusal({ carried: message, original: message, storedSend: true }).left)
                .toMatchObject({ msg: message, dropReason: RTC_GRANTED_PUBLICATION_REFUSALS.unfrozenAudience, dropReasonCode: 'unsupported' });
        }
    });

    it('judges and names the refused message by the targets its sender gave, not the multicast they froze to', () => {
        const original = createExclusionsBroadcast();
        const frozen: ALMessage = { ...original, targets: toOriginFrozenTargets(['b'], 3) };

        expect(computeRtcGrantedPublicationRefusal({ carried: frozen, original, storedSend: false }).left).toMatchObject({
            msg: { ...frozen, targets: original.targets },
            dropReason: RTC_GRANTED_PUBLICATION_REFUSALS.unfrozenAudience
        });
    });
});

describe('resolveRtcGrantedPublicationShapeRefusal', () => {
    it.each<[string, ALMessage, string | undefined]>([
        ['a multicast without a receipt', createMulticast('none'), undefined],
        ['a room list', createRoomBroadcast(), undefined],
        ['a room principal broadcast', createPrincipalBroadcast(), undefined],
        ['a room unicast', createUnicast(), undefined],
        ['an exclusions-only room broadcast', createExclusionsBroadcast(), RTC_GRANTED_PUBLICATION_REFUSALS.unfrozenAudience],
        ['a world broadcast', createWorldBroadcast(), RTC_GRANTED_PUBLICATION_REFUSALS.unfrozenAudience],
        ['a roomless principal broadcast', createRoomlessPrincipalBroadcast(), RTC_GRANTED_PUBLICATION_REFUSALS.unfrozenAudience],
        ['a roomless unicast', createRoomlessUnicast(), RTC_GRANTED_PUBLICATION_REFUSALS.unfrozenAudience],
        ['a multicast asking every logical recipient', createMulticast('all-logical-recipients'), undefined],
        ['a multicast whose quality of service asks a receipt', { ...createMulticast('none'), qos: { ack: { algo: 'receiver' } } }, undefined],
        ['a multicast whose quality of service asks hop acknowledgements', { ...createMulticast('none'), qos: { ack: { algo: 'hop' } } }, undefined]
    ])('answers for %s, whatever its proof', (_name, message, expected) => {
        expect(resolveRtcGrantedPublicationShapeRefusal(message)).toBe(expected);
    });
});

function createMulticast(ack: ALAckMode): ALMessage {
    return newALMulticastMessage('a', ROUTE, ORIGIN_ROOM, 'room.granted-feed.v1', {}, {
        ack,
        reliability: 'best-effort',
        ttlMs: 30_000
    });
}

function createUnicast(): ALMessage {
    return newALUnicastMessage('a', ROUTE, 'b', 'room.granted-feed.v1', {}, { ack: 'none', groupRef: ORIGIN_ROOM });
}

function createRoomBroadcast(): ALMessage {
    return newALBroadcastMessage('a', ROUTE, 'room', 'room.granted-feed.v1', {}, {
        ack: 'none',
        groupRef: ORIGIN_ROOM,
        recipientPeerIds: ['b', 'c']
    });
}

function createRoomlessUnicast(): ALMessage {
    return newALUnicastMessage('a', ROUTE, 'b', 'room.granted-feed.v1', {}, { ack: 'none' });
}

function createExclusionsBroadcast(): ALMessage {
    return newALBroadcastMessage('a', ROUTE, 'room', 'room.granted-feed.v1', {}, {
        ack: 'none',
        groupRef: ORIGIN_ROOM,
        exceptPeerIds: ['c']
    });
}

function createWorldBroadcast(): ALMessage {
    return newALBroadcastMessage('a', ROUTE, 'world', 'room.granted-feed.v1', {}, { ack: 'none' });
}

function createPrincipalBroadcast(): ALMessage {
    return newALPrincipalBroadcastMessage(
        'a',
        ROUTE,
        { groupRef: ORIGIN_ROOM, principalRef: ORIGIN_PRINCIPAL_REF },
        'room.granted-feed.v1',
        {},
        { ack: 'none' }
    );
}

function createRoomlessPrincipalBroadcast(): ALMessage {
    const principal = createPrincipalBroadcast();
    return { ...principal, targets: { mode: 'broadcast', scope: 'principal', principalRef: ORIGIN_PRINCIPAL_REF } };
}
