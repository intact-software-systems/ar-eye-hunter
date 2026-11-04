import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage, newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import type {
    ALOutboundAckTrackingPlan,
    ALOutboundSettlementFact
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';

import {
    createDefaultOutboundTestRuntime,
    createOutboundMessage,
    enqueueOutboundOrThrow
} from '../outbound-runtime-test-fixture.ts';

/** A `receiver` receipt on two frozen recipients, sent through one relay that is neither of them. */
const RECEIVER_TRACKING: ALOutboundAckTrackingPlan = {
    enabled: true,
    timeoutMs: 100,
    maxAttempts: 0,
    expectedPeerIds: ['r1', 'r2'],
    nextHopPeerIds: ['relay'],
    mode: 'receiver'
};

interface OriginFixture {
    readonly msg: ALMessage;
    readonly facts: readonly ALOutboundSettlementFact[];
    accept(control: ALMessage): Promise<string>;
}

async function createOriginFixture(id: string): Promise<OriginFixture> {
    const facts: ALOutboundSettlementFact[] = [];
    const runtime = createDefaultOutboundTestRuntime({
        settlements: (fact) => facts.push(fact),
        sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true }),
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            lane: 'volatile',
            preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
            ackTracking: RECEIVER_TRACKING
        })
    });
    const msg = createOutboundMessage(id);
    await enqueueOutboundOrThrow(runtime, msg);
    // Only what the controls state from here on: the dispatch's own facts are not under test.
    facts.splice(0);
    return {
        msg,
        facts,
        accept: async (control) => {
            const result = await runtime.acceptControlMessage(control, 'peer');
            return result.kind === 'rejected' ? result.reason : result.kind;
        }
    };
}

/** The relay re-originates a recipient's `not-subscribed` NACK from itself (PL9, PL16). */
function toRelayedNack(msg: ALMessage, logicalRecipientPeerId: string): ALMessage {
    return newALNackControlMessage(
        { v: 4, msgId: `nack-${logicalRecipientPeerId}`, ts: Date.now(), senderId: 'relay', traceId: 'trace-outside' },
        {
            msgId: msg.id.msgId,
            fromPeerId: 'relay',
            toPeerId: 'self',
            logicalRecipientPeerId,
            reason: 'not-subscribed',
            observedAtEpochMs: Date.now()
        }
    );
}

function toRelayedAck(msg: ALMessage, logicalRecipientPeerId: string): ALMessage {
    return newALAckControlMessage(
        { v: 4, msgId: `ack-${logicalRecipientPeerId}`, ts: Date.now(), senderId: 'relay', traceId: 'trace-outside' },
        {
            ackedMsgId: msg.id.msgId,
            fromPeerId: 'relay',
            toPeerId: 'self',
            originPeerId: 'self',
            logicalRecipientPeerId,
            carrier: 'rtc',
            status: 'forwarded',
            observedAtEpochMs: Date.now()
        }
    );
}

function toAcknowledgements(facts: readonly ALOutboundSettlementFact[]) {
    return facts.flatMap((fact) =>
        fact.kind === 'acknowledgement'
            ? [{
                confirmed: fact.confirmedRecipientPeerIds,
                unconfirmed: fact.unconfirmedRecipientPeerIds,
                outside: fact.outsideAudienceRecipientPeerIds,
                complete: fact.complete
            }]
            : []
    );
}

describe('a not-subscribed NACK at the origin (PL10, PL16)', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('records the recipient outside the audience, whichever hop relayed it, without ending the receipt', async () => {
        const origin = await createOriginFixture('outside-recorded');

        expect(await origin.accept(toRelayedNack(origin.msg, 'r2'))).toBe('committed');

        expect(toAcknowledgements(origin.facts)).toEqual([{ confirmed: [], unconfirmed: ['r1'], outside: ['r2'], complete: false }]);
        expect(origin.facts.map((fact) => fact.kind)).toEqual(['acknowledgement']);
    });

    it('completes with one recipient confirmed and one outside, stating no refusal', async () => {
        const origin = await createOriginFixture('outside-completes');

        await origin.accept(toRelayedNack(origin.msg, 'r2'));
        expect(await origin.accept(toRelayedAck(origin.msg, 'r1'))).toBe('committed');

        expect(toAcknowledgements(origin.facts).at(-1)).toEqual({ confirmed: ['r1'], unconfirmed: [], outside: ['r2'], complete: true });
        expect(origin.facts.map((fact) => fact.kind)).toEqual(['acknowledgement', 'acknowledgement']);
    });

    it('ignores a repeated NACK, a NACK for a confirmed recipient and an ACK for one outside', async () => {
        const origin = await createOriginFixture('outside-repeated');
        await origin.accept(toRelayedNack(origin.msg, 'r2'));
        await origin.accept(toRelayedAck(origin.msg, 'r1'));

        expect([
            await origin.accept(toRelayedNack(origin.msg, 'r2')),
            await origin.accept(toRelayedNack(origin.msg, 'r1')),
            await origin.accept(toRelayedAck(origin.msg, 'r2'))
        ]).toEqual([
            'AL control was already admitted; AL not-subscribed NACK names no recipient the receipt still owes',
            'AL not-subscribed NACK names no recipient the receipt still owes',
            'AL acknowledgement confirms no peer of the pending outbound receipt'
        ]);
    });

    it('refuses a NACK naming a recipient the receipt never expected', async () => {
        const origin = await createOriginFixture('outside-unknown');

        expect(await origin.accept(toRelayedNack(origin.msg, 'stranger')))
            .toBe('AL not-subscribed NACK names no recipient the receipt still owes');
        expect(origin.facts).toEqual([]);
    });

    it('keeps a receipt whose every recipient is outside open, and states receipt-exhausted at its deadline', async () => {
        vi.useFakeTimers();
        const origin = await createOriginFixture('all-outside');

        await origin.accept(toRelayedNack(origin.msg, 'r1'));
        await origin.accept(toRelayedNack(origin.msg, 'r2'));
        expect(toAcknowledgements(origin.facts).at(-1)).toEqual({ confirmed: [], unconfirmed: [], outside: ['r1', 'r2'], complete: false });

        await vi.advanceTimersByTimeAsync(102);

        expect(origin.facts.at(-1)).toMatchObject({
            kind: 'receipt-exhausted',
            confirmedPeerIds: [],
            unconfirmedPeerIds: [],
            outsideAudiencePeerIds: ['r1', 'r2'],
            cause: 'budget'
        });
    });
});
