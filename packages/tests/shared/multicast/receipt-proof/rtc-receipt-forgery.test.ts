import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newALMulticastMessage, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    newALAckControlMessage,
    newALNackControlMessage,
    type ALAckPayload,
    type ALNackPayload
} from '@shared/al-contracts/al-control.ts';
import type { ALReceiptControl } from '@shared/al-contracts/receipt-proof/al-receipt-proof.ts';
import { isALCountedRecipient } from '@shared/alm/delivery/resolve-al-counted-recipient-peer-ids.ts';
import type { ALOutboundAckTrackingPlan } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toGroupPresencePublicationKey } from '@shared/api/group-presence/to-group-presence-publication-key.ts';
import type { GroupPresencePublicationKey, GroupSnapshot } from '@shared/api/group-types.ts';

import { createDefaultOutboundTestRuntime, createOutboundMessage, enqueueOutboundOrThrow } from '../../alm/outbound-runtime-test-fixture.ts';
import { createCountingSubtleCrypto, type CountingSubtleCrypto } from '../../signature/counting-subtle-crypto-fixtures.ts';
import { createAvailablePublicationCryptoFixture } from '../../signature/publication-crypto-fixtures.ts';
import {
    createOriginOverlay,
    createOriginReceiverMulticast,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain,
    ORIGIN_ROOM,
    signRoomNackPayload,
    toOriginDirectedSnapshot,
    toOriginFrozenTargets,
    type RtcOriginOverlayFixture
} from '../rtc-origin-overlay-fixture.ts';
import { createRelayChain, deliverEach, drainUntil, toControlTuples, type RelayChain } from '../rtc-relay-chain-test-support.ts';
import { createRtcRelayOverlayFixture, type RtcRelayOverlayFixture } from '../rtc-relay-overlay-fixture.ts';

import { signTestALReceiptControl, toTestALAckPayload, toTestALNackPayload } from '../../../al-control-test-payloads.ts';

/** A `receiver` receipt a WS client tracks through its server for the one addressee. */
const WS_RECEIVER_TRACKING: ALOutboundAckTrackingPlan = {
    enabled: true,
    timeoutMs: 60_000,
    maxAttempts: 1,
    expectedPeerIds: ['peer-1'],
    nextHopPeerIds: ['server'],
    mode: 'receiver'
};

interface ForgeryOrigin {
    readonly chain: RelayChain;
    readonly origin: RtcOriginOverlayFixture;
}

describe('a forged receipt control at an RTC origin (S8-R5, S8-R7)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('a direct peer that names another recipient confirms nobody', async () => {
        const { chain, origin } = await createStarOrigin();
        const message = await sendReceipted(origin, 'star-named');
        const forged = toAckControl({ msgId: message.id.msgId, fromPeerId: 'c', logicalRecipientPeerId: 'b' });

        await origin.manager.acceptControlMessage(toControlMessage(forged, 'unsigned'));
        await origin.manager.acceptControlMessage(toControlMessage(await signTestALReceiptControl(chain.keys.c!, forged), 'signed'));

        expect((await readReceipt(origin, message))?.ackedPeerIds).toEqual([]);
        expect(readProofRefusals(origin)).toEqual([
            { proofRefusal: 'missing-proof', claimedRecipientPeerId: 'b', channelPeerId: 'c' },
            { proofRefusal: 'key-mismatch', claimedRecipientPeerId: 'b', channelPeerId: 'c' }
        ]);
    });

    it('a relay that forges its child\'s ACK confirms nobody', async () => {
        const { chain, origin } = await createRelayOrigin();
        const message = await sendReceipted(origin, 'relay-forged-ack');
        const forged = toAckControl({ msgId: message.id.msgId, fromPeerId: 'r', logicalRecipientPeerId: 'c' });

        await origin.manager.acceptControlMessage(toControlMessage(await signTestALReceiptControl(chain.keys.r!, forged), 'signed'));

        expect((await readReceipt(origin, message))?.ackedPeerIds).toEqual([]);
        expect(readProofRefusals(origin)).toEqual([
            { proofRefusal: 'key-mismatch', claimedRecipientPeerId: 'c', channelPeerId: 'r' }
        ]);
    });

    it('a forwarded-status ACK that names a counted recipient without its signature confirms nobody', async () => {
        const { origin } = await createRelayOrigin();
        const message = await sendReceipted(origin, 'relay-forwarded-status');
        const forged = toAckControl({
            msgId: message.id.msgId,
            fromPeerId: 'r',
            logicalRecipientPeerId: 'c',
            status: 'forwarded'
        });

        await origin.manager.acceptControlMessage(toControlMessage(forged, 'unsigned'));

        expect((await readReceipt(origin, message))?.ackedPeerIds).toEqual([]);
        expect(readProofRefusals(origin)).toEqual([
            { proofRefusal: 'missing-proof', claimedRecipientPeerId: 'c', channelPeerId: 'r' }
        ]);
    });

    it('a forged outside-audience NACK moves nobody outside', async () => {
        const { origin } = await createRelayOrigin();
        const message = await sendReceipted(origin, 'relay-forged-outside');
        const forged = toNackControl({
            msgId: message.id.msgId,
            fromPeerId: 'r',
            logicalRecipientPeerId: 'c',
            reason: 'not-subscribed'
        });

        await origin.manager.acceptControlMessage(toControlMessage(forged, 'unsigned'));

        const receipt = await readReceipt(origin, message);
        expect(receipt?.outsideAudiencePeerIds).toEqual([]);
        expect(receipt?.expectedPeerIds).toContain('c');
        expect(receipt?.ackedPeerIds).toEqual([]);
        expect(readProofRefusals(origin)).toEqual([
            { proofRefusal: 'missing-proof', claimedRecipientPeerId: 'c', channelPeerId: 'r' }
        ]);
    });

    it('a forged terminal NACK ends no receipt', async () => {
        const { chain, origin } = await createStarOrigin();
        const message = await sendReceipted(origin, 'star-forged-terminal');
        const forged = toNackControl({
            msgId: message.id.msgId,
            fromPeerId: 'b',
            logicalRecipientPeerId: 'c',
            reason: 'expired'
        });

        await origin.manager.acceptControlMessage(toControlMessage(await signTestALReceiptControl(chain.keys.b!, forged), 'signed'));

        expect(await readReceipt(origin, message)).toMatchObject({ expectedPeerIds: ['b', 'c'], ackedPeerIds: [] });
        expect(origin.settlements.filter((settlement) => settlement.kind === 'receipt-exhausted')).toEqual([]);
        expect(readProofRefusals(origin)).toEqual([
            { proofRefusal: 'key-mismatch', claimedRecipientPeerId: 'c', channelPeerId: 'b' }
        ]);
    });

    it('a true ACK replayed to another message or another origin confirms nobody', async () => {
        const { chain, origin } = await createStarOrigin();
        const first = await sendReceipted(origin, 'replay-first');
        const second = await sendReceipted(origin, 'replay-second');
        const signedFirst = await signTestALReceiptControl(
            chain.keys.c!,
            toAckControl({ msgId: first.id.msgId, fromPeerId: 'c', logicalRecipientPeerId: 'c' })
        );
        const signedElsewhere = await signTestALReceiptControl(
            chain.keys.c!,
            toAckControl({ msgId: first.id.msgId, fromPeerId: 'c', logicalRecipientPeerId: 'c', originPeerId: 'z' })
        );
        const toOtherMessage = { ...signedFirst.payload, ackedMsgId: second.id.msgId } as ALAckPayload;
        const toThisOrigin = { ...signedElsewhere.payload, originPeerId: 'a' } as ALAckPayload;

        await origin.manager.acceptControlMessage(toControlMessage({ type: 'ack', payload: toOtherMessage }, 'other-message'));
        await origin.manager.acceptControlMessage(toControlMessage({ type: 'ack', payload: toThisOrigin }, 'other-origin'));

        expect((await readReceipt(origin, second))?.ackedPeerIds).toEqual([]);
        expect((await readReceipt(origin, first))?.ackedPeerIds).toEqual([]);
        expect(readProofRefusals(origin)).toEqual([
            { proofRefusal: 'invalid-signature', claimedRecipientPeerId: 'c', channelPeerId: 'c' },
            { proofRefusal: 'invalid-signature', claimedRecipientPeerId: 'c', channelPeerId: 'c' }
        ]);
    });
});

describe('a true receipt control at an RTC origin (S8-R5, S8-R7)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('the true ACK still completes the receipt after a refused forgery', async () => {
        const { chain, origin } = await createStarOrigin();
        const message = await sendReceipted(origin, 'true-after-forged');
        const forged = toAckControl({ msgId: message.id.msgId, fromPeerId: 'c', logicalRecipientPeerId: 'b' });

        await origin.manager.acceptControlMessage(toControlMessage(forged, 'forged'));
        for (const peerId of ['b', 'c'] as const) {
            const own = toAckControl({ msgId: message.id.msgId, fromPeerId: peerId, logicalRecipientPeerId: peerId });
            expect(await origin.manager.acceptControlMessage(toControlMessage(await signTestALReceiptControl(chain.keys[peerId]!, own), 'own')))
                .toEqual({ kind: 'committed' });
        }

        expect(await readReceipt(origin, message)).toBeUndefined();
        expect(origin.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)).toMatchObject({
            confirmedRecipientPeerIds: ['b', 'c'],
            complete: true
        });
        expect(readProofRefusals(origin)).toEqual([
            { proofRefusal: 'missing-proof', claimedRecipientPeerId: 'b', channelPeerId: 'c' }
        ]);
    });

    it('a retained control\'s replay verifies again from the cache', async () => {
        const subtle = createCountingSubtleCrypto();
        const { chain, origin } = await createStarOrigin(subtle);
        const message = await sendReceipted(origin, 'retained-replay');
        const [fromB, fromC] = await signOwnAcks(chain, message, ['b', 'c']);

        const release = subtle.holdNextVerify();
        const held = origin.manager.acceptControlMessage(fromB!);
        await drainUntil(() => subtle.counts.verify === 1);
        expect(await origin.manager.acceptControlMessage(fromC!)).toEqual({ kind: 'committed' });
        release();
        expect(await held).toEqual({ kind: 'pending-control' });
        const digestsBeforeReplay = subtle.counts.digest;
        await drainUntil(async () => (await readReceipt(origin, message)) === undefined);

        expect(await readReceipt(origin, message)).toBeUndefined();
        expect(origin.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)).toMatchObject({
            confirmedRecipientPeerIds: ['b', 'c'],
            complete: true
        });
        expect(subtle.counts.verify).toBe(2);
        // The replay judged the proof again: one digest of its signed bytes looked the verdict up, and no verify ran.
        expect(subtle.counts.digest).toBe(digestsBeforeReplay + 1);
    });

    it('the fence decides the race', async () => {
        const subtle = createCountingSubtleCrypto();
        const { chain, origin } = await createStarOrigin(subtle);
        const message = await sendReceipted(origin, 'fenced-race');
        const [fromC] = await signOwnAcks(chain, message, ['c']);
        const terminal = await signTestALReceiptControl(
            chain.keys.b!,
            toNackControl({ msgId: message.id.msgId, fromPeerId: 'b', logicalRecipientPeerId: 'b', reason: 'expired' })
        );

        const release = subtle.holdNextVerify();
        const held = origin.manager.acceptControlMessage(fromC!);
        await drainUntil(() => subtle.counts.verify === 1);
        expect(await origin.manager.acceptControlMessage(toControlMessage(terminal, 'terminal'))).toEqual({ kind: 'committed' });
        release();
        expect(await held).toEqual({ kind: 'pending-control' });
        await drainUntil(() => readControlOutcomes(origin, fromC!).length === 2);

        expect(readControlOutcomes(origin, fromC!)).toEqual(['pending-control', 'rejected']);
        expect(await readReceipt(origin, message)).toBeUndefined();
        expect(origin.settlements.filter((settlement) => settlement.kind === 'receipt-exhausted')).toHaveLength(1);
        expect(subtle.counts.verify).toBe(2);
    });

    it.each(['hop', 'subtree'] as const)('admits a null proof under %s, whose receipt counts next hops', async (algo) => {
        const { origin } = await createStarOrigin();
        const message = { ...createOriginReceiverMulticast(`null-proof-${algo}`), qos: { ack: { algo } } } as const;
        expect((await enqueueAndDrain(origin.manager, message)).verdict.kind).toBe('admitted');
        const ack = toAckControl({
            msgId: message.id.msgId,
            fromPeerId: 'b',
            logicalRecipientPeerId: 'b',
            status: algo === 'hop' ? 'delivered' : 'subtree-complete'
        });

        expect(await origin.manager.acceptControlMessage(toControlMessage(ack, algo))).toEqual({ kind: 'committed' });
        expect((await readReceipt(origin, message))?.ackedPeerIds).toEqual(['b']);
    });

    it.each(['hop', 'subtree'] as const)('under %s, a next hop\'s unsigned hop-end that names another hop moves nobody outside', async (algo) => {
        const { origin } = await createStarOrigin();
        const message = { ...createOriginReceiverMulticast(`other-hop-end-${algo}`), qos: { ack: { algo } } } as const;
        expect((await enqueueAndDrain(origin.manager, message)).verdict.kind).toBe('admitted');
        const hopEnd = toAckControl({
            msgId: message.id.msgId,
            fromPeerId: 'b',
            logicalRecipientPeerId: 'c',
            status: 'subtree-complete-not-subscribed'
        });

        await origin.manager.acceptControlMessage(toControlMessage(hopEnd, algo));

        const receipt = await readReceipt(origin, message);
        expect(receipt?.outsideAudiencePeerIds).toEqual([]);
        expect(receipt?.expectedPeerIds).toContain('c');
        expect(receipt?.ackedPeerIds).not.toContain('c');
    });

    it('admits a null proof on ws, whose carrier authenticates its peer', async () => {
        const runtime = createDefaultOutboundTestRuntime({
            sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true }),
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                lane: 'volatile',
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
                ackTracking: WS_RECEIVER_TRACKING
            })
        });
        const message = createOutboundMessage('ws-null-proof');
        await enqueueOutboundOrThrow(runtime, message);
        const ack = toTestALAckPayload({
            ackedMsgId: message.id.msgId,
            fromPeerId: 'server',
            toPeerId: 'self',
            logicalRecipientPeerId: 'peer-1',
            carrier: 'ws'
        });

        const admitted = await runtime.acceptControlMessage(
            toControlMessage({ type: 'ack', payload: ack }, 'ws'),
            'peer'
        );

        expect(admitted).toEqual({ kind: 'committed' });
    });

    it('the frozen key wins', async () => {
        const { chain, origin } = await createStarOrigin();
        const message = await sendReceipted(origin, 'frozen-key');
        const rotated = await createAvailablePublicationCryptoFixture();
        const own = toAckControl({ msgId: message.id.msgId, fromPeerId: 'c', logicalRecipientPeerId: 'c' });

        origin.groups.accept('room', toRoomWithSession(chain.snapshot, 'c', toGroupPresencePublicationKey(rotated)!));
        await origin.manager.acceptControlMessage(toControlMessage(await signTestALReceiptControl(rotated, own), 'rotated'));
        expect((await readReceipt(origin, message))?.ackedPeerIds).toEqual([]);
        origin.groups.accept('room', toRoomWithSession(chain.snapshot, 'c', undefined));
        await origin.manager.acceptControlMessage(toControlMessage(await signTestALReceiptControl(chain.keys.c!, own), 'frozen'));

        expect((await readReceipt(origin, message))?.ackedPeerIds).toEqual(['c']);
        expect(readProofRefusals(origin)).toEqual([
            { proofRefusal: 'key-mismatch', claimedRecipientPeerId: 'c', channelPeerId: 'c' }
        ]);
    });

    // As at cae77e87b: a relay the receipt does not count is no peer the send owes, so the validator, not the proof,
    // refuses its own refusal and the receipt runs on to its retry.
    it('a non-counted next hop\'s own terminal NACK is judged by the validators as before the slice, never as a proof refusal', async () => {
        const chain = await createRelayChain(['a', 'r', 'c'], {});
        const origin = createRtcOriginOverlayFixture({ snapshot: chain.snapshot, nextHopPeerIds: ['r'], publicationCrypto: chain.keys.a });
        const message = await sendFrozenReceipted(origin, 'outside-relay-refusal', ['c']);
        const refusal = toNackControl({ msgId: message.id.msgId, fromPeerId: 'r', logicalRecipientPeerId: 'r', reason: 'unsupported' });

        const admitted = await origin.manager.acceptControlMessage(toControlMessage(refusal, 'own'));

        expect(admitted).toEqual({ kind: 'rejected', reason: 'AL repair sender has no retained outbound obligation' });
        expect(await readReceipt(origin, message)).toMatchObject({ expectedPeerIds: ['c'], ackedPeerIds: [] });
        expect(readProofRefusals(origin)).toEqual([
            { proofRefusal: undefined, claimedRecipientPeerId: undefined, channelPeerId: undefined }
        ]);
    });

    it('a non-counted peer behind a counted hop: its own hop-end is refused as confirming no peer, not as a proof refusal', async () => {
        const chain = await createRelayChain(['a', 'b', 'd'], {});
        const origin = createRtcOriginOverlayFixture({ snapshot: chain.snapshot, nextHopPeerIds: ['b'], publicationCrypto: chain.keys.a });
        const message = await sendFrozenReceipted(origin, 'outside-hop-end', ['b']);
        const hopEnd = toAckControl({
            msgId: message.id.msgId,
            fromPeerId: 'd',
            logicalRecipientPeerId: 'd',
            status: 'subtree-complete'
        });

        const admitted = await origin.manager.acceptControlMessage(toControlMessage(hopEnd, 'hop-end'));

        expect(admitted).toEqual({ kind: 'rejected', reason: 'AL acknowledgement confirms no peer of the pending outbound receipt' });
        expect(await readReceipt(origin, message)).toMatchObject({ expectedPeerIds: ['b'], ackedPeerIds: [] });
        expect(readProofRefusals(origin)).toEqual([
            { proofRefusal: undefined, claimedRecipientPeerId: undefined, channelPeerId: undefined }
        ]);
    });

    it('a non-counted next hop\'s own unsigned hop-end completes its hop and confirms nobody', async () => {
        // `r` is a publish-only relay outside the frozen audience `[c]`, and the origin's only next hop.
        const chain = await createRelayChain(['a', 'r', 'c'], {});
        const origin = createRtcOriginOverlayFixture({ snapshot: chain.snapshot, nextHopPeerIds: ['r'], publicationCrypto: chain.keys.a });
        const message = await sendFrozenReceipted(origin, 'outside-next-hop-end', ['c']);
        const acknowledgements = () => origin.settlements.filter((settlement) => settlement.kind === 'acknowledgement');
        // The hop-end of a relay that holds no subscription itself confirms nobody: `subtree-complete-not-subscribed`.
        const hopEnd = toAckControl({
            msgId: message.id.msgId,
            fromPeerId: 'r',
            logicalRecipientPeerId: 'r',
            status: 'subtree-complete-not-subscribed'
        });

        expect(await origin.manager.acceptControlMessage(toControlMessage(hopEnd, 'hop-end'))).toEqual({ kind: 'committed' });
        expect(acknowledgements().at(-1)).toMatchObject({
            confirmedHopPeerIds: ['r'],
            confirmedRecipientPeerIds: [],
            outsideAudienceRecipientPeerIds: [],
            complete: false
        });
        const forwarded = await signTestALReceiptControl(
            chain.keys.c!,
            toAckControl({ msgId: message.id.msgId, fromPeerId: 'r', logicalRecipientPeerId: 'c' })
        );
        expect(await origin.manager.acceptControlMessage(toControlMessage(forwarded, 'forwarded'))).toEqual({ kind: 'committed' });

        expect(acknowledgements().at(-1)).toMatchObject({ confirmedHopPeerIds: ['r'], confirmedRecipientPeerIds: ['c'] });
        expect(readProofRefusals(origin)).toEqual([]);
    });

    it('under leader, a non-leader peer\'s own unsigned terminal NACK leaves the leader\'s receipt row in place', async () => {
        const chain = await createRelayChain(['a', 'b', 'c', 'd'], {});
        const origin = createRtcOriginOverlayFixture({
            snapshot: toOriginDirectedSnapshot(chain.snapshot, 'd', Date.now()),
            nextHopPeerIds: ['b', 'c'],
            nextHopsBySessionId: { a: ['b', 'c'], b: ['a'], c: ['a', 'd'], d: ['c'] },
            publicationCrypto: chain.keys.a
        });
        const message = newALMulticastMessage(
            'a',
            { topicId: 'chat', resourceId: 'leader-outsider', contextId: 'room' },
            ORIGIN_ROOM,
            'chat.message.v1',
            {},
            { ack: 'group-leader', reliability: 'at-least-once', ttlMs: 30_000 }
        );
        expect((await enqueueAndDrain(origin.manager, message)).verdict.kind).toBe('admitted');
        // `b` is in the room but neither the director, nor the next hop toward it, nor a peer a repair may come from.
        expect(origin.channels.b!.sent).toEqual([]);
        const refusal = toNackControl({ msgId: message.id.msgId, fromPeerId: 'b', logicalRecipientPeerId: 'b', reason: 'expired' });

        const admitted = await origin.manager.acceptControlMessage(toControlMessage(refusal, 'leader-outsider'));

        expect(admitted).toEqual({ kind: 'rejected', reason: 'AL repair sender has no retained outbound obligation' });
        expect(await readReceipt(origin, message)).toMatchObject({ mode: 'leader', expectedPeerIds: ['d'], ackedPeerIds: [] });
        expect(origin.settlements.filter((settlement) => settlement.kind === 'receipt-exhausted')).toEqual([]);
    });

    it('a counted recipient\'s unsigned NACK that names a non-counted peer ends no receipt', async () => {
        const { origin } = await createStarOrigin();
        const message = await sendReceipted(origin, 'counted-names-outsider');
        const forged = toNackControl({ msgId: message.id.msgId, fromPeerId: 'b', logicalRecipientPeerId: 'z', reason: 'expired' });

        await origin.manager.acceptControlMessage(toControlMessage(forged, 'outsider'));

        expect(await readReceipt(origin, message)).toMatchObject({ expectedPeerIds: ['b', 'c'], ackedPeerIds: [] });
        expect(origin.settlements.filter((settlement) => settlement.kind === 'receipt-exhausted')).toEqual([]);
        expect(readProofRefusals(origin)).toEqual([
            { proofRefusal: 'unknown-key', claimedRecipientPeerId: 'z', channelPeerId: 'b' }
        ]);
    });

    it('a counted recipient\'s own unsigned ACK is missing-proof', async () => {
        const { origin } = await createStarOrigin();
        const message = await sendReceipted(origin, 'counted-unsigned');
        const own = toAckControl({ msgId: message.id.msgId, fromPeerId: 'c', logicalRecipientPeerId: 'c' });

        await origin.manager.acceptControlMessage(toControlMessage(own, 'unsigned'));

        expect((await readReceipt(origin, message))?.ackedPeerIds).toEqual([]);
        expect(readProofRefusals(origin)).toEqual([
            { proofRefusal: 'missing-proof', claimedRecipientPeerId: 'c', channelPeerId: 'c' }
        ]);
    });

    it('a control addressed to another owner is refused for its address, with no proof refusal', async () => {
        const { origin } = await createStarOrigin();
        const message = await sendReceipted(origin, 'other-owner');
        // `c` answers its parent hop `b`, which a copy of the same message reaches as an owner of its own.
        const toParent = toTestALAckPayload({
            ackedMsgId: message.id.msgId,
            fromPeerId: 'c',
            toPeerId: 'b',
            originPeerId: 'a',
            logicalRecipientPeerId: 'c',
            status: 'delivered',
            observedAtEpochMs: Date.now()
        });

        const admitted = await origin.manager.acceptControlMessage(toControlMessage({ type: 'ack', payload: toParent }, 'to-parent'));

        expect(admitted).toEqual({ kind: 'rejected', reason: 'AL control is addressed to another outbound message owner' });
        expect((await readReceipt(origin, message))?.ackedPeerIds).toEqual([]);
        expect(readProofRefusals(origin)).toEqual([
            { proofRefusal: undefined, claimedRecipientPeerId: undefined, channelPeerId: undefined }
        ]);
    });

    it('counts a signed control whichever hop forwarded it', async () => {
        const chain = await createRelayChain(['a', 'r', 'b', 'c'], {});
        const origin = createRtcOriginOverlayFixture({
            snapshot: chain.snapshot,
            nextHopPeerIds: ['r', 'b'],
            nextHopsBySessionId: { a: ['r', 'b'], r: ['a', 'c'], c: ['r'], b: ['a'] },
            publicationCrypto: chain.keys.a
        });
        const message = await sendReceipted(origin, 'any-hop');
        // `b` holds no `c` below it, yet it carries `c`'s own signed ACK.
        const forwarded = await signTestALReceiptControl(
            chain.keys.c!,
            toAckControl({ msgId: message.id.msgId, fromPeerId: 'b', logicalRecipientPeerId: 'c' })
        );

        expect(await origin.manager.acceptControlMessage(toControlMessage(forwarded, 'forwarded'))).toEqual({ kind: 'committed' });
        expect((await readReceipt(origin, message))?.ackedPeerIds).toEqual(['c']);
    });
});

describe('the channel binding a hop fact rests on (S8-R1)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('a peer cannot speak as another non-counted peer: a control whose fromPeerId is not its channel sender never reaches the origin\'s admission', async () => {
        const chain = await createRelayChain(['a', 'r', 'c', 'x'], {});
        // `r` is the origin here: a real RTC receive pipeline whose own send the controls answer.
        const origin = createRtcRelayOverlayFixture({
            selfPeerId: 'r',
            snapshot: chain.snapshot,
            neighbourPeerIds: ['a', 'c'],
            publicationCrypto: chain.keys.r
        });
        const message = newALMulticastMessage('r', { topicId: 'chat', resourceId: 'bound', contextId: 'room' }, ORIGIN_ROOM, 'chat.message.v1', {}, {
            ack: 'all-logical-recipients',
            reliability: 'at-least-once',
            ttlMs: 30_000
        });
        expect((await origin.enqueue(message)).verdict.kind).toBe('admitted');
        const toHopEnd = (fromPeerId: string) =>
            newALAckControlMessage(
                { v: 4, msgId: `hop-end-${fromPeerId}`, senderId: fromPeerId, ts: Date.now(), traceId: 'trace-bound' },
                toTestALAckPayload({
                    ackedMsgId: message.id.msgId,
                    fromPeerId,
                    toPeerId: 'r',
                    status: 'subtree-complete-not-subscribed',
                    observedAtEpochMs: Date.now()
                })
            );

        await origin.receive(toHopEnd('x'), 'c');
        await origin.receive(toHopEnd('c'), 'c');

        // Inbound authorization refuses the forged one before any control is routed; `c`'s own is routed to the origin's
        // control admission (`not-handled` by the inbound owner).
        expect(readInboundOutcomes(origin, ['hop-end-x', 'hop-end-c'])).toEqual([
            ['hop-end-x', 'unauthorized'],
            ['hop-end-c', 'not-handled']
        ]);
    });
});

describe('a child hop at an honest relay that speaks for another recipient (S8-R5, S8-R6)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it.each<readonly ['ack' | 'nack', readonly (readonly string[])[]]>([
        ['ack', [['ack', 'c', 'delivered'], ['ack', 'c', 'delivered']]],
        ['nack', [['nack', 'c', 'not-subscribed'], ['ack', 'c', 'delivered']]]
    ])(
        'a child hop that names another recipient no longer pre-empts that recipient\'s true ACK at the relay (forged %s first)',
        async (forgedType, upwardForC) => {
            const { chain, origin, relay, message } = await createRelayWithTwoChildren(`pre-empted-${forgedType}`);
            const forged = forgedType === 'ack'
                ? toChildAckControl({ msgId: message.id.msgId, fromPeerId: 'm', logicalRecipientPeerId: 'c' })
                : toChildNackControl({ msgId: message.id.msgId, fromPeerId: 'm', logicalRecipientPeerId: 'c' });
            const own = toChildAckControl({ msgId: message.id.msgId, fromPeerId: 'c', logicalRecipientPeerId: 'c' });

            // `m` signs with its own key: a proof of the right shape that never verifies for `c`.
            await relay.receive(toControlMessage(await signTestALReceiptControl(chain.keys.m!, forged), 'forged'), 'm');
            await relay.receive(toControlMessage(await signTestALReceiptControl(chain.keys.c!, own), 'own'), 'c');
            await acceptEach(origin, await relay.readSent('a'));

            expect(await readUpwardTuplesFor(relay, 'a', 'c')).toEqual(upwardForC);
            const receipt = await readReceipt(origin, message);
            expect(receipt?.ackedPeerIds).toContain('c');
            expect(receipt?.outsideAudiencePeerIds).not.toContain('c');
            expect(readProofRefusals(origin)).toContainEqual(
                { proofRefusal: 'key-mismatch', claimedRecipientPeerId: 'c', channelPeerId: 'r' }
            );
        }
    );

    it('a forged not-subscribed hop-end about another recipient no longer pre-empts its true ACK', async () => {
        const { chain, origin, relay, message } = await createRelayWithTwoChildren('pre-empted-hop-end');
        const forged = toChildAckControl({
            msgId: message.id.msgId,
            fromPeerId: 'm',
            logicalRecipientPeerId: 'c',
            status: 'subtree-complete-not-subscribed'
        });
        const own = toChildAckControl({ msgId: message.id.msgId, fromPeerId: 'c', logicalRecipientPeerId: 'c' });

        await relay.receive(toControlMessage(await signTestALReceiptControl(chain.keys.m!, forged), 'forged'), 'm');
        await relay.receive(toControlMessage(await signTestALReceiptControl(chain.keys.c!, own), 'own'), 'c');
        await acceptEach(origin, await relay.readSent('a'));

        expect(await readUpwardTuplesFor(relay, 'a', 'c')).toEqual([
            ['ack', 'c', 'subtree-complete-not-subscribed'],
            ['ack', 'c', 'delivered']
        ]);
        const receipt = await readReceipt(origin, message);
        expect(receipt?.ackedPeerIds).toContain('c');
        expect(receipt?.outsideAudiencePeerIds).toEqual([]);
        expect(readProofRefusals(origin)).toContainEqual(
            { proofRefusal: 'key-mismatch', claimedRecipientPeerId: 'c', channelPeerId: 'r' }
        );
    });

    it.each(['ack', 'hop-end'] as const)('a forged %s after the true ACK goes up once and is refused, undoing nothing', async (forgedType) => {
        const { chain, origin, relay, message } = await createRelayWithTwoChildren(`after-true-${forgedType}`);
        const status = forgedType === 'ack' ? 'delivered' : 'subtree-complete-not-subscribed';
        const own = toChildAckControl({ msgId: message.id.msgId, fromPeerId: 'c', logicalRecipientPeerId: 'c' });
        const forged = await signTestALReceiptControl(
            chain.keys.m!,
            toChildAckControl({ msgId: message.id.msgId, fromPeerId: 'm', logicalRecipientPeerId: 'c', status })
        );

        await relay.receive(toControlMessage(await signTestALReceiptControl(chain.keys.c!, own), 'own'), 'c');
        // The same payload and proof under two control ids, so the inbound dedup does not swallow the second.
        await relay.receive(toControlMessage(forged, 'forged'), 'm');
        await relay.receive(toControlMessage(forged, 'forged-again'), 'm');
        await acceptEach(origin, await relay.readSent('a'));

        expect(await readUpwardTuplesFor(relay, 'a', 'c')).toEqual([['ack', 'c', 'delivered'], ['ack', 'c', status]]);
        const receipt = await readReceipt(origin, message);
        expect(receipt?.ackedPeerIds).toContain('c');
        expect(receipt?.outsideAudiencePeerIds).toEqual([]);
        expect(readProofRefusals(origin).filter((refusal) => refusal.claimedRecipientPeerId === 'c')).toEqual([
            { proofRefusal: 'key-mismatch', claimedRecipientPeerId: 'c', channelPeerId: 'r' }
        ]);
    });

    it('a forged NACK after the true ACK goes up once and is refused, undoing nothing', async () => {
        const { chain, origin, relay, message } = await createRelayWithTwoChildren('after-true-nack');
        const own = toChildAckControl({ msgId: message.id.msgId, fromPeerId: 'c', logicalRecipientPeerId: 'c' });
        const forged = await signTestALReceiptControl(
            chain.keys.m!,
            toChildNackControl({ msgId: message.id.msgId, fromPeerId: 'm', logicalRecipientPeerId: 'c' })
        );

        await relay.receive(toControlMessage(await signTestALReceiptControl(chain.keys.c!, own), 'own'), 'c');
        await relay.receive(toControlMessage(forged, 'forged'), 'm');
        await relay.receive(toControlMessage(forged, 'forged-again'), 'm');
        await acceptEach(origin, await relay.readSent('a'));

        expect(await readUpwardTuplesFor(relay, 'a', 'c')).toEqual([['ack', 'c', 'delivered'], ['nack', 'c', 'not-subscribed']]);
        const receipt = await readReceipt(origin, message);
        expect(receipt?.ackedPeerIds).toContain('c');
        expect(receipt?.outsideAudiencePeerIds).toEqual([]);
        expect(readProofRefusals(origin).filter((refusal) => refusal.claimedRecipientPeerId === 'c')).toEqual([
            { proofRefusal: 'key-mismatch', claimedRecipientPeerId: 'c', channelPeerId: 'r' }
        ]);
    });

    it('a recipient\'s true NACK after a forged ACK about it is forwarded and the origin records it outside', async () => {
        const { chain, origin, relay, message } = await createRelayWithTwoChildren('true-nack-after-forged');
        const forged = toChildAckControl({ msgId: message.id.msgId, fromPeerId: 'm', logicalRecipientPeerId: 'c' });
        const own = toChildNackControl({ msgId: message.id.msgId, fromPeerId: 'c', logicalRecipientPeerId: 'c' });

        await relay.receive(toControlMessage(await signTestALReceiptControl(chain.keys.m!, forged), 'forged'), 'm');
        await relay.receive(toControlMessage(await signTestALReceiptControl(chain.keys.c!, own), 'own'), 'c');
        await acceptEach(origin, await relay.readSent('a'));

        expect(await readUpwardTuplesFor(relay, 'a', 'c')).toEqual([['ack', 'c', 'delivered'], ['nack', 'c', 'not-subscribed']]);
        const receipt = await readReceipt(origin, message);
        expect(receipt?.outsideAudiencePeerIds).toContain('c');
        expect(receipt?.ackedPeerIds).not.toContain('c');
    });

    it('forwards a recipient\'s own hop-end after a forged confirmation and refuses its later NACK as already forwarded', async () => {
        const { chain, origin, relay, message } = await createRelayWithTwoChildren('own-hop-end-then-nack');
        const forged = toChildAckControl({ msgId: message.id.msgId, fromPeerId: 'm', logicalRecipientPeerId: 'c' });
        const hopEnd = toChildAckControl({
            msgId: message.id.msgId,
            fromPeerId: 'c',
            logicalRecipientPeerId: 'c',
            status: 'subtree-complete-not-subscribed'
        });
        const own = toChildNackControl({ msgId: message.id.msgId, fromPeerId: 'c', logicalRecipientPeerId: 'c' });

        await relay.receive(toControlMessage(await signTestALReceiptControl(chain.keys.m!, forged), 'forged'), 'm');
        await relay.receive(toControlMessage(await signTestALReceiptControl(chain.keys.c!, hopEnd), 'hop-end'), 'c');
        await relay.receive(toControlMessage(await signTestALReceiptControl(chain.keys.c!, own), 'own'), 'c');
        await acceptEach(origin, await relay.readSent('a'));

        const upwardForC = await readUpwardTuplesFor(relay, 'a', 'c');
        expect(upwardForC).toEqual([['ack', 'c', 'delivered'], ['ack', 'c', 'subtree-complete-not-subscribed']]);
        expect(upwardForC.filter(([type]) => type === 'nack')).toEqual([]);
        expect((await readReceipt(origin, message))?.outsideAudiencePeerIds).toContain('c');
    });

    it('two honest relays each forward both statements about one recipient, and the origin counts it', async () => {
        const { chain, origin, g, r, message } = await createTwoRelaysWithTwoChildren('two-relays');
        const forged = toChildAckControl({ msgId: message.id.msgId, fromPeerId: 'm', logicalRecipientPeerId: 'c' });
        const own = toChildAckControl({ msgId: message.id.msgId, fromPeerId: 'c', logicalRecipientPeerId: 'c' });

        await r.receive(toControlMessage(await signTestALReceiptControl(chain.keys.m!, forged), 'forged'), 'm');
        await r.receive(toControlMessage(await signTestALReceiptControl(chain.keys.c!, own), 'own'), 'c');
        await deliverEach(await r.readSent('g'), g, 'r');
        await acceptEach(origin, await g.readSent('a'));

        expect(await readUpwardTuplesFor(g, 'a', 'c')).toEqual([['ack', 'c', 'delivered'], ['ack', 'c', 'delivered']]);
        expect((await readReceipt(origin, message))?.ackedPeerIds).toContain('c');
        expect(readProofRefusals(origin)).toContainEqual(
            { proofRefusal: 'key-mismatch', claimedRecipientPeerId: 'c', channelPeerId: 'g' }
        );
    });

    it('a forgery that copies the victim\'s key id is its own statement: it goes up and is refused invalid-signature', async () => {
        const { chain, origin, relay, message } = await createRelayWithTwoChildren('copied-key-id');
        const signed = await signTestALReceiptControl(
            chain.keys.m!,
            toChildAckControl({ msgId: message.id.msgId, fromPeerId: 'm', logicalRecipientPeerId: 'c' })
        );
        const forged: ALReceiptControl = {
            type: 'ack',
            payload: {
                ...signed.payload,
                proof: { ...signed.payload.proof!, keyId: toGroupPresencePublicationKey(chain.keys.c!)!.keyId }
            } as ALAckPayload
        };
        const own = toChildAckControl({ msgId: message.id.msgId, fromPeerId: 'c', logicalRecipientPeerId: 'c' });

        await relay.receive(toControlMessage(forged, 'forged'), 'm');
        await relay.receive(toControlMessage(await signTestALReceiptControl(chain.keys.c!, own), 'own'), 'c');
        await acceptEach(origin, await relay.readSent('a'));

        expect(await readUpwardTuplesFor(relay, 'a', 'c')).toEqual([['ack', 'c', 'delivered'], ['ack', 'c', 'delivered']]);
        expect((await readReceipt(origin, message))?.ackedPeerIds).toContain('c');
        expect(readProofRefusals(origin)).toContainEqual(
            { proofRefusal: 'invalid-signature', claimedRecipientPeerId: 'c', channelPeerId: 'r' }
        );
    });
});

describe('a logical receipt never expects a peer its message does not count (S8-R1)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    // The non-counted branch of the proof read is safe only while every expected peer is a counted recipient.
    it.each([
        {
            plan: 'a frozen receiver multicast to direct recipients',
            snapshot: () => createOriginSnapshot(['a', 'b', 'c'], 4),
            nextHopPeerIds: ['b', 'c'],
            nextHopsBySessionId: undefined,
            message: (): ALMessage => createOriginReceiverMulticast('expected-star')
        },
        {
            plan: 'a frozen receiver multicast through a relay, after its retry',
            snapshot: () => createOriginSnapshot(['a', 'r', 'b', 'c'], 4),
            nextHopPeerIds: ['r', 'c'],
            nextHopsBySessionId: undefined,
            message: (): ALMessage => createOriginReceiverMulticast('expected-tree')
        },
        {
            plan: 'a leader send narrowed to its director, after its retry',
            snapshot: () => toOriginDirectedSnapshot(createOriginSnapshot(['a', 'b', 'c', 'd'], 4), 'd', Date.now()),
            nextHopPeerIds: ['b', 'c'],
            nextHopsBySessionId: { a: ['b', 'c'], b: ['a'], c: ['a', 'd'], d: ['c'] },
            message: (): ALMessage =>
                newALMulticastMessage('a', { topicId: 'chat', resourceId: 'expected-leader', contextId: 'room' }, ORIGIN_ROOM, 'chat.message.v1', {}, {
                    ack: 'group-leader',
                    reliability: 'at-least-once',
                    ttlMs: 30_000
                })
        },
        {
            plan: 'a receiver room unicast, after its retry',
            snapshot: () => createOriginSnapshot(['a', 'b', 'c'], 4),
            nextHopPeerIds: ['b', 'c'],
            nextHopsBySessionId: undefined,
            message: (): ALMessage =>
                newALUnicastMessage('a', { topicId: 'chat', resourceId: 'expected-unicast', contextId: 'room' }, 'b', 'chat.message.v1', {}, {
                    groupRef: ORIGIN_ROOM,
                    ack: 'all-logical-recipients',
                    reliability: 'at-least-once',
                    ttlMs: 30_000
                })
        }
    ])('$plan', async ({ snapshot, nextHopPeerIds, nextHopsBySessionId, message }) => {
        const origin = createRtcOriginOverlayFixture({ snapshot: snapshot(), nextHopPeerIds, nextHopsBySessionId });
        const sent = message();
        expect((await enqueueAndDrain(origin.manager, sent)).verdict.kind).toBe('admitted');
        const before = await readUncountedExpectedPeerIds(origin, sent);
        await vi.advanceTimersByTimeAsync(2_100);

        expect(before).toEqual([]);
        expect((await readReceipt(origin, sent))?.attempts).toBe(1);
        expect(await readUncountedExpectedPeerIds(origin, sent)).toEqual([]);
    });

    it('a targeted repair a counted recipient asked for', async () => {
        const origin = createRtcOriginOverlayFixture({ snapshot: createOriginSnapshot(['a', 'b', 'c'], 4), nextHopPeerIds: ['b', 'c'] });
        const sent = { ...createOriginReceiverMulticast('expected-targeted'), qos: { repair: { algo: 'retransmit' } } } as const;
        expect((await enqueueAndDrain(origin.manager, sent)).verdict.kind).toBe('admitted');
        const gap = await signRoomNackPayload(
            toTestALNackPayload({ msgId: sent.id.msgId, fromPeerId: 'b', toPeerId: 'a', reason: 'gap', observedAtEpochMs: Date.now() })
        );

        await origin.manager.acceptControlMessage(toControlMessage({ type: 'nack', payload: gap }, 'targeted'));
        await vi.advanceTimersByTimeAsync(100);

        expect(origin.channels.b!.sent).toHaveLength(2);
        expect(await readUncountedExpectedPeerIds(origin, sent)).toEqual([]);
    });
});

/** Each inbound admission outcome the session stated for the named controls, in arrival order. */
function readInboundOutcomes(fixture: RtcRelayOverlayFixture, msgIds: readonly string[]): readonly (readonly [string, string])[] {
    return fixture.diagnostics.flatMap((event) =>
        event.kind === 'admission-outcome' && msgIds.includes(event.msgId) ? [[event.msgId, event.outcome] as const] : []
    );
}

/** Every peer the receipt row or the sent row's tracking expects that the stored message does not count; logical receipts only. */
async function readUncountedExpectedPeerIds(origin: RtcOriginOverlayFixture, sent: ALMessage): Promise<readonly string[]> {
    const store = origin.resources.admissionStore;
    const pending = await store.readPendingAck({ originPeerId: 'a', msgId: sent.id.msgId });
    const tracking = (await store.readStoredMessage(sent.id.msgId))?.policy.ackTracking;
    const canonical = (await store.readSentMessage(sent.id.msgId))?.msg;
    expect(canonical).toBeDefined();
    expect(tracking?.mode === 'receiver' || tracking?.mode === 'leader').toBe(true);
    const expected = [...(pending?.expectedPeerIds ?? []), ...(tracking?.expectedPeerIds ?? [])];
    // An empty expected set would prove nothing about who is expected.
    expect(expected).not.toEqual([]);
    return expected.filter((peerId) => !isALCountedRecipient(canonical!, tracking!.mode, peerId));
}

/** The origin `a` with the direct recipients `b` and `c`, each session its own key. */
async function createStarOrigin(gated?: CountingSubtleCrypto): Promise<ForgeryOrigin> {
    const chain = await createRelayChain(['a', 'b', 'c'], {});
    const origin = createRtcOriginOverlayFixture({
        snapshot: chain.snapshot,
        nextHopPeerIds: ['b', 'c'],
        publicationCrypto: gated === undefined ? chain.keys.a : { ...chain.keys.a!, subtle: gated.subtle }
    });
    return { chain, origin };
}

async function signOwnAcks(chain: RelayChain, message: ALMessage, peerIds: readonly string[]): Promise<readonly ALMessage[]> {
    const signed: ALMessage[] = [];
    for (const peerId of peerIds) {
        const own = toAckControl({ msgId: message.id.msgId, fromPeerId: peerId, logicalRecipientPeerId: peerId });
        signed.push(toControlMessage(await signTestALReceiptControl(chain.keys[peerId]!, own), 'own'));
    }
    return signed;
}

/** The room with `sessionId` registering `publicationKey`, or gone from it when absent. */
function toRoomWithSession(
    snapshot: GroupSnapshot,
    sessionId: string,
    publicationKey: GroupPresencePublicationKey | undefined
): GroupSnapshot {
    return {
        ...snapshot,
        activeSessions: publicationKey === undefined
            ? snapshot.activeSessions.filter((session) => session.sessionId !== sessionId)
            : snapshot.activeSessions.map((session) => session.sessionId === sessionId ? { ...session, publicationKey } : session)
    };
}

/** Each admission outcome the origin stated for `control`, in order. */
function readControlOutcomes(origin: RtcOriginOverlayFixture, control: ALMessage): readonly string[] {
    return origin.diagnostics.flatMap((event) => event.kind === 'control-admission' && event.msgId === control.id.msgId ? [event.outcome] : []);
}

/** The origin `a` reaching `c` only through the relay `r`, each session its own key. */
async function createRelayOrigin(): Promise<ForgeryOrigin> {
    const chain = await createRelayChain(['a', 'r', 'c'], {});
    const origin = createRtcOriginOverlayFixture({ snapshot: chain.snapshot, nextHopPeerIds: ['r'], publicationCrypto: chain.keys.a });
    return { chain, origin };
}

async function sendReceipted(origin: RtcOriginOverlayFixture, resourceId: string): Promise<ALMessage> {
    const message = createOriginReceiverMulticast(resourceId);
    expect((await enqueueAndDrain(origin.manager, message)).verdict.kind).toBe('admitted');
    expect(await readReceipt(origin, message)).toBeDefined();
    return message;
}

/** A receipted send frozen to `recipientPeerIds`, which the receipt counts. */
async function sendFrozenReceipted(
    origin: RtcOriginOverlayFixture,
    resourceId: string,
    recipientPeerIds: readonly string[]
): Promise<ALMessage> {
    const message = { ...createOriginReceiverMulticast(resourceId), targets: toOriginFrozenTargets(recipientPeerIds, 3) };
    expect((await enqueueAndDrain(origin.manager, message)).verdict.kind).toBe('admitted');
    expect(await readReceipt(origin, message)).toMatchObject({ expectedPeerIds: recipientPeerIds });
    return message;
}

async function readReceipt(origin: RtcOriginOverlayFixture, message: ALMessage) {
    return await origin.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId });
}

interface ForgedAckInput {
    readonly msgId: string;
    readonly fromPeerId: string;
    readonly logicalRecipientPeerId: string;
    readonly status?: ALAckPayload['status'];
    readonly originPeerId?: string;
}

function toAckControl(input: ForgedAckInput): ALReceiptControl {
    return {
        type: 'ack',
        payload: toTestALAckPayload({
            ackedMsgId: input.msgId,
            fromPeerId: input.fromPeerId,
            toPeerId: 'a',
            originPeerId: input.originPeerId ?? 'a',
            logicalRecipientPeerId: input.logicalRecipientPeerId,
            status: input.status ?? 'delivered',
            observedAtEpochMs: Date.now()
        })
    };
}

interface ForgedNackInput {
    readonly msgId: string;
    readonly fromPeerId: string;
    readonly logicalRecipientPeerId: string;
    readonly reason: ALNackPayload['reason'];
}

function toNackControl(input: ForgedNackInput): ALReceiptControl {
    return {
        type: 'nack',
        payload: toTestALNackPayload({
            msgId: input.msgId,
            fromPeerId: input.fromPeerId,
            toPeerId: 'a',
            originPeerId: 'a',
            logicalRecipientPeerId: input.logicalRecipientPeerId,
            reason: input.reason,
            observedAtEpochMs: Date.now()
        })
    };
}

/** The origin `a`, its relay `r` and the relay's children `m` and `c`, each its own key; `a`'s send is frozen to `m` and `c`. */
async function createRelayWithTwoChildren(resourceId: string) {
    const chain = await createRelayChain(['a', 'r', 'm', 'c'], {});
    const origin = createRtcOriginOverlayFixture({ snapshot: chain.snapshot, nextHopPeerIds: ['r'], publicationCrypto: chain.keys.a });
    const relay = createRtcRelayOverlayFixture({
        selfPeerId: 'r',
        snapshot: chain.snapshot,
        neighbourPeerIds: ['a', 'm', 'c'],
        publicationCrypto: chain.keys.r
    });
    const message = await sendFrozenReceipted(origin, resourceId, ['m', 'c']);
    await relay.receive(origin.channels.r!.sent[0]!, 'a');
    expect((await relay.readSent('m')).length).toBeGreaterThan(0);
    expect((await relay.readSent('c')).length).toBeGreaterThan(0);
    return { chain, origin, relay, message };
}

/**
 * The origin `a`, its relay `g`, the relay `g`'s child relay `r` and `r`'s children `m` and `c`, each its own key; `a`'s send
 * is frozen to `m` and `c`.
 */
async function createTwoRelaysWithTwoChildren(resourceId: string) {
    const chain = await createRelayChain(['a', 'g', 'r', 'm', 'c'], {});
    const origin = createRtcOriginOverlayFixture({ snapshot: chain.snapshot, nextHopPeerIds: ['g'], publicationCrypto: chain.keys.a });
    const g = createRtcRelayOverlayFixture({
        selfPeerId: 'g',
        snapshot: chain.snapshot,
        neighbourPeerIds: ['a', 'r'],
        publicationCrypto: chain.keys.g
    });
    const r = createRtcRelayOverlayFixture({
        selfPeerId: 'r',
        snapshot: chain.snapshot,
        neighbourPeerIds: ['g', 'm', 'c'],
        publicationCrypto: chain.keys.r
    });
    const message = await sendFrozenReceipted(origin, resourceId, ['m', 'c']);
    await g.receive(origin.channels.g!.sent[0]!, 'a');
    expect((await g.readSent('r')).length).toBeGreaterThan(0);
    await r.receive((await g.readSent('r'))[0]!, 'g');
    expect((await r.readSent('c')).length).toBeGreaterThan(0);
    return { chain, origin, g, r, message };
}

/** A child's ACK to the relay `r`; absent, its status is `delivered`. */
function toChildAckControl(input: Omit<ForgedAckInput, 'originPeerId'>): ALReceiptControl {
    return {
        type: 'ack',
        payload: toTestALAckPayload({
            ackedMsgId: input.msgId,
            fromPeerId: input.fromPeerId,
            toPeerId: 'r',
            originPeerId: 'a',
            logicalRecipientPeerId: input.logicalRecipientPeerId,
            status: input.status ?? 'delivered',
            observedAtEpochMs: Date.now()
        })
    };
}

/** Hands every control a relay sent its parent to the origin, in order. */
async function acceptEach(origin: RtcOriginOverlayFixture, controls: readonly ALMessage[]): Promise<void> {
    for (const control of controls) {
        await origin.manager.acceptControlMessage(control);
    }
}

/** Each control the relay sent `toPeerId` that speaks for `recipientPeerId`, as its type, recipient and status or reason. */
async function readUpwardTuplesFor(
    relay: RtcRelayOverlayFixture,
    toPeerId: string,
    recipientPeerId: string
): Promise<readonly (readonly string[])[]> {
    return toControlTuples(await relay.readSentControls(toPeerId)).filter(([, recipient]) => recipient === recipientPeerId);
}

/** A child's `not-subscribed` NACK to the relay `r`. */
function toChildNackControl(input: Omit<ForgedNackInput, 'reason'>): ALReceiptControl {
    return {
        type: 'nack',
        payload: toTestALNackPayload({
            msgId: input.msgId,
            fromPeerId: input.fromPeerId,
            toPeerId: 'r',
            originPeerId: 'a',
            logicalRecipientPeerId: input.logicalRecipientPeerId,
            reason: 'not-subscribed',
            observedAtEpochMs: Date.now()
        })
    };
}

function toControlMessage(control: ALReceiptControl, variant: string): ALMessage {
    const id = {
        v: 4,
        msgId: `forged-${control.type}-${variant}-${control.payload.fromPeerId}`,
        senderId: control.payload.fromPeerId,
        ts: Date.now(),
        traceId: 'trace-forgery'
    } as const;
    return control.type === 'ack' ? newALAckControlMessage(id, control.payload) : newALNackControlMessage(id, control.payload);
}

/** Each rejected control admission's proof refusal, in order, as the diagnostic states it. */
function readProofRefusals(origin: RtcOriginOverlayFixture): readonly Readonly<Record<string, string | undefined>>[] {
    return origin.diagnostics.flatMap((event) =>
        event.kind === 'control-admission' && event.outcome === 'rejected'
            ? [{
                proofRefusal: event.proofRefusal,
                claimedRecipientPeerId: event.claimedRecipientPeerId,
                channelPeerId: event.channelPeerId
            }]
            : []
    );
}
