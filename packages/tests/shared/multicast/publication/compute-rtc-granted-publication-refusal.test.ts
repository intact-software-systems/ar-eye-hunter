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
    resolveRtcGrantedAddresseeRefusal,
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

    it('refuses a first admission\'s list carrying a proof, which only a leg freezes', () => {
        const message = { ...createRoomBroadcast(), proof: PROOF };

        expect(computeRtcGrantedPublicationRefusal({ carried: message, original: message, storedSend: false }).left)
            .toMatchObject({ msg: message, dropReason: RTC_GRANTED_PUBLICATION_REFUSALS.unfrozenAudience, dropReasonCode: 'unsupported' });
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

describe('resolveRtcGrantedAddresseeRefusal', () => {
    it.each<[string, ALMessage, readonly string[]]>([
        ['a session that holds no subscribe', createUnicast('receiver', 'c'), ['b']],
        ['its own sender, which holds no subscribe', createUnicast('receiver', 'a'), ['b']],
        ['its own sender, which holds subscribe', createUnicast('receiver', 'a'), ['a', 'b']],
        ['a non-holder, the receipt asked by its quality of service', { ...createUnicast('none', 'c'), qos: { ack: { algo: 'receiver' } } }, ['b']],
        ['a non-holder, the receipt asked as all-logical-recipients', createUnicast('all-logical-recipients', 'c'), ['b']]
    ])('refuses a receiver unicast to %s', (_name, msg, holders) => {
        expect(resolveRtcGrantedAddresseeRefusal({ msg, selfSessionId: 'a', subscribeHolders: new Set(holders) }))
            .toBe(RTC_GRANTED_PUBLICATION_REFUSALS.addresseeNotSubscribed);
    });

    it.each<[string, ALMessage]>([
        ['a receiver unicast to a session that holds subscribe', createUnicast('receiver', 'b')],
        ['a unicast to a non-holder asking no receipt', createUnicast('none', 'c')],
        ['a unicast to a non-holder that states no receipt', createReceiptlessUnicast('c')],
        ['a receiver multicast', createMulticast('receiver')],
        ['a receiver room list naming a non-holder', { ...createRoomBroadcast(), delivery: { reliability: 'best-effort', ack: 'receiver' } }]
    ])('passes %s', (_name, msg) => {
        expect(resolveRtcGrantedAddresseeRefusal({ msg, selfSessionId: 'a', subscribeHolders: new Set(['b']) })).toBeUndefined();
    });
});

function createMulticast(ack: ALAckMode): ALMessage {
    return newALMulticastMessage({
        createdAtEpochMs: Date.now(),
        senderId: 'a',
        route: ROUTE,
        groupRef: ORIGIN_ROOM,
        typeId: 'room.granted-feed.v1',
        resource: {},
        options: {
            ack,
            reliability: 'best-effort',
            ttlMs: 30_000
        }
    });
}

function createUnicast(ack: ALAckMode = 'none', toPeerId = 'b'): ALMessage {
    return newALUnicastMessage({
        createdAtEpochMs: Date.now(),
        senderId: 'a',
        route: ROUTE,
        toPeerId,
        typeId: 'room.granted-feed.v1',
        resource: {},
        options: { ack, groupRef: ORIGIN_ROOM }
    });
}

/** A room unicast with no `delivery` and no `qos`: it states no receipt, so only a provider's default could ask one. */
function createReceiptlessUnicast(toPeerId: string): ALMessage {
    return newALUnicastMessage({
        createdAtEpochMs: Date.now(),
        senderId: 'a',
        route: ROUTE,
        toPeerId,
        typeId: 'room.granted-feed.v1',
        resource: {},
        options: { groupRef: ORIGIN_ROOM }
    });
}

function createRoomBroadcast(): ALMessage {
    return newALBroadcastMessage({
        createdAtEpochMs: Date.now(),
        senderId: 'a',
        route: ROUTE,
        scope: 'room',
        typeId: 'room.granted-feed.v1',
        resource: {},
        options: {
            ack: 'none',
            groupRef: ORIGIN_ROOM,
            recipientPeerIds: ['b', 'c']
        }
    });
}

function createRoomlessUnicast(): ALMessage {
    return newALUnicastMessage({
        createdAtEpochMs: Date.now(),
        senderId: 'a',
        route: ROUTE,
        toPeerId: 'b',
        typeId: 'room.granted-feed.v1',
        resource: {},
        options: { ack: 'none' }
    });
}

function createExclusionsBroadcast(): ALMessage {
    return newALBroadcastMessage({
        createdAtEpochMs: Date.now(),
        senderId: 'a',
        route: ROUTE,
        scope: 'room',
        typeId: 'room.granted-feed.v1',
        resource: {},
        options: {
            ack: 'none',
            groupRef: ORIGIN_ROOM,
            exceptPeerIds: ['c']
        }
    });
}

function createWorldBroadcast(): ALMessage {
    return newALBroadcastMessage({
        createdAtEpochMs: Date.now(),
        senderId: 'a',
        route: ROUTE,
        scope: 'world',
        typeId: 'room.granted-feed.v1',
        resource: {},
        options: { ack: 'none' }
    });
}

function createPrincipalBroadcast(): ALMessage {
    return newALPrincipalBroadcastMessage(
        {
            createdAtEpochMs: Date.now(),
            senderId: 'a',
            route: ROUTE,
            target: { groupRef: ORIGIN_ROOM, principalRef: ORIGIN_PRINCIPAL_REF },
            typeId: 'room.granted-feed.v1',
            resource: {},
            options: { ack: 'none' }
        }
    );
}

function createRoomlessPrincipalBroadcast(): ALMessage {
    const principal = createPrincipalBroadcast();
    return { ...principal, targets: { mode: 'broadcast', scope: 'principal', principalRef: ORIGIN_PRINCIPAL_REF } };
}
