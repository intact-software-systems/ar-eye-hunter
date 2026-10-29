import {
    AL_DELIVERY_ADMITTED_STATES,
    AL_DELIVERY_STATES,
    createInitialALDeliveryLifecycle,
    isALDeliveryTerminal,
    type ALDeliveryLifecycle,
    type ALDeliverySettlement
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { computeALDeliveryLifecycle } from '@shared/alm/delivery/compute-al-delivery-lifecycle.ts';
import {
    describe,
    expect,
    it
} from 'vitest';

const MSG_ID = 'msg-live-1';
const TRACE_ID = 'trace-al-delivery-staged';
const STAGED_AT_MS = 1_500;
const SETTLED_AT_MS = 2_000;

describe('the staged delivery state (D468)', () => {
    it('moves a submitted lifecycle to staged and changes nothing else', () => {
        const submitted = toSubmittedLifecycle();
        const staged = computeALDeliveryLifecycle(submitted, toStagedSettlement());

        expect(staged).toEqual({ ...submitted, state: 'staged' });
        expect(isALDeliveryTerminal(staged)).toBe(false);
    });

    it.each([
        { queuedAttempts: 0, expectedState: 'accepted' as const },
        { queuedAttempts: 2, expectedState: 'queued' as const }
    ])('admits a staged lifecycle to $expectedState as it admits a submitted one', ({ queuedAttempts, expectedState }) => {
        const admission = toAdmissionSettlement(queuedAttempts);
        const fromStaged = computeALDeliveryLifecycle(toStagedLifecycle(), admission);
        const fromSubmitted = computeALDeliveryLifecycle(toSubmittedLifecycle(), admission);

        expect(fromStaged.state).toBe(expectedState);
        expect(fromStaged).toEqual(fromSubmitted);
    });

    it('ends a staged lifecycle superseded when a newer value displaces it', () => {
        const next = computeALDeliveryLifecycle(toStagedLifecycle(), {
            kind: 'superseded',
            msgId: MSG_ID,
            carrier: 'rtc',
            atMs: SETTLED_AT_MS,
            replacementMsgId: 'msg-live-2',
            detail: 'A newer live value replaced this one.',
            traceId: TRACE_ID
        });

        expect(next.state).toBe('superseded');
        expect(next.evidence.reason).toBe('A newer live value replaced this one.');
        expect(isALDeliveryTerminal(next)).toBe(true);
    });

    it('ends a staged lifecycle expired with the typed expired failure', () => {
        const next = computeALDeliveryLifecycle(toStagedLifecycle(), {
            kind: 'expired',
            msgId: MSG_ID,
            carrier: 'rtc',
            atMs: SETTLED_AT_MS,
            detail: 'The deadline passed before selection.',
            traceId: TRACE_ID
        });

        expect(next.state).toBe('expired');
        expect(next.evidence.failure).toEqual({ kind: 'expired' });
        expect(next.evidence.reason).toBe('The deadline passed before selection.');
    });

    it('ends a staged lifecycle failed when its stage is disposed', () => {
        const next = computeALDeliveryLifecycle(toStagedLifecycle(), {
            kind: 'admission',
            msgId: MSG_ID,
            carrier: 'rtc',
            atMs: SETTLED_AT_MS,
            verdict: { kind: 'skipped', reason: 'disposed', detail: 'The session ended.' },
            trackedReceiptAlgo: 'none',
            traceId: TRACE_ID
        });

        expect(next.state).toBe('failed');
        expect(next.evidence.failure).toEqual({ kind: 'skipped', reason: 'disposed' });
    });

    it('ignores a staged settlement that arrives after the admission', () => {
        const accepted = computeALDeliveryLifecycle(toSubmittedLifecycle(), toAdmissionSettlement(0));
        const next = computeALDeliveryLifecycle(accepted, toStagedSettlement());

        expect(accepted.state).toBe('accepted');
        expect(next).toEqual(accepted);
    });

    it('never reopens a terminal lifecycle with a late staged settlement', () => {
        const expired = computeALDeliveryLifecycle(toStagedLifecycle(), {
            kind: 'expired',
            msgId: MSG_ID,
            carrier: 'rtc',
            atMs: SETTLED_AT_MS,
            detail: 'The deadline passed before selection.',
            traceId: TRACE_ID
        });
        const next = computeALDeliveryLifecycle(expired, toStagedSettlement());

        expect(next).toEqual({ ...expired, lateSettlementCount: expired.lateSettlementCount + 1 });
        expect(next.state).toBe('expired');
    });

    it('lists staged right after submitted and resolves an admission wait on it', () => {
        expect(AL_DELIVERY_STATES.slice(0, 3)).toEqual(['submitted', 'staged', 'rejected']);
        expect(AL_DELIVERY_ADMITTED_STATES).toContain('staged');
        expect(AL_DELIVERY_ADMITTED_STATES).not.toContain('submitted');
    });
});

function toSubmittedLifecycle(): ALDeliveryLifecycle {
    return createInitialALDeliveryLifecycle({
        msgId: MSG_ID,
        typeId: 'room.live-position.v1',
        ackMode: 'none',
        receiptAlgo: 'none',
        expiresAtMs: 9_000,
        submittedAtMs: 1_000
    });
}

function toStagedLifecycle(): ALDeliveryLifecycle {
    return computeALDeliveryLifecycle(toSubmittedLifecycle(), toStagedSettlement());
}

function toStagedSettlement(): ALDeliverySettlement {
    return { kind: 'staged', msgId: MSG_ID, traceId: TRACE_ID, carrier: 'rtc', atMs: STAGED_AT_MS };
}

function toAdmissionSettlement(queuedAttempts: number): ALDeliverySettlement {
    return {
        kind: 'admission',
        msgId: MSG_ID,
        carrier: 'rtc',
        atMs: SETTLED_AT_MS,
        verdict: { kind: 'admitted', durable: false, queuedAttempts },
        trackedReceiptAlgo: 'none',
        traceId: TRACE_ID
    };
}
