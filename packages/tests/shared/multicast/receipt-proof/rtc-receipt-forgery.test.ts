import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    newALAckControlMessage,
    newALNackControlMessage,
    type ALAckPayload,
    type ALNackPayload
} from '@shared/al-contracts/al-control.ts';
import type { ALReceiptControl } from '@shared/al-contracts/receipt-proof/al-receipt-proof.ts';
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
    type RtcOriginOverlayFixture
} from '../rtc-origin-overlay-fixture.ts';
import { createRelayChain, drainUntil, type RelayChain } from '../rtc-relay-chain-test-support.ts';

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
        await drainUntil(async () => (await readReceipt(origin, message)) === undefined);

        expect(await readReceipt(origin, message)).toBeUndefined();
        expect(origin.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)).toMatchObject({
            confirmedRecipientPeerIds: ['b', 'c'],
            complete: true
        });
        expect(subtle.counts.verify).toBe(2);
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

    // Correction (h): an honest next hop outside the frozen audience signs nothing, so its hop-end is refused
    // `missing-proof` where it was refused as confirming no peer; it counted nothing then and counts nothing now.
    it('refuses the unsigned hop-end of a next hop outside the frozen audience as missing-proof (a recorded limit)', async () => {
        const origin = createRtcOriginOverlayFixture({ snapshot: createOriginSnapshot(['a', 'b'], 4), nextHopPeerIds: ['b'] });
        const message = await sendReceipted(origin, 'outside-hop-end');
        origin.groups.accept('room', createOriginSnapshot(['a', 'b', 'd'], 5));
        origin.overlays.accept('room', createOriginOverlay(['d']));
        origin.ready.peerIds = ['d'];
        const hopEnd = toAckControl({
            msgId: message.id.msgId,
            fromPeerId: 'd',
            logicalRecipientPeerId: 'd',
            status: 'subtree-complete'
        });

        await origin.manager.acceptControlMessage(toControlMessage(hopEnd, 'hop-end'));

        expect(await readReceipt(origin, message)).toMatchObject({ expectedPeerIds: ['b'], ackedPeerIds: [] });
        expect(readProofRefusals(origin)).toEqual([
            { proofRefusal: 'missing-proof', claimedRecipientPeerId: 'd', channelPeerId: 'd' }
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
