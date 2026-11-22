import type { ALReceiptRecordOpening } from '@shared/alm/receipt-record/al-receipt-record-rows.ts';
import { validateALReceiptRecordOpening } from '@shared/alm/receipt-record/validate-al-receipt-record-opening.ts';
import { describe, expect, it } from 'vitest';

const NOW = 1_000_000;
const opening: ALReceiptRecordOpening = {
    originPeerId: 'o',
    msgId: 'm',
    traceId: 't',
    expectedRecipientPeerIds: ['r1', 'r2', 'r3'],
    snapshotVersion: 7,
    deadlineAtMs: NOW + 5_000
};

function toIssueCodes(changes: Partial<ALReceiptRecordOpening>): readonly string[] {
    return validateALReceiptRecordOpening({ ...opening, ...changes }, NOW).map((issue) => issue.code);
}

function toRecipientPeerIds(count: number): readonly string[] {
    return Array.from({ length: count }, (_, index) => `r${index}`);
}

describe('validateALReceiptRecordOpening', () => {
    it('accepts an opening with an audience and a near deadline', () => {
        expect(toIssueCodes({})).toEqual([]);
    });

    it('refuses an empty audience, which has nobody to count', () => {
        expect(toIssueCodes({ expectedRecipientPeerIds: [] })).toEqual(['empty-audience']);
    });

    // The wire limit is 256 collection entries; the pair pins an off-by-one either way.
    it('refuses an audience above the collection limit and accepts one at it', () => {
        expect(toIssueCodes({ expectedRecipientPeerIds: toRecipientPeerIds(257) })).toEqual(['audience-over-limit']);
        expect(toIssueCodes({ expectedRecipientPeerIds: toRecipientPeerIds(256) })).toEqual([]);
    });

    // A receipt is retained until its deadline plus the 30 s grace; at that instant it is already gone.
    it('refuses a receipt whose retention has passed and accepts one a millisecond inside it', () => {
        expect(toIssueCodes({ deadlineAtMs: NOW - 30_000 })).toEqual(['receipt-expired']);
        expect(toIssueCodes({ deadlineAtMs: NOW - 29_999 })).toEqual([]);
    });

    // The record window is the 30 min ephemeral TTL; a deadline past it would outlive the record's rows.
    it('refuses a deadline beyond the record window and accepts one at its edge', () => {
        expect(toIssueCodes({ deadlineAtMs: NOW + 1_800_001 })).toEqual(['deadline-beyond-window']);
        expect(toIssueCodes({ deadlineAtMs: NOW + 1_800_000 })).toEqual([]);
    });

    it('reports every issue, not only the first', () => {
        expect(toIssueCodes({ expectedRecipientPeerIds: [], deadlineAtMs: NOW - 30_000 })).toEqual([
            'empty-audience',
            'receipt-expired'
        ]);
    });
});
