import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import type { ALReceiptRecordOpening } from '@shared/alm/receipt-record/al-receipt-record-rows.ts';
import { validateALReceiptRecordOpening } from '@shared/alm/receipt-record/validate-al-receipt-record-opening.ts';
import { describe, expect, it } from 'vitest';

const NOW = 1_000_000;
const opening: ALReceiptRecordOpening = {
    originPeerId: 'o',
    msgId: 'm',
    traceId: 't',
    expectedRecipientPeerIds: ['r1', 'r2', 'r3'],
    neverSentRecipientPeerIds: [],
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
        expect(toIssueCodes({ expectedRecipientPeerIds: toRecipientPeerIds(257) })).toContain('audience-over-limit');
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

    // Each opening would commit a head that every later read refuses as corruption, so the receipt could never end:
    // the validator refuses what the stored-head decoder refuses.
    it('refuses an opening the stored head could not be read back from', () => {
        const unreadable: readonly Partial<ALReceiptRecordOpening>[] = [
            { traceId: '' },
            { originPeerId: '' },
            { msgId: '' },
            { expectedRecipientPeerIds: ['r1', ''] },
            { snapshotVersion: -1 },
            { deadlineAtMs: NOW + 1.5 }
        ];
        for (const changes of unreadable) {
            expect(toIssueCodes(changes)).toEqual(['malformed-opening']);
        }
        const withExtraField = { ...opening, carrier: 'ws' };
        expect(validateALReceiptRecordOpening(withExtraField, NOW).map((issue) => issue.code))
            .toEqual(['malformed-opening']);
    });

    // An audience past the limit is also past what the decoder reads back, so both issues are reported.
    it('reports an audience above the limit as unreadable too', () => {
        expect(toIssueCodes({ expectedRecipientPeerIds: toRecipientPeerIds(257) }))
            .toEqual(['audience-over-limit', 'malformed-opening']);
    });

    // The never-sent list is stored with the head, so a list the decoder would refuse would leave a head no read could
    // take; 257 is one past the collection limit.
    it('refuses never-sent recipients past the collection limit as unreadable', () => {
        expect(toIssueCodes({ neverSentRecipientPeerIds: toRecipientPeerIds(257) })).toEqual(['malformed-opening']);
    });

    it('reports every issue, not only the first', () => {
        expect(toIssueCodes({ expectedRecipientPeerIds: [], deadlineAtMs: NOW - 30_000 })).toEqual([
            'empty-audience',
            'receipt-expired'
        ]);
    });

    // Pins an opening whose recipient no receipt control can name being accepted: its `admitted` answer would throw.
    it('refuses an opening a receipt could not name as unreadable', () => {
        const peerPastLimit = 'p'.repeat(AL_MESSAGE_RESOURCE_LIMITS.routeIdCharacters + 1);
        expect(toIssueCodes({ expectedRecipientPeerIds: ['r1', peerPastLimit] })).toEqual(['malformed-opening']);
    });
});
