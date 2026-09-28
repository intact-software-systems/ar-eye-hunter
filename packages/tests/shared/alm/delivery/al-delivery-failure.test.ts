import type {
    ALDeliveryFailure,
    ALDeliveryReceiptExhaustedCause,
    ALDeliveryReceiptExhaustion
} from '@shared/alm/delivery/al-delivery-failure.ts';
import {
    createInitialALDeliveryLifecycle,
    type ALDeliveryAdmissionVerdict,
    type ALDeliveryAttemptOutcome,
    type ALDeliveryLifecycle,
    type ALDeliverySettlement,
    type ALDeliveryState
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import {
    computeALDeliveryDeadline,
    computeALDeliveryLifecycle,
    computeALDeliveryUnobservable
} from '@shared/alm/delivery/compute-al-delivery-lifecycle.ts';
import {
    describe,
    expect,
    expectTypeOf,
    it
} from 'vitest';

const MSG_ID = 'msg-1';
const AT_MS = 2_000;
const EXPIRES_AT_MS = 30_000;

type ReceiptAlgo = 'receiver' | 'none';

function createSubmittedLifecycle(receiptAlgo: ReceiptAlgo): ALDeliveryLifecycle {
    return createInitialALDeliveryLifecycle({
        msgId: MSG_ID,
        typeId: 'room.command.v1',
        ackMode: receiptAlgo,
        receiptAlgo,
        expiresAtMs: EXPIRES_AT_MS,
        submittedAtMs: 1_000
    });
}

function toEnded(
    settlements: readonly ALDeliverySettlement[],
    receiptAlgo: ReceiptAlgo = 'receiver'
): ALDeliveryLifecycle {
    return settlements.reduce(
        (lifecycle, settlement) => computeALDeliveryLifecycle(lifecycle, settlement),
        createSubmittedLifecycle(receiptAlgo)
    );
}

function toAdmission(
    verdict: ALDeliveryAdmissionVerdict,
    trackedReceiptAlgo: ReceiptAlgo = 'none'
): ALDeliverySettlement {
    return {
        kind: 'admission',
        msgId: MSG_ID,
        carrier: 'rtc',
        atMs: AT_MS,
        verdict,
        trackedReceiptAlgo
    };
}

function toAttemptSettled(outcome: ALDeliveryAttemptOutcome): ALDeliverySettlement {
    return {
        kind: 'attempt-settled',
        msgId: MSG_ID,
        carrier: 'rtc',
        atMs: AT_MS,
        attemptId: 'attempt-1',
        outcome,
        submissionAttempted: outcome === 'sent',
        detail: `attempt ${outcome}`,
        willRetry: false
    };
}

function toReceiptExhausted(exhaustion: ALDeliveryReceiptExhaustion): ALDeliverySettlement {
    return {
        kind: 'receipt-exhausted',
        msgId: MSG_ID,
        carrier: 'rtc',
        atMs: AT_MS,
        mode: 'receiver',
        confirmedPeerIds: ['b'],
        unconfirmedPeerIds: ['c'],
        ...exhaustion,
        detail: 'The receipt ended.'
    };
}

const ADMITTED = toAdmission({ kind: 'admitted', durable: false, queuedAttempts: 1 }, 'receiver');

const SERVER_REFUSAL: ALDeliverySettlement = {
    kind: 'relay-rejected',
    msgId: MSG_ID,
    carrier: 'ws',
    atMs: AT_MS,
    relayRejection: { relay: 'trusted-server', reason: 'unauthorized' },
    detail: 'The server refused the message: unauthorized.'
};

interface FailureCase {
    readonly meaning: string;
    readonly settlements: readonly ALDeliverySettlement[];
    readonly state: ALDeliveryState;
    readonly failure: ALDeliveryFailure;
    readonly reason: string;
}

// One row per failure meaning; the prose each end already stated stays beside it.
const FAILURE_CASES: readonly FailureCase[] = [
    {
        meaning: 'a carrier refusal no fallback took over',
        settlements: [
            toAdmission({ kind: 'refused', reason: 'unsupported', detail: 'receiver over rtc' })
        ],
        state: 'rejected',
        failure: { kind: 'refused', reason: 'unsupported' },
        reason: 'receiver over rtc'
    },
    {
        meaning: 'a refusal over the volatile bound (D78)',
        settlements: [
            toAdmission({
                kind: 'refused',
                reason: 'capacity',
                detail: 'The session is over its volatile bound.'
            })
        ],
        state: 'rejected',
        failure: { kind: 'refused', reason: 'capacity' },
        reason: 'The session is over its volatile bound.'
    },
    {
        meaning: 'a refusal by the trusted server',
        settlements: [ADMITTED, SERVER_REFUSAL],
        state: 'rejected',
        failure: {
            kind: 'relay-rejected',
            rejection: { relay: 'trusted-server', reason: 'unauthorized' }
        },
        reason: 'The server refused the message: unauthorized.'
    },
    {
        meaning: 'an admission that threw',
        settlements: [toAdmission({ kind: 'failed', detail: 'Storage unavailable' })],
        state: 'failed',
        failure: { kind: 'admission-failed' },
        reason: 'Storage unavailable'
    },
    {
        meaning: 'a skipped admission',
        settlements: [
            toAdmission({
                kind: 'skipped',
                reason: 'planner-drop',
                detail: 'Congestion dropped the message.'
            })
        ],
        state: 'failed',
        failure: { kind: 'skipped', reason: 'planner-drop' },
        reason: 'Congestion dropped the message.'
    },
    {
        meaning: 'no carrier left after an unroutable verdict',
        settlements: [
            toAdmission({
                kind: 'unroutable',
                reason: 'rate-limited',
                detail: 'rate-limited at rtc'
            }),
            {
                kind: 'attempts-exhausted',
                msgId: MSG_ID,
                carrier: 'rtc',
                atMs: AT_MS,
                reason: 'rate-limited',
                detail: 'rate-limited at rtc'
            }
        ],
        state: 'failed',
        failure: { kind: 'unroutable', reason: 'rate-limited' },
        reason: 'rate-limited at rtc'
    },
    {
        meaning: 'a failed attempt that will not retry',
        settlements: [ADMITTED, toAttemptSettled('failed')],
        state: 'failed',
        failure: { kind: 'attempt-failed', outcome: 'failed' },
        reason: 'attempt failed'
    },
    {
        meaning: 'an attempt that found no targets',
        settlements: [ADMITTED, toAttemptSettled('no-targets')],
        state: 'failed',
        failure: { kind: 'attempt-failed', outcome: 'no-targets' },
        reason: 'attempt no-targets'
    },
    {
        meaning: 'a spent receipt budget',
        settlements: [ADMITTED, toReceiptExhausted({ cause: 'budget' })],
        state: 'failed',
        failure: { kind: 'receipt-exhausted', cause: 'budget' },
        reason: 'The receipt ended.'
    },
    {
        meaning: 'a tracked hop that refused the message for good',
        settlements: [
            ADMITTED,
            toReceiptExhausted({ cause: 'hop-refused', hopPeerId: 'relay-1', nackReason: 'stale' })
        ],
        state: 'failed',
        failure: {
            kind: 'receipt-exhausted',
            cause: 'hop-refused',
            hopPeerId: 'relay-1',
            nackReason: 'stale'
        },
        reason: 'The receipt ended.'
    },
    {
        meaning: 'an expired admission',
        settlements: [
            toAdmission({
                kind: 'expired',
                detail: 'Message deadline elapsed before carrier admission.'
            })
        ],
        state: 'expired',
        failure: { kind: 'expired' },
        reason: 'Message deadline elapsed before carrier admission.'
    },
    {
        meaning: 'an expired attempt',
        settlements: [ADMITTED, toAttemptSettled('expired')],
        state: 'expired',
        failure: { kind: 'expired' },
        reason: 'attempt expired'
    },
    {
        meaning: 'a fallback past the deadline',
        settlements: [{
            kind: 'expired',
            msgId: MSG_ID,
            carrier: 'rtc',
            atMs: AT_MS,
            detail: 'Message deadline elapsed before fallback.'
        }],
        state: 'expired',
        failure: { kind: 'expired' },
        reason: 'Message deadline elapsed before fallback.'
    }
];

describe('the typed failure of a send that ended (D75, C2)', () => {
    it.each(FAILURE_CASES)(
        'states $failure.kind for $meaning and keeps the prose',
        ({ settlements, state, failure, reason }) => {
            const ended = toEnded(settlements);

            expect(ended.state).toBe(state);
            expect(ended.evidence.failure).toEqual(failure);
            expect(ended.evidence.reason).toBe(reason);
        }
    );

    it('states expired when an observer reads the deadline before any end', () => {
        const read = computeALDeliveryDeadline(toEnded([ADMITTED]), EXPIRES_AT_MS);

        expect(read.state).toBe('expired');
        expect(read.evidence.failure).toEqual({ kind: 'expired' });
        expect(read.evidence.reason).toBe('The deadline elapsed before a terminal settlement.');
    });

    it.each(
        [
            { meaning: 'a submitted send', settlements: [], state: 'submitted' },
            {
                meaning: 'a refused leg the fallback carrier took over',
                settlements: [{
                    kind: 'carrier-refused',
                    msgId: MSG_ID,
                    carrier: 'rtc',
                    atMs: AT_MS,
                    reason: 'unsupported',
                    detail: 'receiver over rtc'
                }],
                state: 'submitted'
            },
            {
                meaning: 'a superseded send',
                settlements: [ADMITTED, {
                    kind: 'superseded',
                    msgId: MSG_ID,
                    carrier: 'rtc',
                    atMs: AT_MS,
                    replacementMsgId: 'msg-2',
                    detail: 'Replaced.'
                }],
                state: 'superseded'
            },
            {
                meaning: 'a superseded attempt',
                settlements: [ADMITTED, toAttemptSettled('superseded')],
                state: 'superseded'
            },
            {
                meaning: 'a cancelled send',
                settlements: [ADMITTED, {
                    kind: 'cancelled',
                    msgId: MSG_ID,
                    carrier: 'rtc',
                    atMs: AT_MS
                }],
                state: 'cancelled'
            }
        ] satisfies ReadonlyArray<{
            meaning: string;
            settlements: readonly ALDeliverySettlement[];
            state: ALDeliveryState;
        }>
    )('states no failure for $meaning', ({ settlements, state }) => {
        const lifecycle = toEnded(settlements);

        expect(lifecycle.state).toBe(state);
        expect(lifecycle.evidence.failure).toBeUndefined();
    });

    it('states no failure when the observation is lost', () => {
        const lost = computeALDeliveryUnobservable(toEnded([ADMITTED]));

        expect(lost.state).toBe('unobservable');
        expect(lost.evidence.failure).toBeUndefined();
    });

    it('keeps a receipt-less send transport-accepted with no failure when a hop refuses it late (R-S2c-ii-5a)', () => {
        const ended = toEnded([
            toAdmission({ kind: 'admitted', durable: false, queuedAttempts: 1 }),
            toAttemptSettled('sent'),
            SERVER_REFUSAL
        ], 'none');

        expect(ended.state).toBe('transport-accepted');
        expect(ended.evidence.relayRejection).toEqual({
            relay: 'trusted-server',
            reason: 'unauthorized'
        });
        expect(ended.evidence.failure).toBeUndefined();
    });

    it('keeps the first failure when a relay refusal lands after the end', () => {
        const ended = toEnded([ADMITTED, toReceiptExhausted({ cause: 'budget' }), SERVER_REFUSAL]);

        expect(ended.state).toBe('failed');
        expect(ended.evidence.failure).toEqual({ kind: 'receipt-exhausted', cause: 'budget' });
        expect(ended.evidence.relayRejection).toEqual({
            relay: 'trusted-server',
            reason: 'unauthorized'
        });
    });

    it('names the two receipt-exhausted causes', () => {
        expectTypeOf<ALDeliveryReceiptExhaustion['cause']>().toEqualTypeOf<ALDeliveryReceiptExhaustedCause>();
    });
});
