import { describe, expect, it } from 'vitest';

import { toALOutboundSentPositionPriors } from '@shared/alm/outbound/admission/to-al-outbound-sent-position-priors.ts';

/** No row for any of `count` recipients. */
function noRows(count: number): readonly undefined[] {
    return Array.from({ length: count }, () => undefined);
}

describe('the priors one recording admission reads', () => {
    it('reads each recipient at its own position, 0 for one never sent the track', () => {
        expect(toALOutboundSentPositionPriors({
            recipientPeerIds: ['b', 'c'],
            positions: [{ seq: 4 }, undefined],
            sharedPositions: noRows(2),
            roomFloor: undefined
        })).toEqual({ b: 4, c: 0 });
    });

    it('reads a recipient behind a sequence no receipt answers at it, and keeps one ahead of it', () => {
        expect(toALOutboundSentPositionPriors({
            recipientPeerIds: ['b', 'c', 'd'],
            positions: [{ seq: 1 }, undefined, { seq: 5 }],
            sharedPositions: noRows(3),
            roomFloor: { unreceiptedSeq: 3, pendingReceiptSeqs: [] }
        })).toEqual({ b: 3, c: 3, d: 5 });
    });

    it('reads every recipient no lower than a sequence still waiting on its receipt, whatever later receipt named it', () => {
        expect(toALOutboundSentPositionPriors({
            recipientPeerIds: ['a', 'b', 'c'],
            positions: noRows(3),
            sharedPositions: [{ seq: 3 }, { seq: 3 }, undefined],
            roomFloor: { unreceiptedSeq: 0, pendingReceiptSeqs: [2] }
        })).toEqual({ a: 3, b: 3, c: 2 });
    });

    it('reads the recipients a receipt named at their shared rows, and the rest at their own, once nothing waits', () => {
        expect(toALOutboundSentPositionPriors({
            recipientPeerIds: ['a', 'b', 'c'],
            positions: noRows(3),
            sharedPositions: [{ seq: 3 }, { seq: 3 }, undefined],
            roomFloor: { unreceiptedSeq: 0, pendingReceiptSeqs: [] }
        })).toEqual({ a: 3, b: 3, c: 0 });
    });

    it('keeps an own row higher than the receipted sequence', () => {
        expect(toALOutboundSentPositionPriors({
            recipientPeerIds: ['a', 'b'],
            positions: [{ seq: 5 }, { seq: 1 }],
            sharedPositions: [{ seq: 3 }, { seq: 3 }],
            roomFloor: { unreceiptedSeq: 0, pendingReceiptSeqs: [] }
        })).toEqual({ a: 5, b: 3 });
    });
});
