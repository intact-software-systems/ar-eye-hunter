import { describe, expect, it } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage, newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALOutboundAckTrackingPlan } from '@shared/alm/outbound/al-outbound-message-runtime.ts';

import {
    createDefaultOutboundTestRuntime,
    createOutboundMessage,
    enqueueOutboundOrThrow
} from '../outbound-runtime-test-fixture.ts';

import { toTestALAckPayload, toTestALNackPayload } from '../../../al-control-test-payloads.ts';

/** A `receiver` receipt on two frozen recipients, sent through one relay that is neither of them. */
const RECEIVER_TRACKING: ALOutboundAckTrackingPlan = {
    enabled: true,
    timeoutMs: 60_000,
    maxAttempts: 1,
    expectedPeerIds: ['r1', 'r2'],
    nextHopPeerIds: ['relay'],
    mode: 'receiver'
};

/** The origin's own track `game-1`, epoch 1, as the receiver's gap NACK names it. */
const TRACK_KEY = 'game-1:self:1';

interface OriginFixture {
    readonly msg: ALMessage;
    accept(control: ALMessage): Promise<string>;
}

/** Sequence 3 of the origin's track, sent with the receipt above. */
async function createOrderedOrigin(id: string): Promise<OriginFixture> {
    const runtime = createDefaultOutboundTestRuntime({
        sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true }),
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            lane: 'volatile',
            preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
            ackTracking: RECEIVER_TRACKING
        })
    });
    const msg: ALMessage = { ...createOutboundMessage(id), ordering: { orderingKey: 'game-1', epoch: 1, seq: 3 } };
    await enqueueOutboundOrThrow(runtime, msg);
    return {
        msg,
        accept: async (control) => {
            const result = await runtime.acceptControlMessage(control, 'peer');
            return result.kind === 'rejected' ? result.reason : result.kind;
        }
    };
}

interface GapNackInput {
    readonly fromPeerId: string;
    readonly logicalRecipientPeerId: string;
    readonly orderingKey?: string;
    readonly originPeerId?: string;
}

/** A gap NACK for sequence 2: a recipient's own, or one a relay forwards for the recipient it names. */
function toGapNack(msg: ALMessage, input: GapNackInput): ALMessage {
    return newALNackControlMessage(
        {
            v: 4,
            msgId: `gap-${input.fromPeerId}-${input.logicalRecipientPeerId}`,
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
            missingRanges: [{ from: 2, to: 2 }]
        })
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
