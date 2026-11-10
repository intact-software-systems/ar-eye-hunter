import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage, newALNackControlMessage, type ALAckStatus } from '@shared/al-contracts/al-control.ts';
import type {
    ALOutboundAckTrackingPlan,
    ALOutboundSettlementFact
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';

import {
    createDefaultOutboundTestRuntime,
    createOutboundMessage,
    enqueueOutboundOrThrow
} from '../outbound-runtime-test-fixture.ts';

import { toTestALAckPayload, toTestALNackPayload } from '../../../al-control-test-payloads.ts';

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

async function createOriginFixture(
    id: string,
    tracking: ALOutboundAckTrackingPlan = RECEIVER_TRACKING
): Promise<OriginFixture> {
    const facts: ALOutboundSettlementFact[] = [];
    const runtime = createDefaultOutboundTestRuntime({
        settlements: (fact) => facts.push(fact),
        sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true }),
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            lane: 'volatile',
            preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
            ackTracking: tracking
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

/** The relay forwards a recipient's `not-subscribed` NACK, readdressed from itself (PL9, PL16). */
function toRelayedNack(msg: ALMessage, logicalRecipientPeerId: string, fromPeerId = 'relay'): ALMessage {
    return newALNackControlMessage(
        { v: 4, msgId: `nack-${logicalRecipientPeerId}`, ts: Date.now(), senderId: fromPeerId, traceId: 'trace-outside' },
        toTestALNackPayload({
            msgId: msg.id.msgId,
            fromPeerId,
            toPeerId: 'self',
            logicalRecipientPeerId,
            reason: 'not-subscribed',
            observedAtEpochMs: Date.now()
        })
    );
}

/** A recipient's own `before-entry` NACK: the frozen copy reached it below the position it entered the track at. */
function toBeforeEntryNack(msg: ALMessage, logicalRecipientPeerId: string): ALMessage {
    return newALNackControlMessage(
        { v: 4, msgId: `before-entry-${logicalRecipientPeerId}`, ts: Date.now(), senderId: logicalRecipientPeerId, traceId: 'trace-outside' },
        toTestALNackPayload({
            msgId: msg.id.msgId,
            fromPeerId: logicalRecipientPeerId,
            toPeerId: 'self',
            logicalRecipientPeerId,
            reason: 'before-entry',
            observedAtEpochMs: Date.now()
        })
    );
}

interface OwnAck {
    readonly fromPeerId: string;
    readonly status: ALAckStatus;
}

/** A recipient's own ACK a relay forwards from below it, or a direct hop's own ACK naming itself. */
function toRelayedAck(msg: ALMessage, logicalRecipientPeerId: string, own?: OwnAck): ALMessage {
    const fromPeerId = own?.fromPeerId ?? 'relay';
    return newALAckControlMessage(
        { v: 4, msgId: `ack-${logicalRecipientPeerId}-${own?.status ?? 'delivered'}`, ts: Date.now(), senderId: fromPeerId, traceId: 'trace-outside' },
        toTestALAckPayload({
            ackedMsgId: msg.id.msgId,
            fromPeerId,
            toPeerId: 'self',
            originPeerId: 'self',
            logicalRecipientPeerId,
            carrier: 'rtc',
            status: own?.status ?? 'delivered',
            observedAtEpochMs: Date.now()
        })
    );
}

function toAcknowledgements(facts: readonly ALOutboundSettlementFact[]) {
    return facts.flatMap((fact) =>
        fact.kind === 'acknowledgement'
            ? [{
                confirmed: fact.confirmedRecipientPeerIds,
                unconfirmed: fact.unconfirmedRecipientPeerIds,
                outside: fact.outsideAudienceRecipientPeerIds,
                confirmedHops: fact.confirmedHopPeerIds,
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

        expect(toAcknowledgements(origin.facts)).toEqual([{ confirmed: [], unconfirmed: ['r1'], outside: ['r2'], confirmedHops: [], complete: false }]);
        expect(origin.facts.map((fact) => fact.kind)).toEqual(['acknowledgement']);
    });

    it('completes with one recipient confirmed and one outside, stating no refusal', async () => {
        const origin = await createOriginFixture('outside-completes');

        await origin.accept(toRelayedNack(origin.msg, 'r2'));
        expect(await origin.accept(toRelayedAck(origin.msg, 'r1'))).toBe('committed');

        expect(toAcknowledgements(origin.facts).at(-1)).toEqual({ confirmed: ['r1'], unconfirmed: [], outside: ['r2'], confirmedHops: [], complete: true });
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

    // I1: a relayed NACK comes from a next hop of this message or from a peer the receipt expects, never a bystander.
    it('refuses a NACK from a peer that is neither a hop of the message nor a recipient the receipt expects', async () => {
        const origin = await createOriginFixture('outside-bystander');

        expect(await origin.accept(toRelayedNack(origin.msg, 'r2', 'bystander')))
            .toBe('AL not-subscribed NACK comes from no hop or recipient of this message');
        expect(origin.facts).toEqual([]);
    });

    it('admits a recipient\'s own NACK beside the relay\'s', async () => {
        const origin = await createOriginFixture('outside-own');

        expect(await origin.accept(toRelayedNack(origin.msg, 'r2', 'r2'))).toBe('committed');
    });

    it('keeps a receipt whose every recipient is outside open, and states receipt-exhausted at its deadline', async () => {
        vi.useFakeTimers();
        const origin = await createOriginFixture('all-outside');

        await origin.accept(toRelayedNack(origin.msg, 'r1'));
        await origin.accept(toRelayedNack(origin.msg, 'r2'));
        expect(toAcknowledgements(origin.facts).at(-1)).toEqual({ confirmed: [], unconfirmed: [], outside: ['r1', 'r2'], confirmedHops: [], complete: false });

        await vi.advanceTimersByTimeAsync(102);

        expect(origin.facts.at(-1)).toMatchObject({
            kind: 'receipt-exhausted',
            confirmedPeerIds: [],
            unconfirmedPeerIds: [],
            outsideAudiencePeerIds: ['r1', 'r2'],
            cause: 'budget'
        });
    });

    describe('beside the hop view', () => {
        const DIRECT_HOPS: ALOutboundAckTrackingPlan = { ...RECEIVER_TRACKING, nextHopPeerIds: ['r1', 'r2'] };

        it('admits a not-subscribed hop\'s completion ACK as the end of that hop, confirming nobody', async () => {
            const origin = await createOriginFixture('outside-hop-completed', DIRECT_HOPS);

            await origin.accept(toRelayedNack(origin.msg, 'r2', 'r2'));
            expect(await origin.accept(toRelayedAck(origin.msg, 'r2', { fromPeerId: 'r2', status: 'subtree-complete-not-subscribed' })))
                .toBe('committed');

            expect(toAcknowledgements(origin.facts).at(-1)).toEqual({
                confirmed: [],
                unconfirmed: ['r1'],
                outside: ['r2'],
                confirmedHops: ['r2'],
                complete: false
            });
        });

        // I2: the origin reads a direct hop's confirms-nobody completion as its NACK, as every relay does.
        it('records a not-subscribed hop outside from its completion ACK when its NACK was lost', async () => {
            const origin = await createOriginFixture('outside-nack-lost', DIRECT_HOPS);

            await origin.accept(toRelayedAck(origin.msg, 'r1', { fromPeerId: 'r1', status: 'delivered' }));
            expect(await origin.accept(toRelayedAck(origin.msg, 'r2', { fromPeerId: 'r2', status: 'subtree-complete-not-subscribed' })))
                .toBe('committed');

            expect(toAcknowledgements(origin.facts).at(-1)).toEqual({
                confirmed: ['r1'],
                unconfirmed: [],
                outside: ['r2'],
                confirmedHops: ['r1', 'r2'],
                complete: true
            });
        });

        it('states the hops the ACKs completed when a NACK completes the receipt after them', async () => {
            const origin = await createOriginFixture('outside-after-ack', DIRECT_HOPS);

            await origin.accept(toRelayedAck(origin.msg, 'r1', { fromPeerId: 'r1', status: 'delivered' }));
            expect(await origin.accept(toRelayedNack(origin.msg, 'r2', 'r2'))).toBe('committed');

            expect(toAcknowledgements(origin.facts).at(-1)).toEqual({
                confirmed: ['r1'],
                unconfirmed: [],
                outside: ['r2'],
                confirmedHops: ['r1'],
                complete: true
            });
        });
    });
});

describe('a before-entry NACK at the origin', () => {
    it('records the recipient outside the audience as a not-subscribed NACK does, without ending the receipt', async () => {
        const origin = await createOriginFixture('before-entry-recorded');

        expect(await origin.accept(toBeforeEntryNack(origin.msg, 'r2'))).toBe('committed');

        expect(toAcknowledgements(origin.facts)).toEqual([{ confirmed: [], unconfirmed: ['r1'], outside: ['r2'], confirmedHops: [], complete: false }]);
        expect(origin.facts.map((fact) => fact.kind)).toEqual(['acknowledgement']);
    });

    it('ignores a repeated before-entry NACK, and one for a recipient already recorded outside by a not-subscribed NACK', async () => {
        const origin = await createOriginFixture('before-entry-repeated');
        await origin.accept(toBeforeEntryNack(origin.msg, 'r2'));
        await origin.accept(toRelayedNack(origin.msg, 'r1'));

        expect([
            await origin.accept(toBeforeEntryNack(origin.msg, 'r2')),
            await origin.accept(toBeforeEntryNack(origin.msg, 'r1'))
        ]).toEqual([
            'AL control was already admitted; AL before-entry NACK names no recipient the receipt still owes',
            'AL before-entry NACK names no recipient the receipt still owes'
        ]);
        expect(toAcknowledgements(origin.facts).at(-1)?.outside).toEqual(['r1', 'r2']);
    });

    it('refuses a before-entry NACK naming a recipient the receipt never expected', async () => {
        const origin = await createOriginFixture('before-entry-unknown');

        expect(await origin.accept(toBeforeEntryNack(origin.msg, 'stranger')))
            .toContain('AL before-entry NACK names no recipient the receipt still owes');
        expect(origin.facts).toEqual([]);
    });
});

describe('a gap NACK on a track the server relays to the audience it admitted (P2)', () => {
    /** Sequence 3 of the owner's track, relayed with no receipt to the audience a server admitted: `b` alone. */
    async function createRelayedTrack(): Promise<{ readonly msg: ALMessage; accept(control: ALMessage): Promise<string>; }> {
        const runtime = createDefaultOutboundTestRuntime({
            sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true }),
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                lane: 'volatile',
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
                admittedAudience: ['b']
            })
        });
        const msg: ALMessage = { ...createOutboundMessage('relayed-track'), ordering: { orderingKey: 'game-1', epoch: 1, seq: 3 } };
        await enqueueOutboundOrThrow(runtime, msg);
        return {
            msg,
            accept: async (control) => {
                const result = await runtime.acceptControlMessage(control, 'peer');
                return result.kind === 'rejected' ? result.reason : result.kind;
            }
        };
    }

    function toGapNack(msg: ALMessage, fromPeerId: string): ALMessage {
        return newALNackControlMessage(
            { v: 4, msgId: `gap-${fromPeerId}`, ts: Date.now(), senderId: fromPeerId, traceId: 'trace-relayed-track' },
            toTestALNackPayload({
                msgId: msg.id.msgId,
                fromPeerId,
                toPeerId: 'self',
                logicalRecipientPeerId: fromPeerId,
                reason: 'gap',
                observedAtEpochMs: Date.now(),
                orderingKey: 'game-1:self:1',
                expectedSeq: 2,
                missingRanges: [{ from: 2, to: 2 }]
            })
        );
    }

    it('admits the gap NACK of a session inside the admitted audience as it admits an expected repair peer', async () => {
        const origin = await createRelayedTrack();

        expect(await origin.accept(toGapNack(origin.msg, 'b'))).toBe('committed');
    });

    it('refuses the gap NACK of a session outside the admitted audience', async () => {
        const origin = await createRelayedTrack();

        expect(await origin.accept(toGapNack(origin.msg, 'c'))).toBe('AL repair sender has no retained outbound obligation');
    });
});
