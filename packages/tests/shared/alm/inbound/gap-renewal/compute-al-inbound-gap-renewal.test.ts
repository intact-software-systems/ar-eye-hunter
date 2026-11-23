import { describe, expect, it } from 'vitest';

import type { ALOrderingObservation, ALOrderingTrackSnapshot, ALSeqRange } from '@shared/al-contracts/al-runtime.ts';
import { validateALInboundCommitBundle } from '@shared/alm/inbound/admission/validate-al-inbound-commit-bundle.ts';
import type {
    ALInboundCommitBundle,
    ALInboundDurableEffect,
    ALInboundGapRenewalEffect
} from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { computeALInboundWorkEntry, decodeALInboundWorkEntry } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import {
    computeALGapRenewalDelayMs,
    computeALGapRenewalStretch,
    computeALInboundNewlyMissingRanges,
    computeALInboundStillMissingRanges,
    isALInboundMessageRetainingWork
} from '@shared/alm/inbound/gap-renewal/compute-al-inbound-gap-renewal.ts';

function toSnapshot(lastContiguousSeq: number, bufferedSeqs: readonly number[]): ALOrderingTrackSnapshot {
    return { lastContiguousSeq, bufferedSeqs, updatedAtMs: 0 };
}

function toGap(seq: number, expectedSeq: number, missingRanges: readonly ALSeqRange[]): ALOrderingObservation {
    return { status: 'gap', trackKey: 'chat:sender:1', seq, expectedSeq, missingRanges, releasableSeqs: [] };
}

describe('computeALInboundNewlyMissingRanges', () => {
    it.each([
        {
            name: 'no snapshot and an arrival at 3',
            previous: undefined,
            observation: toGap(3, 1, [{ from: 1, to: 2 }]),
            expected: [{ from: 1, to: 2 }]
        },
        {
            name: 'a buffered 2 and an arrival at 5',
            previous: toSnapshot(0, [2]),
            observation: toGap(5, 1, [{ from: 1, to: 1 }, { from: 3, to: 4 }]),
            expected: [{ from: 3, to: 4 }]
        },
        {
            name: 'an arrival at 4 below a buffered 5',
            previous: toSnapshot(0, [2, 5]),
            observation: toGap(4, 1, [{ from: 1, to: 1 }, { from: 3, to: 3 }]),
            expected: []
        },
        {
            name: 'an arrival that reveals no gap',
            previous: toSnapshot(0, []),
            observation: { ...toGap(1, 1, []), status: 'in-order' } satisfies ALOrderingObservation,
            expected: []
        }
    ])('for $name is $expected', ({ previous, observation, expected }) => {
        expect(computeALInboundNewlyMissingRanges(previous, observation)).toEqual(expected);
    });
});

describe('computeALInboundStillMissingRanges', () => {
    it.each([
        {
            name: 'a track past 3 that buffers 5',
            position: toSnapshot(3, [5]),
            range: { from: 3, to: 6 },
            expected: [{ from: 4, to: 4 }, { from: 6, to: 6 }]
        },
        { name: 'a track that moved past the range', position: toSnapshot(6, []), range: { from: 3, to: 6 }, expected: [] },
        { name: 'no position', position: undefined, range: { from: 1, to: 1 }, expected: [] }
    ])('of $range at $name is $expected', ({ position, range, expected }) => {
        expect(computeALInboundStillMissingRanges(range, position)).toEqual(expected);
    });
});

describe('computeALGapRenewalDelayMs', () => {
    it.each([
        { requestNumber: 2, stretch: 1, expected: 1_000 },
        { requestNumber: 3, stretch: 1, expected: 2_000 },
        { requestNumber: 4, stretch: 1, expected: 4_000 },
        { requestNumber: 5, stretch: 1, expected: undefined },
        { requestNumber: 2, stretch: 1.25, expected: 1_250 }
    ])('for request $requestNumber at stretch $stretch is $expected', ({ requestNumber, stretch, expected }) => {
        expect(computeALGapRenewalDelayMs(requestNumber, stretch)).toBe(expected);
    });
});

describe('computeALGapRenewalStretch', () => {
    it.each([
        { random: 0, expected: 1 },
        { random: 0.5, expected: 1.25 }
    ])('for a draw of $random is $expected', ({ random, expected }) => {
        expect(computeALGapRenewalStretch(() => random)).toBe(expected);
    });
});

describe('a stored gap renewal', () => {
    const NAMESPACE = 'gap-renewal-decoding';
    const RENEWAL = {
        kind: 'renew-gap',
        trackKey: 'chat:sender:1',
        range: { from: 1, to: 1 },
        toPeerId: 'sender',
        message: { senderId: 'sender', msgId: '2' },
        traceId: 'trace-gap-renewal-decoding',
        signsForRecipient: false,
        heldStart: true
    } as const;
    const toStoredRenewal = (requestNumber: number | string, payload: Partial<ALInboundGapRenewalEffect> = RENEWAL) =>
        computeALInboundWorkEntry({
            namespace: NAMESPACE,
            effectId: 'renew-gap:stored',
            payload: { ...payload, requestNumber } as ALInboundGapRenewalEffect,
            observedAtMs: 0,
            expireAtTimestamp: 60_000,
            carrier: 'ws',
            signsForRecipient: false
        }).entry;

    it.each([2, 3, 4])('decodes renewal number %s', (requestNumber) => {
        expect(decodeALInboundWorkEntry(toStoredRenewal(requestNumber), NAMESPACE).payload).toMatchObject({ requestNumber });
    });

    it.each([1, 5, 2.5, '2'])('refuses renewal number %j', (requestNumber) => {
        expect(() => decodeALInboundWorkEntry(toStoredRenewal(requestNumber), NAMESPACE)).toThrow();
    });

    it('decodes whether the timer holds the track\'s start, and refuses a renewal that does not say', () => {
        const { heldStart: _heldStart, ...unsaid } = RENEWAL;

        expect(decodeALInboundWorkEntry(toStoredRenewal(2), NAMESPACE).payload).toMatchObject({ heldStart: true });
        expect(() => decodeALInboundWorkEntry(toStoredRenewal(2, unsaid), NAMESPACE)).toThrow();
    });
});

describe('the work that keeps the message it names retained', () => {
    const NAMESPACE = 'gap-renewal-retention';
    const renewal = (heldStart: boolean): ALInboundGapRenewalEffect => ({
        kind: 'renew-gap',
        trackKey: 'chat:sender:0',
        range: { from: 1, to: 1 },
        requestNumber: 2,
        toPeerId: 'sender',
        message: { senderId: 'sender', msgId: '2' },
        traceId: 'trace-gap-renewal-retention',
        signsForRecipient: false,
        heldStart
    });
    /** Message `2`'s provenance, retained to 1 s, and `work` naming it, retained to 5 s. */
    const toBundle = (work: ALInboundDurableEffect): ALInboundCommitBundle => ({
        admissionExpiresAtMs: null,
        senderId: 'sender',
        observations: {
            msgId: '2',
            senderId: 'sender',
            messageOwner: undefined,
            dedup: undefined,
            claim: undefined,
            ordering: undefined,
            buffered: undefined,
            deliveryProgress: undefined,
            supersedence: {},
            pendingAck: undefined,
            acks: [],
            nacks: [],
            controlOwners: undefined
        },
        mutations: [{
            kind: 'set-msg-owner',
            value: {
                msgId: '2',
                senderId: 'sender',
                source: { kind: 'rtc-peer', peerId: 'sender' },
                supersedenceKey: null,
                deliveredLocally: false,
                originAuthenticated: false
            },
            expireAtTimestamp: 1_000
        }],
        durableEffects: [computeALInboundWorkEntry({
            namespace: NAMESPACE,
            effectId: 'work:2',
            payload: work,
            observedAtMs: 0,
            expireAtTimestamp: 5_000,
            carrier: 'rtc',
            signsForRecipient: false
        })]
    });

    it('is every work row but a held start range\'s timer', () => {
        expect(isALInboundMessageRetainingWork(renewal(true))).toBe(false);
        expect(isALInboundMessageRetainingWork(renewal(false))).toBe(true);
        expect(isALInboundMessageRetainingWork({ kind: 'release-buffered', trackKey: 'chat:sender:0', seq: 2 })).toBe(true);
    });

    it('lets only a held start range\'s timer outlive the provenance of the message it names', () => {
        expect(validateALInboundCommitBundle(toBundle(renewal(true)), NAMESPACE).right).toBeDefined();
        expect(validateALInboundCommitBundle(toBundle(renewal(false)), NAMESPACE).left?.message)
            .toBe('Inbound admission candidate provenance expires before its owned work');
        expect(validateALInboundCommitBundle(toBundle({ kind: 'release-buffered', trackKey: 'chat:sender:0', seq: 2 }), NAMESPACE).left?.message)
            .toBe('Inbound admission candidate provenance expires before its owned work');
    });
});
