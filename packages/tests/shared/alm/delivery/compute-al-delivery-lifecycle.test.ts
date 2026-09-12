import type { ALAckMode } from '@shared/al-contracts/al-contract.ts';
import {
    AL_DELIVERY_ADMITTED_STATES,
    AL_DELIVERY_STATES,
    createInitialALDeliveryLifecycle,
    isALDeliveryTerminal,
    isALDeliveryTerminalState,
    type ALDeliveryAdmissionVerdict,
    type ALDeliveryAttemptOutcome,
    type ALDeliveryLifecycle,
    type ALDeliverySettlement
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { computeALDeliveryLifecycle } from '@shared/alm/delivery/compute-al-delivery-lifecycle.ts';
import {
    describe,
    expect,
    it
} from 'vitest';

const MSG_ID = 'msg-1';
const SUBMITTED_AT_MS = 1_000;
const AT_MS = 2_000;
const AL_ACK_MODES = ['none', 'receiver'] as const;

describe.each(AL_ACK_MODES)('computeALDeliveryLifecycle transition table (ackMode=%s)', (ackMode) => {
    describe('admission settlement', () => {
        it.each([
            { queuedAttempts: 0, expectedState: 'accepted' as const },
            { queuedAttempts: 4, expectedState: 'queued' as const }
        ])('admitted verdict moves to $expectedState when queuedAttempts=$queuedAttempts', ({ queuedAttempts, expectedState }) => {
            const previous = createLifecycle(ackMode);
            const next = computeALDeliveryLifecycle(
                previous,
                toAdmissionSettlement(previous.msgId, { kind: 'admitted', durable: true, queuedAttempts })
            );

            expect(next.state).toBe(expectedState);
            expect(next.evidence.admittedAtMs).toBe(AT_MS);
            expectSameIdentity(next, previous);
        });

        it.each([{}])('duplicate verdict moves to accepted and records admittedAtMs', () => {
            const previous = createLifecycle(ackMode);
            const next = computeALDeliveryLifecycle(previous, toAdmissionSettlement(previous.msgId, { kind: 'duplicate' }));

            expect(next.state).toBe('accepted');
            expect(next.evidence.admittedAtMs).toBe(AT_MS);
            expectSameIdentity(next, previous);
        });

        it.each([{}])('pending verdict leaves a freshly submitted lifecycle unchanged', () => {
            const previous = createLifecycle(ackMode);
            const next = computeALDeliveryLifecycle(previous, toAdmissionSettlement(previous.msgId, { kind: 'pending' }));

            expect(next.state).toBe('submitted');
            expect(next.evidence).toEqual(previous.evidence);
        });

        it.each([{}])('deferred verdict moves to pending-authority without setting a reason', () => {
            const previous = createLifecycle(ackMode);
            const next = computeALDeliveryLifecycle(
                previous,
                toAdmissionSettlement(previous.msgId, { kind: 'deferred', reason: 'not-yet-in-sync', detail: 'catching up' })
            );

            expect(next.state).toBe('pending-authority');
            expect(next.evidence.reason).toBeUndefined();
        });

        it.each([{}])('refused verdict moves to rejected and records the detail as the reason', () => {
            const previous = createLifecycle(ackMode);
            const next = computeALDeliveryLifecycle(
                previous,
                toAdmissionSettlement(previous.msgId, {
                    kind: 'refused',
                    reason: 'unauthorized',
                    detail: 'sender is not a group member'
                })
            );

            expect(next.state).toBe('rejected');
            expect(next.evidence.reason).toBe('sender is not a group member');
        });

        it.each([{}])('unroutable verdict leaves the state unchanged and appends a synthetic attempt row', () => {
            const previous = createLifecycle(ackMode);
            const next = computeALDeliveryLifecycle(
                previous,
                toAdmissionSettlement(previous.msgId, { kind: 'unroutable', reason: 'no-route', detail: 'no rtc peers' })
            );

            expect(next.state).toBe('submitted');
            expect(next.evidence.attempts).toEqual([
                {
                    attemptId: `admission:rtc:${AT_MS}`,
                    carrier: 'rtc',
                    startedAtMs: AT_MS,
                    settledAtMs: AT_MS,
                    outcome: 'unroutable',
                    submissionAttempted: false,
                    detail: 'no rtc peers'
                }
            ]);
        });

        it.each([
            { kind: 'superseded' as const },
            { kind: 'expired' as const },
            { kind: 'failed' as const }
        ])('$kind verdict moves the lifecycle to $kind and records the reason', ({ kind }) => {
            const previous = createLifecycle(ackMode);
            const next = computeALDeliveryLifecycle(
                previous,
                toAdmissionSettlement(previous.msgId, { kind, detail: `${kind}-detail` })
            );

            expect(next.state).toBe(kind);
            expect(next.evidence.reason).toBe(`${kind}-detail`);
        });

        it.each([
            'disposed' as const,
            'repair-exhausted' as const,
            'pending-terminated' as const,
            'planner-drop' as const
        ])('skipped verdict (%s) moves the lifecycle to failed and records the reason', (reason) => {
            const previous = createLifecycle(ackMode);
            const next = computeALDeliveryLifecycle(
                previous,
                toAdmissionSettlement(previous.msgId, { kind: 'skipped', reason, detail: 'owner disposed before admitting' })
            );

            expect(next.state).toBe('failed');
            expect(next.evidence.reason).toBe('owner disposed before admitting');
        });
    });

    describe('attempts-exhausted settlement', () => {
        it.each([{}])('moves the lifecycle to failed and records the reason', () => {
            const previous = createLifecycle(ackMode);
            const next = computeALDeliveryLifecycle(previous, {
                kind: 'attempts-exhausted',
                msgId: previous.msgId,
                carrier: 'ws',
                atMs: AT_MS,
                detail: 'no carrier left to try'
            });

            expect(next.state).toBe('failed');
            expect(next.evidence.reason).toBe('no carrier left to try');
        });
    });

    describe('attempt-started settlement', () => {
        it.each([{}])('leaves the state unchanged and appends an open attempt row', () => {
            const previous = createLifecycle(ackMode);
            const next = computeALDeliveryLifecycle(previous, toAttemptStartedSettlement('attempt-1'));

            expect(next.state).toBe('submitted');
            expect(next.evidence.attempts).toEqual([
                {
                    attemptId: 'attempt-1',
                    carrier: 'rtc',
                    startedAtMs: AT_MS,
                    settledAtMs: undefined,
                    outcome: undefined,
                    submissionAttempted: false,
                    detail: undefined
                }
            ]);
        });

        it.each([{}])('leaves an existing attempt row alone when the attemptId already exists', () => {
            const opened = computeALDeliveryLifecycle(createLifecycle(ackMode), toAttemptStartedSettlement('attempt-1'));
            const next = computeALDeliveryLifecycle(opened, {
                kind: 'attempt-started',
                msgId: opened.msgId,
                carrier: 'rtc',
                atMs: AT_MS + 500,
                attemptId: 'attempt-1'
            });

            expect(next.evidence.attempts).toBe(opened.evidence.attempts);
        });
    });

    describe('attempt-settled settlement', () => {
        it.each([true, false])(
            'sent outcome moves to transport-accepted and settles the row (submissionAttempted=%s)',
            (submissionAttempted) => {
                const opened = computeALDeliveryLifecycle(createLifecycle(ackMode), toAttemptStartedSettlement('attempt-1'));
                const next = computeALDeliveryLifecycle(
                    opened,
                    toAttemptSettledSettlement({
                        attemptId: 'attempt-1',
                        outcome: 'sent',
                        submissionAttempted,
                        willRetry: false,
                        detail: undefined
                    })
                );

                expect(next.state).toBe('transport-accepted');
                expect(next.evidence.attempts).toEqual([
                    {
                        attemptId: 'attempt-1',
                        carrier: 'rtc',
                        startedAtMs: AT_MS,
                        settledAtMs: AT_MS,
                        outcome: 'sent',
                        submissionAttempted,
                        detail: undefined
                    }
                ]);
            }
        );

        it.each(['not-ready', 'failed', 'no-targets', 'cancelled'] as const)(
            '%s outcome with willRetry=true leaves the state unchanged and settles the row',
            (outcome) => {
                const opened = computeALDeliveryLifecycle(createLifecycle(ackMode), toAttemptStartedSettlement('attempt-1'));
                const next = computeALDeliveryLifecycle(
                    opened,
                    toAttemptSettledSettlement({
                        attemptId: 'attempt-1',
                        outcome,
                        submissionAttempted: true,
                        willRetry: true,
                        detail: `${outcome}-detail`
                    })
                );

                expect(next.state).toBe('submitted');
                expect(next.evidence.attempts[0]).toMatchObject({ outcome, settledAtMs: AT_MS });
            }
        );

        it.each(['failed', 'no-targets'] as const)(
            '%s outcome with willRetry=false moves the lifecycle to failed',
            (outcome) => {
                const opened = computeALDeliveryLifecycle(createLifecycle(ackMode), toAttemptStartedSettlement('attempt-1'));
                const next = computeALDeliveryLifecycle(
                    opened,
                    toAttemptSettledSettlement({
                        attemptId: 'attempt-1',
                        outcome,
                        submissionAttempted: true,
                        willRetry: false,
                        detail: `${outcome}-final`
                    })
                );

                expect(next.state).toBe('failed');
                expect(next.evidence.reason).toBe(`${outcome}-final`);
            }
        );

        it.each([{}])('cancelled outcome with willRetry=false leaves the state unchanged and settles the row', () => {
            const opened = computeALDeliveryLifecycle(createLifecycle(ackMode), toAttemptStartedSettlement('attempt-1'));
            const next = computeALDeliveryLifecycle(
                opened,
                toAttemptSettledSettlement({
                    attemptId: 'attempt-1',
                    outcome: 'cancelled',
                    submissionAttempted: true,
                    willRetry: false,
                    detail: 'disposed before sending'
                })
            );

            expect(next.state).toBe('submitted');
            expect(next.evidence.attempts[0]).toMatchObject({ outcome: 'cancelled', settledAtMs: AT_MS });
        });

        it.each(['expired', 'superseded'] as const)(
            '%s outcome moves the lifecycle there regardless of willRetry',
            (outcome) => {
                const opened = computeALDeliveryLifecycle(createLifecycle(ackMode), toAttemptStartedSettlement('attempt-1'));
                const next = computeALDeliveryLifecycle(
                    opened,
                    toAttemptSettledSettlement({
                        attemptId: 'attempt-1',
                        outcome,
                        submissionAttempted: true,
                        willRetry: false,
                        detail: `${outcome}-detail`
                    })
                );

                expect(next.state).toBe(outcome);
                expect(next.evidence.reason).toBe(`${outcome}-detail`);
            }
        );

        it.each([{}])('settling an unknown attemptId appends a row using the settlement time as startedAtMs', () => {
            const previous = createLifecycle(ackMode);
            const next = computeALDeliveryLifecycle(
                previous,
                toAttemptSettledSettlement({
                    attemptId: 'attempt-unknown',
                    outcome: 'not-ready',
                    submissionAttempted: false,
                    willRetry: true,
                    detail: undefined
                })
            );

            expect(next.evidence.attempts).toEqual([
                {
                    attemptId: 'attempt-unknown',
                    carrier: 'rtc',
                    startedAtMs: AT_MS,
                    settledAtMs: AT_MS,
                    outcome: 'not-ready',
                    submissionAttempted: false,
                    detail: undefined
                }
            ]);
        });
    });

    describe('acknowledgement settlement', () => {
        it.each([true, false])('replaces the hop lists and moves to acknowledged only when complete=%s', (complete) => {
            const admitted = computeALDeliveryLifecycle(
                createLifecycle(ackMode),
                toAdmissionSettlement(MSG_ID, { kind: 'duplicate' })
            );
            const next = computeALDeliveryLifecycle(admitted, {
                kind: 'acknowledgement',
                msgId: admitted.msgId,
                carrier: 'rtc',
                atMs: AT_MS,
                confirmedHopPeerIds: ['peer-1'],
                unconfirmedHopPeerIds: ['peer-2'],
                complete
            });

            expect(next.state).toBe(complete ? 'acknowledged' : admitted.state);
            expect(next.evidence.confirmedHopPeerIds).toEqual(['peer-1']);
            expect(next.evidence.unconfirmedHopPeerIds).toEqual(['peer-2']);
        });
    });

    describe('expired settlement', () => {
        it.each([{}])('moves the lifecycle to expired and records the reason', () => {
            const previous = createLifecycle(ackMode);
            const next = computeALDeliveryLifecycle(previous, {
                kind: 'expired',
                msgId: previous.msgId,
                carrier: 'rtc',
                atMs: AT_MS,
                detail: 'deadline passed'
            });

            expect(next.state).toBe('expired');
            expect(next.evidence.reason).toBe('deadline passed');
        });
    });

    describe('cancelled settlement', () => {
        it.each([{}])('moves the lifecycle to cancelled with a fixed reason', () => {
            const previous = createLifecycle(ackMode);
            const next = computeALDeliveryLifecycle(previous, {
                kind: 'cancelled',
                msgId: previous.msgId,
                carrier: 'rtc',
                atMs: AT_MS
            });

            expect(next.state).toBe('cancelled');
            expect(next.evidence.reason).toBe('Cancelled by the sender.');
        });
    });
});

describe('pending verdict against an already pending-authority lifecycle', () => {
    it('keeps the lifecycle at pending-authority', () => {
        const deferred = computeALDeliveryLifecycle(
            createLifecycle('receiver'),
            toAdmissionSettlement(MSG_ID, { kind: 'deferred', reason: 'not-yet-in-sync', detail: 'catching up' })
        );
        expect(deferred.state).toBe('pending-authority');

        const next = computeALDeliveryLifecycle(deferred, toAdmissionSettlement(MSG_ID, { kind: 'pending' }));

        expect(next.state).toBe('pending-authority');
    });
});

describe('terminal guard', () => {
    it('keeps a terminal lifecycle unchanged while counting a late settlement and still appending the attempt row', () => {
        const cancelled = computeALDeliveryLifecycle(createLifecycle('receiver'), {
            kind: 'cancelled',
            msgId: MSG_ID,
            carrier: 'rtc',
            atMs: AT_MS
        });
        expect(isALDeliveryTerminal(cancelled)).toBe(true);

        const next = computeALDeliveryLifecycle(
            cancelled,
            toAttemptSettledSettlement({
                attemptId: 'late-attempt',
                outcome: 'sent',
                submissionAttempted: true,
                willRetry: false,
                detail: undefined
            })
        );

        expect(next.state).toBe('cancelled');
        expect(next.lateSettlementCount).toBe(1);
        expect(next.evidence.attempts).toEqual([
            {
                attemptId: 'late-attempt',
                carrier: 'rtc',
                startedAtMs: AT_MS,
                settledAtMs: AT_MS,
                outcome: 'sent',
                submissionAttempted: true,
                detail: undefined
            }
        ]);
    });

    it('keeps a terminal lifecycle unchanged on a late acknowledgement while replacing the hop lists', () => {
        const cancelled = computeALDeliveryLifecycle(createLifecycle('receiver'), {
            kind: 'cancelled',
            msgId: MSG_ID,
            carrier: 'rtc',
            atMs: AT_MS
        });
        expect(isALDeliveryTerminal(cancelled)).toBe(true);

        const next = computeALDeliveryLifecycle(cancelled, {
            kind: 'acknowledgement',
            msgId: cancelled.msgId,
            carrier: 'rtc',
            atMs: AT_MS + 1,
            confirmedHopPeerIds: ['peer-1'],
            unconfirmedHopPeerIds: ['peer-2'],
            complete: true
        });

        expect(next.state).toBe('cancelled');
        expect(next.lateSettlementCount).toBe(1);
        expect(next.evidence.confirmedHopPeerIds).toEqual(['peer-1']);
        expect(next.evidence.unconfirmedHopPeerIds).toEqual(['peer-2']);
    });

    it('only increments lateSettlementCount for a settlement kind other than attempt-settled or acknowledgement', () => {
        const cancelled = computeALDeliveryLifecycle(createLifecycle('receiver'), {
            kind: 'cancelled',
            msgId: MSG_ID,
            carrier: 'rtc',
            atMs: AT_MS
        });

        const next = computeALDeliveryLifecycle(cancelled, {
            kind: 'expired',
            msgId: MSG_ID,
            carrier: 'rtc',
            atMs: AT_MS + 1,
            detail: 'ignored'
        });

        expect(next).toEqual({ ...cancelled, lateSettlementCount: 1 });
    });
});

describe('transport-accepted terminality', () => {
    it.each([
        { ackMode: 'none' as const, expectedTerminal: true },
        { ackMode: 'receiver' as const, expectedTerminal: false },
        { ackMode: 'all-logical-recipients' as const, expectedTerminal: false },
        { ackMode: 'group-leader' as const, expectedTerminal: false }
    ])('is terminal only for ackMode=none (got $ackMode)', ({ ackMode, expectedTerminal }) => {
        expect(isALDeliveryTerminalState('transport-accepted', ackMode)).toBe(expectedTerminal);
    });

    it('matches isALDeliveryTerminal on a lifecycle that actually reached transport-accepted', () => {
        const opened = computeALDeliveryLifecycle(createLifecycle('none'), toAttemptStartedSettlement('attempt-1'));
        const sent = computeALDeliveryLifecycle(
            opened,
            toAttemptSettledSettlement({
                attemptId: 'attempt-1',
                outcome: 'sent',
                submissionAttempted: true,
                willRetry: false,
                detail: undefined
            })
        );

        expect(sent.state).toBe('transport-accepted');
        expect(isALDeliveryTerminal(sent)).toBe(true);
        expect(isALDeliveryTerminal({ ...sent, ackMode: 'receiver' })).toBe(false);
    });

    it('keeps an ackMode=none lifecycle at transport-accepted against a further settlement, through the reducer', () => {
        const opened = computeALDeliveryLifecycle(createLifecycle('none'), toAttemptStartedSettlement('attempt-1'));
        const sent = computeALDeliveryLifecycle(
            opened,
            toAttemptSettledSettlement({
                attemptId: 'attempt-1',
                outcome: 'sent',
                submissionAttempted: true,
                willRetry: false,
                detail: undefined
            })
        );
        expect(sent.state).toBe('transport-accepted');

        const next = computeALDeliveryLifecycle(sent, {
            kind: 'expired',
            msgId: sent.msgId,
            carrier: 'rtc',
            atMs: AT_MS + 1,
            detail: 'late expiry, ignored'
        });

        expect(next.state).toBe('transport-accepted');
        expect(next.lateSettlementCount).toBe(1);
    });
});

describe('attempt-settled failed/no-targets alongside another sent hop (ruling R3)', () => {
    it('leaves transport-accepted and settles both rows when another hop already carried the message', () => {
        const openedA = computeALDeliveryLifecycle(createLifecycle('receiver'), toAttemptStartedSettlement('attempt-a'));
        const sent = computeALDeliveryLifecycle(
            openedA,
            toAttemptSettledSettlement({
                attemptId: 'attempt-a',
                outcome: 'sent',
                submissionAttempted: true,
                willRetry: false,
                detail: undefined
            })
        );
        expect(sent.state).toBe('transport-accepted');

        const next = computeALDeliveryLifecycle(
            sent,
            toAttemptSettledSettlement({
                attemptId: 'attempt-b',
                outcome: 'failed',
                submissionAttempted: true,
                willRetry: false,
                detail: 'attempt-b failed'
            })
        );

        expect(next.state).toBe('transport-accepted');
        expect(next.evidence.attempts).toEqual([
            {
                attemptId: 'attempt-a',
                carrier: 'rtc',
                startedAtMs: AT_MS,
                settledAtMs: AT_MS,
                outcome: 'sent',
                submissionAttempted: true,
                detail: undefined
            },
            {
                attemptId: 'attempt-b',
                carrier: 'rtc',
                startedAtMs: AT_MS,
                settledAtMs: AT_MS,
                outcome: 'failed',
                submissionAttempted: true,
                detail: 'attempt-b failed'
            }
        ]);
    });

    it('still moves to failed when no attempt has outcome sent', () => {
        const opened = computeALDeliveryLifecycle(createLifecycle('receiver'), toAttemptStartedSettlement('attempt-a'));

        const next = computeALDeliveryLifecycle(
            opened,
            toAttemptSettledSettlement({
                attemptId: 'attempt-a',
                outcome: 'failed',
                submissionAttempted: true,
                willRetry: false,
                detail: 'no hop carried the message'
            })
        );

        expect(next.state).toBe('failed');
        expect(next.evidence.reason).toBe('no hop carried the message');
    });
});

describe('AL_DELIVERY_ADMITTED_STATES', () => {
    it('equals every delivery state except submitted', () => {
        expect(AL_DELIVERY_ADMITTED_STATES).toEqual(AL_DELIVERY_STATES.filter((state) => state !== 'submitted'));
        expect(AL_DELIVERY_ADMITTED_STATES).not.toContain('submitted');
    });
});

describe('immutability', () => {
    it('never mutates a frozen previous lifecycle and returns new objects', () => {
        const previous = deepFreeze(createLifecycle('receiver'));
        const beforeSnapshot = JSON.parse(JSON.stringify(previous));
        expect(Object.isFrozen(previous)).toBe(true);

        const next = computeALDeliveryLifecycle(previous, toAttemptStartedSettlement('attempt-1'));

        expect(previous).toEqual(beforeSnapshot);
        expect(next).not.toBe(previous);
        expect(next.evidence).not.toBe(previous.evidence);
        expect(next.evidence.attempts).not.toBe(previous.evidence.attempts);
    });
});

function createLifecycle(ackMode: ALAckMode): ALDeliveryLifecycle {
    return createInitialALDeliveryLifecycle({
        msgId: MSG_ID,
        typeId: 'chat.private-text.v1',
        ackMode,
        expiresAtMs: undefined,
        submittedAtMs: SUBMITTED_AT_MS
    });
}

function expectSameIdentity(next: ALDeliveryLifecycle, previous: ALDeliveryLifecycle): void {
    expect(next.msgId).toBe(previous.msgId);
    expect(next.typeId).toBe(previous.typeId);
    expect(next.ackMode).toBe(previous.ackMode);
    expect(next.expiresAtMs).toBe(previous.expiresAtMs);
}

function toAdmissionSettlement(
    msgId: string,
    verdict: ALDeliveryAdmissionVerdict
): Extract<ALDeliverySettlement, Readonly<{ kind: 'admission'; }>> {
    return { kind: 'admission', msgId, carrier: 'rtc', atMs: AT_MS, verdict };
}

function toAttemptStartedSettlement(
    attemptId: string
): Extract<ALDeliverySettlement, Readonly<{ kind: 'attempt-started'; }>> {
    return { kind: 'attempt-started', msgId: MSG_ID, carrier: 'rtc', atMs: AT_MS, attemptId };
}

interface AttemptSettledOverrides {
    readonly attemptId: string;
    readonly outcome: ALDeliveryAttemptOutcome;
    readonly submissionAttempted: boolean;
    readonly willRetry: boolean;
    readonly detail: string | undefined;
}

function toAttemptSettledSettlement(
    overrides: AttemptSettledOverrides
): Extract<ALDeliverySettlement, Readonly<{ kind: 'attempt-settled'; }>> {
    return {
        kind: 'attempt-settled',
        msgId: MSG_ID,
        carrier: 'rtc',
        atMs: AT_MS,
        attemptId: overrides.attemptId,
        outcome: overrides.outcome,
        submissionAttempted: overrides.submissionAttempted,
        detail: overrides.detail,
        willRetry: overrides.willRetry
    };
}

function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
    }
    return value;
}
