import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALAckPayload, ALNackPayload } from '@shared/al-contracts/al-control.ts';
import type { ALReceiptControl } from '@shared/al-contracts/receipt-proof/al-receipt-proof.ts';

import { createRtcOriginOverlayFixture } from '../rtc-origin-overlay-fixture.ts';
import { createRelayChain, deliverEach } from '../rtc-relay-chain-test-support.ts';
import { createRtcRelayOverlayFixture, type RtcRelayOverlayFixture } from '../rtc-relay-overlay-fixture.ts';

import { signTestALReceiptControl } from '../../../al-control-test-payloads.ts';
import {
    acceptEach,
    readProofRefusals,
    readReceipt,
    readUpwardTuplesFor,
    sendFrozenReceipted,
    toChildAckControl,
    toChildNackControl,
    toControlMessage
} from './rtc-receipt-forgery-test-support.ts';

type ArrivalOrder = 'altered first' | 'true first';

const ORDERS: readonly ArrivalOrder[] = ['altered first', 'true first'];

describe('a child that holds a recipient\'s real proof at an honest relay (S8ii-R1)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it.each(
        ORDERS.flatMap((order) =>
            [
                { order, field: 'status', change: { status: 'accepted' }, alteredStatus: 'accepted' },
                { order, field: 'observedAtEpochMs', change: { observedAtEpochMs: Date.UTC(2026, 0, 1) + 1 }, alteredStatus: 'delivered' }
            ] as const
        )
    )(
        'an altered ACK under a recipient\'s real proof no longer pre-empts its true ACK at a relay ($field altered, $order)',
        async ({ order, field, change, alteredStatus }) => {
            const { origin, r, message, trueAck, forwardedTrueAck } = await createHeldProofRelay(`held-ack-${field}-${order.replace(' ', '-')}`);
            const altered: ALReceiptControl = {
                type: 'ack',
                payload: { ...trueAck.payload, ...change, fromPeerId: 'f', toPeerId: 'r' } as ALAckPayload
            };

            await deliverInOrder({ r, order, altered: [toControlMessage(altered, 'altered')], forwardedTrueAck });
            await acceptEach(origin, await r.readSent('a'));

            const alteredTuple = ['ack', 'c', alteredStatus];
            const trueTuple = ['ack', 'c', 'delivered'];
            expect(await readUpwardTuplesFor(r, 'a', 'c')).toEqual(
                order === 'altered first' ? [alteredTuple, trueTuple] : [trueTuple, alteredTuple]
            );
            expect((await readReceipt(origin, message))?.ackedPeerIds).toContain('c');
            expect(readProofRefusals(origin)).toContainEqual(
                { proofRefusal: 'invalid-signature', claimedRecipientPeerId: 'c', channelPeerId: 'r' }
            );
        }
    );

    it.each(ORDERS)(
        'an altered NACK under a recipient\'s real ACK proof no longer records it outside against its true ACK (%s)',
        async (order) => {
            const { origin, r, message, trueAck, forwardedTrueAck } = await createHeldProofRelay(`held-nack-${order.replace(' ', '-')}`);
            const nack = toChildNackControl({ msgId: message.id.msgId, fromPeerId: 'f', logicalRecipientPeerId: 'c' });
            const altered: ALReceiptControl = {
                type: 'nack',
                payload: { ...nack.payload, proof: trueAck.payload.proof } as ALNackPayload
            };

            await deliverInOrder({ r, order, altered: [toControlMessage(altered, 'altered')], forwardedTrueAck });
            await acceptEach(origin, await r.readSent('a'));

            const alteredTuple = ['nack', 'c', 'not-subscribed'];
            const trueTuple = ['ack', 'c', 'delivered'];
            expect(await readUpwardTuplesFor(r, 'a', 'c')).toEqual(
                order === 'altered first' ? [alteredTuple, trueTuple] : [trueTuple, alteredTuple]
            );
            const receipt = await readReceipt(origin, message);
            expect(receipt?.ackedPeerIds).toContain('c');
            expect(receipt?.outsideAudiencePeerIds).not.toContain('c');
            expect(readProofRefusals(origin)).toContainEqual(
                { proofRefusal: 'invalid-signature', claimedRecipientPeerId: 'c', channelPeerId: 'r' }
            );
        }
    );

    it.each(ORDERS)('an exact replay of a recipient\'s true control is one statement and goes up once (%s)', async (order) => {
        const { origin, r, message, trueAck, forwardedTrueAck } = await createHeldProofRelay(`held-replay-${order.replace(' ', '-')}`);
        const replay: ALReceiptControl = {
            type: 'ack',
            payload: { ...trueAck.payload, fromPeerId: 'f', toPeerId: 'r' } as ALAckPayload
        };

        await deliverInOrder({ r, order, altered: [toControlMessage(replay, 'replay')], forwardedTrueAck });
        await acceptEach(origin, await r.readSent('a'));

        expect(await readUpwardTuplesFor(r, 'a', 'c')).toEqual([['ack', 'c', 'delivered']]);
        expect((await readReceipt(origin, message))?.ackedPeerIds).toContain('c');
        expect(readProofRefusals(origin).filter((refusal) => refusal.claimedRecipientPeerId === 'c')).toEqual([]);
    });
});

/**
 * The origin `a`, its relay `r`, the relay's children `f` and `h`, and `h`'s child `c`, each its own key; `a`'s send is frozen
 * to `f` and `c`. `c` signs its true ACK to `h`, and `h` forwards it: what `h` sent `r` is `c`'s true word as a forwarded one.
 */
async function createHeldProofRelay(resourceId: string) {
    const chain = await createRelayChain(['a', 'r', 'f', 'h', 'c'], {});
    const origin = createRtcOriginOverlayFixture({ snapshot: chain.snapshot, nextHopPeerIds: ['r'], publicationCrypto: chain.keys.a });
    const r = createRtcRelayOverlayFixture({
        selfPeerId: 'r',
        snapshot: chain.snapshot,
        neighbourPeerIds: ['a', 'f', 'h'],
        publicationCrypto: chain.keys.r
    });
    const h = createRtcRelayOverlayFixture({
        selfPeerId: 'h',
        snapshot: chain.snapshot,
        neighbourPeerIds: ['r', 'c'],
        publicationCrypto: chain.keys.h
    });
    const message = await sendFrozenReceipted(origin, resourceId, ['f', 'c']);
    await r.receive(origin.channels.r!.sent[0]!, 'a');
    await h.receive((await r.readSent('h'))[0]!, 'r');
    expect((await r.readSent('f')).length).toBeGreaterThan(0);
    expect((await h.readSent('c')).length).toBeGreaterThan(0);
    const toR = toChildAckControl({ msgId: message.id.msgId, fromPeerId: 'c', logicalRecipientPeerId: 'c' });
    const trueAck = await signTestALReceiptControl(chain.keys.c!, {
        type: 'ack',
        payload: { ...toR.payload as ALAckPayload, toPeerId: 'h' }
    });
    await h.receive(toControlMessage(trueAck, 'own'), 'c');
    const forwardedTrueAck = await h.readSent('r');
    expect(forwardedTrueAck.length).toBeGreaterThan(0);
    return { origin, r, message, trueAck, forwardedTrueAck };
}

interface DeliverInOrderInput {
    readonly r: RtcRelayOverlayFixture;
    readonly order: ArrivalOrder;
    readonly altered: readonly ALMessage[];
    readonly forwardedTrueAck: readonly ALMessage[];
}

/** `f`'s controls and what `h` forwarded reach `r` in `order`. */
async function deliverInOrder(input: DeliverInOrderInput): Promise<void> {
    if (input.order === 'altered first') {
        await deliverEach(input.altered, input.r, 'f');
    }
    await deliverEach(input.forwardedTrueAck, input.r, 'h');
    if (input.order === 'true first') {
        await deliverEach(input.altered, input.r, 'f');
    }
}
