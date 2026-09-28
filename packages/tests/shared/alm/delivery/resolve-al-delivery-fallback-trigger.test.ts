import type {
    ALDeliveryAdmissionVerdict,
    ALDeliveryAttemptOutcome,
    ALDeliveryCarrier,
    ALDeliveryFallbackReason,
    ALDeliverySettlement
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import {
    AL_FALLBACK_NOT_READY_ATTEMPTS,
    isALDeliveryAdmissionFallbackVerdict,
    isALDeliveryFallbackPastDeadline,
    resolveALDeliveryFallbackTrigger,
    type ALDeliveryFallbackTrigger
} from '@shared/alm/delivery/resolve-al-delivery-fallback-trigger.ts';
import {
    describe,
    expect,
    expectTypeOf,
    it
} from 'vitest';

const MSG_ID = 'msg-1';

function toAttempt(
    outcome: ALDeliveryAttemptOutcome,
    attemptId: string,
    carrier: ALDeliveryCarrier = 'rtc'
): ALDeliverySettlement {
    return {
        kind: 'attempt-settled',
        msgId: MSG_ID,
        carrier,
        atMs: 1,
        attemptId,
        outcome,
        submissionAttempted: outcome === 'sent',
        detail: undefined,
        willRetry: outcome === 'not-ready'
    };
}

/** Folds settlements through the trigger the way the registry hook does, stopping at the first hand-over. */
function toTrigger(settlements: readonly ALDeliverySettlement[]): ALDeliveryFallbackTrigger {
    let trigger: ALDeliveryFallbackTrigger = { kind: 'continue', notReadyRun: 0 };
    for (const settlement of settlements) {
        if (trigger.kind === 'fall-back') {
            return trigger;
        }
        trigger = resolveALDeliveryFallbackTrigger({
            settlement,
            leg: 'rtc',
            notReadyRun: trigger.notReadyRun
        });
    }
    return trigger;
}

const RTC_ACKNOWLEDGEMENT: ALDeliverySettlement = {
    kind: 'acknowledgement',
    msgId: MSG_ID,
    carrier: 'rtc',
    atMs: 1,
    mode: 'receiver',
    confirmedHopPeerIds: [],
    unconfirmedHopPeerIds: ['relay-1'],
    expectedRecipientPeerIds: ['b'],
    confirmedRecipientPeerIds: [],
    unconfirmedRecipientPeerIds: ['b'],
    complete: false
};

describe('the declared retryable outcomes (D56)', () => {
    it('declares the not-ready bound and the three post-admission reasons', () => {
        expect(AL_FALLBACK_NOT_READY_ATTEMPTS).toBe(3);
        expectTypeOf<ALDeliveryFallbackReason>().toEqualTypeOf<'not-ready' | 'not-yet-in-sync-exhausted' | 'receipt-exhausted'>();
    });

    it.each(
        [
            [{ kind: 'unroutable', reason: 'no-route', detail: 'no route' }, true],
            [{ kind: 'unroutable', reason: 'circuit-open', detail: 'open' }, true],
            [{ kind: 'unroutable', reason: 'rate-limited', detail: 'limited' }, true],
            [{ kind: 'refused', reason: 'unsupported', detail: 'receiver over rtc' }, true],
            [{ kind: 'refused', reason: 'unauthorized', detail: 'denied' }, false],
            [{ kind: 'admitted', durable: false, queuedAttempts: 1 }, false],
            [{ kind: 'expired', detail: 'late' }, false]
        ] satisfies ReadonlyArray<readonly [ALDeliveryAdmissionVerdict, boolean]>
    )('hands %o to the fallback carrier at admission: %s', (verdict, expected) => {
        expect(isALDeliveryAdmissionFallbackVerdict(verdict)).toBe(expected);
    });

    // One guard for the admission-time and the post-admission decision: the deadline instant is already past.
    it.each(
        [
            [undefined, 1_000, false],
            [1_001, 1_000, false],
            [1_000, 1_000, true],
            [999, 1_000, true]
        ] as const
    )('reads a deadline of %s at %s as past: %s', (expiresAtMs, nowMs, expected) => {
        expect(isALDeliveryFallbackPastDeadline(expiresAtMs, nowMs)).toBe(expected);
    });

    it('hands the RTC leg over on its third consecutive not-ready attempt, across its send-prepared rows', () => {
        expect(toTrigger([toAttempt('not-ready', 'send-a'), toAttempt('not-ready', 'send-b')]))
            .toEqual({ kind: 'continue', notReadyRun: 2 });
        expect(
            toTrigger([
                toAttempt('not-ready', 'send-a'),
                toAttempt('not-ready', 'send-b'),
                toAttempt('not-ready', 'send-a')
            ])
        )
            .toEqual({
                kind: 'fall-back',
                reason: 'not-ready',
                detail: '3 consecutive RTC attempts settled not-ready.'
            });
    });

    it('restarts the count on a sent attempt or an acknowledgement', () => {
        expect(
            toTrigger([
                toAttempt('not-ready', 'a'),
                toAttempt('not-ready', 'a'),
                toAttempt('sent', 'b'),
                toAttempt('not-ready', 'a')
            ])
        )
            .toEqual({ kind: 'continue', notReadyRun: 1 });
        expect(
            toTrigger([
                toAttempt('not-ready', 'a'),
                toAttempt('not-ready', 'a'),
                RTC_ACKNOWLEDGEMENT,
                toAttempt('not-ready', 'a')
            ])
        )
            .toEqual({ kind: 'continue', notReadyRun: 1 });
    });

    it('keeps the count across settlements that say nothing about whether the leg carries', () => {
        const started: ALDeliverySettlement = {
            kind: 'attempt-started',
            msgId: MSG_ID,
            carrier: 'rtc',
            atMs: 1,
            attemptId: 'a'
        };
        expect(
            toTrigger([
                toAttempt('not-ready', 'a'),
                started,
                toAttempt('cancelled', 'b'),
                toAttempt('not-ready', 'a')
            ])
        )
            .toEqual({ kind: 'continue', notReadyRun: 2 });
    });

    it('hands over at once on a spent receipt or not-yet-in-sync budget', () => {
        expect(toTrigger([{
            kind: 'receipt-exhausted',
            msgId: MSG_ID,
            carrier: 'rtc',
            atMs: 1,
            mode: 'receiver',
            confirmedPeerIds: [],
            unconfirmedPeerIds: ['b'],
            detail: 'The receipt ran out of retries after 3 of 3.'
        }])).toEqual({
            kind: 'fall-back',
            reason: 'receipt-exhausted',
            detail: 'The receipt ran out of retries after 3 of 3.'
        });
        expect(toTrigger([{
            kind: 'not-yet-in-sync-exhausted',
            msgId: MSG_ID,
            carrier: 'rtc',
            atMs: 1,
            detail: 'The not-yet-in-sync retry budget of 3 ran out.'
        }])).toEqual({
            kind: 'fall-back',
            reason: 'not-yet-in-sync-exhausted',
            detail: 'The not-yet-in-sync retry budget of 3 ran out.'
        });
    });

    it('moves nothing on a settlement of another carrier', () => {
        expect(
            toTrigger([
                toAttempt('not-ready', 'a', 'ws'),
                toAttempt('not-ready', 'a', 'ws'),
                toAttempt('not-ready', 'a', 'ws')
            ])
        )
            .toEqual({ kind: 'continue', notReadyRun: 0 });
    });
});
