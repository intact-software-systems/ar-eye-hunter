import { describe, expect, it } from 'vitest';

import {
    AL_OUTBOUND_MAX_PENDING_RECEIPT_SEQS,
    computeALOutboundRoomSentFloorMint,
    computeALOutboundRoomSentFloorReceipt,
    decodeALOutboundRoomSentFloorRow,
    toALOutboundUnknownAudienceSeq
} from '@shared/alm/outbound/admission/sequencing/al-outbound-room-sent-floor.ts';

describe('a stored room-wide sent position', () => {
    it('decodes the unanswered sequence and the sequences waiting on their receipt', () => {
        expect(decodeALOutboundRoomSentFloorRow({ unreceiptedSeq: 2, pendingReceiptSeqs: [3, 5] }))
            .toEqual({ unreceiptedSeq: 2, pendingReceiptSeqs: [3, 5] });
    });

    it.each([
        { label: 'a missing waiting list', value: { unreceiptedSeq: 2 } },
        { label: 'a waiting sequence of 0', value: { unreceiptedSeq: 0, pendingReceiptSeqs: [0] } },
        { label: 'waiting sequences out of order', value: { unreceiptedSeq: 0, pendingReceiptSeqs: [3, 2] } },
        { label: 'a repeated waiting sequence', value: { unreceiptedSeq: 0, pendingReceiptSeqs: [2, 2] } },
        {
            label: 'more waiting sequences than the cap',
            value: { unreceiptedSeq: 0, pendingReceiptSeqs: toSeqs(1, AL_OUTBOUND_MAX_PENDING_RECEIPT_SEQS + 1) }
        },
        { label: 'a bare sequence', value: { seq: 3 } },
        { label: 'an unknown field', value: { unreceiptedSeq: 0, pendingReceiptSeqs: [], recipientPeerId: 'b' } }
    ])('refuses $label as corrupt', ({ value }) => {
        expect(() => decodeALOutboundRoomSentFloorRow(value)).toThrow(TypeError);
    });
});

describe('the room-wide sent position a send recording nobody moves', () => {
    it('waits on the receipt of a receipted send', () => {
        expect(computeALOutboundRoomSentFloorMint(undefined, 1, true)).toEqual({ unreceiptedSeq: 0, pendingReceiptSeqs: [1] });
        expect(computeALOutboundRoomSentFloorMint({ unreceiptedSeq: 0, pendingReceiptSeqs: [1] }, 2, true))
            .toEqual({ unreceiptedSeq: 0, pendingReceiptSeqs: [1, 2] });
    });

    it('never resolves a send with no receipt, and stops waiting on the receipts below it', () => {
        expect(computeALOutboundRoomSentFloorMint({ unreceiptedSeq: 0, pendingReceiptSeqs: [1, 2] }, 3, false))
            .toEqual({ unreceiptedSeq: 3, pendingReceiptSeqs: [] });
    });

    it('folds the oldest wait into the unanswered sequence past the cap', () => {
        const full = { unreceiptedSeq: 0, pendingReceiptSeqs: toSeqs(1, AL_OUTBOUND_MAX_PENDING_RECEIPT_SEQS) };

        const next = computeALOutboundRoomSentFloorMint(full, AL_OUTBOUND_MAX_PENDING_RECEIPT_SEQS + 1, true);

        expect(next).toEqual({ unreceiptedSeq: 1, pendingReceiptSeqs: toSeqs(2, AL_OUTBOUND_MAX_PENDING_RECEIPT_SEQS + 1) });
        expect(toALOutboundUnknownAudienceSeq(next)).toBe(AL_OUTBOUND_MAX_PENDING_RECEIPT_SEQS + 1);
    });
});

describe('the room-wide sent position an admitted receipt answers', () => {
    it('stops waiting on that sequence only', () => {
        expect(computeALOutboundRoomSentFloorReceipt({ unreceiptedSeq: 1, pendingReceiptSeqs: [2, 3] }, 3))
            .toEqual({ unreceiptedSeq: 1, pendingReceiptSeqs: [2] });
    });

    it('moves nothing for a sequence it does not wait on', () => {
        expect(computeALOutboundRoomSentFloorReceipt({ unreceiptedSeq: 3, pendingReceiptSeqs: [4] }, 2)).toBeUndefined();
    });

    it('reads the highest unanswered or waiting sequence, 0 for none', () => {
        expect(toALOutboundUnknownAudienceSeq(undefined)).toBe(0);
        expect(toALOutboundUnknownAudienceSeq({ unreceiptedSeq: 4, pendingReceiptSeqs: [] })).toBe(4);
        expect(toALOutboundUnknownAudienceSeq({ unreceiptedSeq: 1, pendingReceiptSeqs: [2, 5] })).toBe(5);
    });
});

/** The sequences `from` to `to`, ascending. */
function toSeqs(from: number, to: number): readonly number[] {
    return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}
