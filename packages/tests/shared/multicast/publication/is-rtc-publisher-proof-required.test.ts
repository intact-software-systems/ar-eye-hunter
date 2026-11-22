import { describe, expect, it } from 'vitest';

import { newALBroadcastMessage, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALAckAlgo } from '@shared/al-contracts/al-policy.ts';
import {
    isRtcPublisherProofRequired,
    resolveRtcReceiptedRoomShapeRefusal
} from '@shared/multicast/publication/is-rtc-publisher-proof-required.ts';

import { createOriginReceiverMulticast, ORIGIN_ROOM } from '../rtc-origin-overlay-fixture.ts';

const RECEIVER: ALMessage = createOriginReceiverMulticast('receiver');

describe('isRtcPublisherProofRequired', () => {
    it.each<[string, ALMessage, boolean]>([
        ['a receiver room multicast', RECEIVER, true],
        ['a group-leader room multicast', { ...RECEIVER, delivery: { reliability: 'at-least-once', ack: 'group-leader' } }, true],
        ['a room multicast asking receiver through its quality of service alone', toQosAck(toUnreceipted(RECEIVER), 'receiver'), true],
        ['a receiver room multicast whose quality of service asks hop', toQosAck(RECEIVER, 'hop'), false],
        ['a room multicast asking no receipt', toUnreceipted(RECEIVER), false],
        ['a room multicast asking a subtree receipt', toQosAck(toUnreceipted(RECEIVER), 'subtree'), false],
        ['a listed room broadcast asking receiver, which its origin freezes', createListedBroadcast(), true],
        ['a room broadcast naming only its exclusions and asking receiver', createExclusionsOnlyBroadcast(), true],
        ['a receiver room unicast, whose channel peer must be its origin', createReceiverUnicast(), false]
    ])('on a topic that is not granted, asks a proof of %s: %s', (_name, message, required) => {
        expect(isRtcPublisherProofRequired({ message, topicGranted: false })).toBe(required);
    });

    it('refuses only the receipted room broadcast its origin never freezes, which it could never sign', () => {
        const unreceipted = { ...createExclusionsOnlyBroadcast(), delivery: { reliability: 'best-effort', ack: 'none' } } as const;

        expect(resolveRtcReceiptedRoomShapeRefusal(createExclusionsOnlyBroadcast())).toMatch(/^RTC carries a receipted room send only/);
        expect([createListedBroadcast(), unreceipted, RECEIVER].map(resolveRtcReceiptedRoomShapeRefusal)).toEqual([
            undefined,
            undefined,
            undefined
        ]);
    });

    it('asks a proof of every frame on a granted topic, whatever receipt it asks', () => {
        expect(isRtcPublisherProofRequired({ message: toUnreceipted(RECEIVER), topicGranted: true })).toBe(true);
    });
});

function toUnreceipted(message: ALMessage): ALMessage {
    return { ...message, delivery: { reliability: 'best-effort', ack: 'none' } };
}

function toQosAck(message: ALMessage, algo: ALAckAlgo): ALMessage {
    return { ...message, qos: { ...message.qos, ack: { algo } } };
}

function createListedBroadcast(): ALMessage {
    return newALBroadcastMessage({
        createdAtEpochMs: Date.now(),
        senderId: 'a',
        route: RECEIVER.route,
        scope: 'room',
        typeId: RECEIVER.payload.typeId,
        resource: {},
        options: { ack: 'receiver', reliability: 'at-least-once', groupRef: ORIGIN_ROOM, recipientPeerIds: ['b', 'c'] }
    });
}

function createExclusionsOnlyBroadcast(): ALMessage {
    return newALBroadcastMessage({
        createdAtEpochMs: Date.now(),
        senderId: 'a',
        route: RECEIVER.route,
        scope: 'room',
        typeId: RECEIVER.payload.typeId,
        resource: {},
        options: { ack: 'receiver', reliability: 'at-least-once', groupRef: ORIGIN_ROOM, exceptPeerIds: ['c'] }
    });
}

function createReceiverUnicast(): ALMessage {
    return newALUnicastMessage({
        createdAtEpochMs: Date.now(),
        senderId: 'a',
        route: RECEIVER.route,
        toPeerId: 'c',
        typeId: RECEIVER.payload.typeId,
        resource: {},
        options: { ack: 'receiver', reliability: 'at-least-once', groupRef: ORIGIN_ROOM }
    });
}
