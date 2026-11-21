import { describe, expect, it } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    newALAckControlMessage,
    newALNackControlMessage,
    newALRepairControlMessage,
    type ALAckPayload
} from '@shared/al-contracts/al-control.ts';
import type { ALOutboundAckTrackingPlan } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundControlSource } from '@shared/alm/outbound/compute-al-outbound-control-admission.ts';
import type { ALOutboundControlAdmissionResult } from '@shared/alm/outbound/control/al-outbound-control-admission.ts';
import type { ALOutboundRecipientAuthentication } from '@shared/alm/outbound/control/read-al-outbound-recipient-proof.ts';
import { RtcReceiptProofVerifier } from '@shared/multicast/receipt-proof/rtc-receipt-proof-verifier.ts';

import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createOutboundMessage,
    enqueueOutboundOrThrow,
    type OutboundTestStores
} from '../outbound-runtime-test-fixture.ts';

import { signTestALReceiptControl, toTestALAckPayload, toTestALNackPayload } from '../../../al-control-test-payloads.ts';
import { ROOM_PUBLICATION_CRYPTO, ROOM_PUBLICATION_KEY } from '../../signature/publication-crypto-fixtures.ts';

/** A `receiver` receipt on two frozen recipients, sent through one relay that is neither of them. */
const RECEIVER_TRACKING: ALOutboundAckTrackingPlan = {
    enabled: true,
    timeoutMs: 60_000,
    maxAttempts: 1,
    expectedPeerIds: ['r1', 'r2'],
    nextHopPeerIds: ['relay'],
    mode: 'receiver'
};

/** A `hop` or `subtree` receipt that counts the message's two next hops. */
function toHopTracking(mode: 'hop' | 'subtree'): ALOutboundAckTrackingPlan {
    return { ...RECEIVER_TRACKING, expectedPeerIds: ['h1', 'h2'], nextHopPeerIds: ['h1', 'h2'], mode };
}

/** The origin's own track `game-1`, epoch 1, as the receiver's gap NACK names it. */
const TRACK_KEY = 'game-1:self:1';

interface OriginFixture {
    readonly msg: ALMessage;
    readonly stores: OutboundTestStores;
    accept(control: ALMessage, source?: ALOutboundControlSource): Promise<string>;
    admit(control: ALMessage): Promise<ALOutboundControlAdmissionResult>;
}

/**
 * Sequence 3 of the origin's track, sent with the receipt `ackTracking`, the `receiver` receipt above by default. Under
 * `signature` authentication the send freezes the room's key for its unicast addressee `peer-1`.
 */
async function createOrderedOrigin(
    id: string,
    ackTracking = RECEIVER_TRACKING,
    recipientAuthentication: ALOutboundRecipientAuthentication = { kind: 'carrier' }
): Promise<OriginFixture> {
    const stores = createDefaultOutboundTestStores();
    const runtime = createDefaultOutboundTestRuntime({
        stores,
        recipientAuthentication,
        sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true }),
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            lane: 'volatile',
            preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
            ackTracking,
            ...(recipientAuthentication.kind === 'signature' ? { receiptProofKeys: { 'peer-1': ROOM_PUBLICATION_KEY } } : {})
        })
    });
    const msg: ALMessage = { ...createOutboundMessage(id), ordering: { orderingKey: 'game-1', epoch: 1, seq: 3 } };
    await enqueueOutboundOrThrow(runtime, msg);
    return {
        msg,
        stores,
        accept: async (control, source = 'peer') => {
            const result = await runtime.acceptControlMessage(control, source);
            return result.kind === 'rejected' ? result.reason : result.kind;
        },
        admit: async (control) => await runtime.acceptControlMessage(control, 'peer')
    };
}

interface GapNackInput {
    readonly fromPeerId: string;
    readonly logicalRecipientPeerId: string;
    readonly orderingKey?: string;
    readonly originPeerId?: string;
    readonly controlMsgId?: string;
    readonly gapRequestNumber?: number;
}

/** A gap NACK for sequence 2: a recipient's own, or one a relay forwards for the recipient it names. */
function toGapNack(msg: ALMessage, input: GapNackInput): ALMessage {
    return newALNackControlMessage(
        {
            v: 4,
            msgId: input.controlMsgId ?? `gap-${input.fromPeerId}-${input.logicalRecipientPeerId}`,
            ts: Date.now(),
            senderId: input.fromPeerId,
            traceId: 'trace-relayed-gap'
        },
        toTestALNackPayload({
            msgId: msg.id.msgId,
            fromPeerId: input.fromPeerId,
            toPeerId: 'self',
            logicalRecipientPeerId: input.logicalRecipientPeerId,
            originPeerId: input.originPeerId ?? 'self',
            reason: 'gap',
            observedAtEpochMs: Date.now(),
            orderingKey: input.orderingKey ?? TRACK_KEY,
            expectedSeq: 2,
            missingRanges: [{ from: 2, to: 2 }],
            gapRequestNumber: input.gapRequestNumber ?? 1
        })
    );
}

/** A recipient's own `missing-seq` request for sequence 2, its request number `gapRequestNumber`. */
function toMissingSeqRequest(msg: ALMessage, controlMsgId: string, gapRequestNumber: number): ALMessage {
    return newALRepairControlMessage(
        { v: 4, msgId: controlMsgId, ts: Date.now(), senderId: 'r2', traceId: 'trace-relayed-gap' },
        {
            msgId: msg.id.msgId,
            fromPeerId: 'r2',
            toPeerId: 'self',
            reason: 'missing-seq',
            observedAtEpochMs: Date.now(),
            orderingKey: TRACK_KEY,
            expectedSeq: 2,
            missingRanges: [{ from: 2, to: 2 }],
            gapRequestNumber
        }
    );
}

/** A recipient's own ACK, which the relay forwards readdressed. */
function toForwardedAck(
    msg: ALMessage,
    logicalRecipientPeerId: string,
    status: 'delivered' | 'subtree-complete-not-subscribed' = 'delivered',
    fromPeerId = 'relay'
): ALMessage {
    return newALAckControlMessage(
        {
            v: 4,
            msgId: `ack-${logicalRecipientPeerId}-${status}`,
            ts: Date.now(),
            senderId: fromPeerId,
            traceId: 'trace-relayed-gap'
        },
        toTestALAckPayload({
            ackedMsgId: msg.id.msgId,
            fromPeerId,
            toPeerId: 'self',
            originPeerId: 'self',
            logicalRecipientPeerId,
            carrier: 'rtc',
            status,
            observedAtEpochMs: Date.now()
        })
    );
}

describe('a gap NACK a relay forwarded, at the origin (S4ii-R3)', () => {
    it('admits it from a next hop of the message for a recipient the receipt still owes', async () => {
        const origin = await createOrderedOrigin('relayed-gap-owed');

        expect(await origin.accept(toGapNack(origin.msg, { fromPeerId: 'relay', logicalRecipientPeerId: 'r2' })))
            .toBe('committed');
    });

    it('refuses it from a next hop for a recipient the receipt already counted', async () => {
        const origin = await createOrderedOrigin('relayed-gap-confirmed');
        expect(await origin.accept(toForwardedAck(origin.msg, 'r1'))).toBe('committed');

        expect(await origin.accept(toGapNack(origin.msg, { fromPeerId: 'relay', logicalRecipientPeerId: 'r1' })))
            .toBe('AL gap NACK names no recipient the receipt still owes');
    });

    it('refuses it from a next hop for a recipient the receipt holds outside', async () => {
        const origin = await createOrderedOrigin('relayed-gap-outside');
        expect(await origin.accept(toForwardedAck(origin.msg, 'r1', 'subtree-complete-not-subscribed'))).toBe('committed');

        expect(await origin.accept(toGapNack(origin.msg, { fromPeerId: 'relay', logicalRecipientPeerId: 'r1' })))
            .toContain('names no recipient the receipt still owes');
    });

    it('refuses it from a peer that is neither a hop of the message nor a recipient the receipt expects', async () => {
        const origin = await createOrderedOrigin('relayed-gap-stranger');

        expect(await origin.accept(toGapNack(origin.msg, { fromPeerId: 'stranger', logicalRecipientPeerId: 'r2' })))
            .toBe('AL gap NACK comes from no hop or recipient of this message');
    });

    it('refuses it when its ordering hints name another track than the retained message', async () => {
        const origin = await createOrderedOrigin('relayed-gap-track');

        expect(
            await origin.accept(
                toGapNack(origin.msg, { fromPeerId: 'relay', logicalRecipientPeerId: 'r2', orderingKey: 'game-2:self:1' })
            )
        ).toBe('AL repair ordering hints do not match the retained outbound message');
    });

    it('refuses a NACK that names another origin', async () => {
        const origin = await createOrderedOrigin('relayed-gap-other-origin');

        expect(
            await origin.accept(
                toGapNack(origin.msg, { fromPeerId: 'relay', logicalRecipientPeerId: 'r2', originPeerId: 'other' })
            )
        ).toBe('AL NACK names another origin than this outbound message owner');
        expect(await origin.accept(toGapNack(origin.msg, { fromPeerId: 'relay', logicalRecipientPeerId: 'r2' })))
            .toBe('committed');
    });

    it('admits the gap NACKs a relay re-sends for two recipients over one range, each its own hint', async () => {
        const origin = await createOrderedOrigin('relayed-gap-two-recipients');

        expect([
            await origin.accept(toGapNack(origin.msg, { fromPeerId: 'relay', logicalRecipientPeerId: 'r1' })),
            await origin.accept(toGapNack(origin.msg, { fromPeerId: 'relay', logicalRecipientPeerId: 'r2' }))
        ]).toEqual(['committed', 'committed']);
    });

    it('refuses a next hop\'s terminal NACK naming a recipient the receipt owes, keeping the receipt', async () => {
        const origin = await createOrderedOrigin('relayed-terminal-nack');
        const expired = newALNackControlMessage(
            { v: 4, msgId: 'expired-relay-r2', ts: Date.now(), senderId: 'relay', traceId: 'trace-relayed-gap' },
            toTestALNackPayload({
                msgId: origin.msg.id.msgId,
                fromPeerId: 'relay',
                toPeerId: 'self',
                logicalRecipientPeerId: 'r2',
                reason: 'expired',
                observedAtEpochMs: Date.now()
            })
        );

        expect(await origin.accept(expired)).toBe('AL repair sender has no retained outbound obligation');
        expect(await origin.accept(toForwardedAck(origin.msg, 'r2'))).toBe('committed');
    });

    it('admits a recipient\'s own gap NACK as an expected repair peer\'s, as before', async () => {
        const origin = await createOrderedOrigin('own-gap');

        expect(await origin.accept(toGapNack(origin.msg, { fromPeerId: 'r2', logicalRecipientPeerId: 'r2' })))
            .toBe('committed');
    });
});

describe('a gap NACK a next hop sends under a hop receipt', () => {
    it.each(['hop', 'subtree'] as const)('under %s, a next hop\'s gap NACK that names another hop is refused', async (mode) => {
        const origin = await createOrderedOrigin(`hop-gap-other-${mode}`, toHopTracking(mode));

        expect(await origin.accept(toGapNack(origin.msg, { fromPeerId: 'h1', logicalRecipientPeerId: 'h2' })))
            .toContain('AL gap NACK speaks for another recipient under a hop receipt');
        expect(await readRepairHintRows(origin.stores)).toEqual([]);
    });

    it.each(['hop', 'subtree'] as const)('under %s, a next hop\'s own gap NACK raises its repair hint', async (mode) => {
        const origin = await createOrderedOrigin(`hop-gap-own-${mode}`, toHopTracking(mode));

        expect(await origin.accept(toGapNack(origin.msg, { fromPeerId: 'h2', logicalRecipientPeerId: 'h2' })))
            .toBe('committed');
        expect(await readRepairHintRows(origin.stores)).toHaveLength(1);
    });
});

/** Every retained repair-hint work row. */
async function readRepairHintRows(stores: OutboundTestStores): Promise<readonly string[]> {
    const rows = await Promise.all(
        (await stores.workQueue.getAllKeys()).map((key) => stores.workQueue.getItem(key))
    );
    return rows.flatMap((row) => row?.resource.includes('"kind":"repair-hint"') ? [row.resource] : []);
}

describe('a gap request asked again at the origin', () => {
    it('answers a gap NACK equal to one it admitted `duplicate`, and admits the same NACK with the next number', async () => {
        const origin = await createOrderedOrigin('gap-asked-again');
        const gap = { fromPeerId: 'r2', logicalRecipientPeerId: 'r2' };

        expect([
            await origin.accept(toGapNack(origin.msg, { ...gap, controlMsgId: 'gap-1' })),
            await origin.admit(toGapNack(origin.msg, { ...gap, controlMsgId: 'gap-1-again' })),
            await origin.accept(toGapNack(origin.msg, { ...gap, controlMsgId: 'gap-2', gapRequestNumber: 2 }))
        ]).toEqual(['committed', { kind: 'duplicate', reason: 'AL control was already admitted' }, 'committed']);
    });

    it('answers a repair request equal to one it admitted `duplicate`, and admits the same request with the next number', async () => {
        const origin = await createOrderedOrigin('repair-asked-again');

        expect([
            await origin.accept(toMissingSeqRequest(origin.msg, 'repair-1', 1)),
            await origin.admit(toMissingSeqRequest(origin.msg, 'repair-1-again', 1)),
            await origin.accept(toMissingSeqRequest(origin.msg, 'repair-2', 2))
        ]).toEqual(['committed', { kind: 'duplicate', reason: 'AL control was already admitted' }, 'committed']);
    });
});

describe('a repeat at the origin', () => {
    it('a repeated ACK is refused `duplicate`', async () => {
        const origin = await createOrderedOrigin('ack-repeated');
        expect(await origin.accept(toForwardedAck(origin.msg, 'r1'))).toBe('committed');

        expect(await origin.admit(toForwardedAck(origin.msg, 'r1'))).toEqual({
            kind: 'duplicate',
            reason: 'AL control was already admitted; AL acknowledgement confirms a peer the receipt already counted'
        });
    });

    it('a repeated control whose proof is refused stays `rejected`', async () => {
        const origin = await createOrderedOrigin(
            'ack-repeated-unsigned',
            { ...RECEIVER_TRACKING, expectedPeerIds: ['peer-1', 'r2'] },
            {
                kind: 'signature',
                verifier: new RtcReceiptProofVerifier({ crypto: ROOM_PUBLICATION_CRYPTO, nowEpochMs: Date.now })
            }
        );
        const unsigned = toTestALAckPayload({
            ackedMsgId: origin.msg.id.msgId,
            fromPeerId: 'peer-1',
            toPeerId: 'self',
            observedAtEpochMs: Date.now()
        });
        const signed = await signTestALReceiptControl(ROOM_PUBLICATION_CRYPTO, { type: 'ack', payload: unsigned });
        expect(await origin.accept(toAckMessage('ack-signed', signed.payload))).toBe('committed');

        expect(await origin.admit(toAckMessage('ack-unsigned', unsigned))).toEqual({
            kind: 'rejected',
            reason: expect.stringMatching(/^AL control was already admitted; AL control proof is refused: /),
            proofRefusal: expect.anything()
        });
    });

    it('a duplicate that is also addressed to another owner stays `rejected`', async () => {
        const origin = await createOrderedOrigin('ack-repeated-other-owner');
        expect(await origin.accept(toForwardedAck(origin.msg, 'r1'))).toBe('committed');
        const repeat = toTestALAckPayload({
            ackedMsgId: origin.msg.id.msgId,
            fromPeerId: 'relay',
            toPeerId: 'other-owner',
            originPeerId: 'self',
            logicalRecipientPeerId: 'r1',
            observedAtEpochMs: Date.now()
        });

        expect(await origin.accept(toAckMessage('ack-other-owner', repeat))).toBe(
            'AL control is addressed to another outbound message owner; AL control was already admitted; ' +
                'AL acknowledgement confirms a peer the receipt already counted'
        );
    });
});

/** The ACK `payload` as the control `controlMsgId` its `fromPeerId` sends. */
function toAckMessage(controlMsgId: string, payload: ALAckPayload): ALMessage {
    return newALAckControlMessage(
        { v: 4, msgId: controlMsgId, ts: Date.now(), senderId: payload.fromPeerId, traceId: 'trace-repeat' },
        payload
    );
}

describe('a forwarded hop-end at the origin', () => {
    it('admits a forwarded hop-end that confirms nobody for a recipient the receipt still owes', async () => {
        const origin = await createOrderedOrigin('forwarded-not-subscribed');

        expect(await origin.accept(toForwardedAck(origin.msg, 'r2', 'subtree-complete-not-subscribed'))).toBe('committed');
        expect(await origin.accept(toForwardedAck(origin.msg, 'r2'))).toBe(
            'AL acknowledgement confirms no peer of the pending outbound receipt'
        );
    });

    it('refuses a forwarded hop-end from a sender that is neither a next hop nor an expected repair peer', async () => {
        const origin = await createOrderedOrigin('forwarded-not-subscribed-stranger');

        expect(await origin.accept(toForwardedAck(origin.msg, 'r2', 'subtree-complete-not-subscribed', 'x'))).toBe(
            'AL acknowledgement confirms no peer of the pending outbound receipt'
        );
        expect(await origin.accept(toForwardedAck(origin.msg, 'r2'))).toBe('committed');
    });
});

describe('a control for a message that has ended', () => {
    /** Both recipients confirmed the message: its receipt completed and ended it. */
    async function createEndedOrigin(id: string): Promise<OriginFixture> {
        const origin = await createOrderedOrigin(id);
        expect([
            await origin.accept(toForwardedAck(origin.msg, 'r1')),
            await origin.accept(toForwardedAck(origin.msg, 'r2'))
        ]).toEqual(['committed', 'committed']);
        return origin;
    }

    function toNack(msg: ALMessage, reason: 'not-yet-in-sync' | 'expired' | 'no-publish-grant', fromPeerId: string): ALMessage {
        return newALNackControlMessage(
            { v: 4, msgId: `${reason}-${fromPeerId}`, ts: Date.now(), senderId: fromPeerId, traceId: 'trace-ended' },
            toTestALNackPayload({ msgId: msg.id.msgId, fromPeerId, toPeerId: 'self', reason, observedAtEpochMs: Date.now() })
        );
    }

    it('admits a gap NACK numbered 4 and a missing-seq request: they name the message whose arrival revealed the gap', async () => {
        const origin = await createEndedOrigin('ended-gap-requests');

        expect([
            await origin.accept(toGapNack(origin.msg, { fromPeerId: 'r2', logicalRecipientPeerId: 'r2', gapRequestNumber: 4 })),
            await origin.accept(toMissingSeqRequest(origin.msg, 'ended-missing-seq', 1))
        ]).toEqual(['committed', 'committed']);
    });

    it.each(
        [
            { reason: 'not-yet-in-sync', fromPeerId: 'r2', source: 'peer' },
            { reason: 'expired', fromPeerId: 'r2', source: 'peer' },
            { reason: 'no-publish-grant', fromPeerId: 'server', source: 'trusted-server' }
        ] as const
    )('refuses a $reason NACK from $source', async ({ reason, fromPeerId, source }) => {
        const origin = await createEndedOrigin(`ended-${reason}`);

        expect(await origin.accept(toNack(origin.msg, reason, fromPeerId), source))
            .toBe('AL control names a message that has ended');
    });
});
