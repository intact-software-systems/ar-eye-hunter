import { describe, expect, it } from 'vitest';

import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALUnicastMessage,
    type ALAckMode,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import {
    computeRtcGrantedPublicationRefusal,
    resolveRtcGrantedPublicationShapeRefusal,
    RTC_GRANTED_PUBLICATION_REFUSALS
} from '@shared/multicast/publication/compute-rtc-granted-publication-refusal.ts';

import { ORIGIN_ROOM, toOriginFrozenTargets } from '../rtc-origin-overlay-fixture.ts';

const ROUTE = { topicId: 'room.granted-feed', resourceId: 'feed-1', contextId: ORIGIN_ROOM.groupId };
const PROOF = { alg: 'ES256', keyId: 'k'.repeat(43), signature: 's'.repeat(86) } as const;

describe('computeRtcGrantedPublicationRefusal', () => {
    it('carries a signed room multicast without a receipt unchanged', () => {
        const message = { ...createMulticast('none'), proof: PROOF };

        expect(computeRtcGrantedPublicationRefusal(message, message).right).toBe(message);
    });

    it.each<[string, ALMessage, string]>([
        ['a unicast', { ...createUnicast(), proof: PROOF }, RTC_GRANTED_PUBLICATION_REFUSALS.notMulticast],
        ['a room broadcast', { ...createRoomBroadcast(), proof: PROOF }, RTC_GRANTED_PUBLICATION_REFUSALS.notMulticast],
        ['a multicast asking a receipt', { ...createMulticast('receiver'), proof: PROOF }, RTC_GRANTED_PUBLICATION_REFUSALS.receipt],
        ['a multicast without a proof', createMulticast('none'), RTC_GRANTED_PUBLICATION_REFUSALS.unsigned]
    ])('refuses %s as unsupported on the volatile lane with no copies', (_name, message, detail) => {
        expect(computeRtcGrantedPublicationRefusal(message, message).left).toEqual({
            msg: message,
            dropReason: detail,
            dropReasonCode: 'unsupported',
            lane: 'volatile',
            preparedMessages: []
        });
    });

    it('judges and names the refused message by the targets its sender gave, not the multicast they froze to', () => {
        const original = createRoomBroadcast();
        const frozen: ALMessage = { ...original, targets: toOriginFrozenTargets(['b', 'c'], 3) };

        expect(computeRtcGrantedPublicationRefusal(frozen, original).left).toMatchObject({
            msg: { ...frozen, targets: original.targets },
            dropReason: RTC_GRANTED_PUBLICATION_REFUSALS.notMulticast
        });
    });
});

describe('resolveRtcGrantedPublicationShapeRefusal', () => {
    it.each<[string, ALMessage, string | undefined]>([
        ['a multicast without a receipt', createMulticast('none'), undefined],
        ['a unicast', createUnicast(), RTC_GRANTED_PUBLICATION_REFUSALS.notMulticast],
        ['a room broadcast', createRoomBroadcast(), RTC_GRANTED_PUBLICATION_REFUSALS.notMulticast],
        ['a multicast asking every logical recipient', createMulticast('all-logical-recipients'), RTC_GRANTED_PUBLICATION_REFUSALS.receipt],
        [
            'a multicast whose quality of service asks a receipt',
            { ...createMulticast('none'), qos: { ack: { algo: 'receiver' } } },
            RTC_GRANTED_PUBLICATION_REFUSALS.receipt
        ],
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
