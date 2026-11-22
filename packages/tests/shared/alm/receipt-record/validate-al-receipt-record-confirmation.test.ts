import type {
    ALReceiptRecordEndedHead,
    ALReceiptRecordOpenHead,
    ALReceiptRecordOpening
} from '@shared/alm/receipt-record/al-receipt-record-rows.ts';
import {
    validateALReceiptRecordConfirmation,
    type ALReceiptRecordConfirmationDto
} from '@shared/alm/receipt-record/validate-al-receipt-record-confirmation.ts';
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
const openHead: ALReceiptRecordOpenHead = { phase: 'open', opening };
const timedOutHead: ALReceiptRecordEndedHead = {
    phase: 'timed-out',
    opening,
    confirmedRecipientPeerIds: ['r1'],
    outsideAudienceRecipientPeerIds: [],
    endedAtEpochMs: NOW + 5_000
};

function toConfirmation(recipientPeerId: string): ALReceiptRecordConfirmationDto {
    return { originPeerId: 'o', msgId: 'm', recipientPeerId, kind: 'confirmed' };
}

function toEndedHeadIssueCodes(recipientPeerId: string): readonly string[] {
    return validateALReceiptRecordConfirmation(timedOutHead, toConfirmation(recipientPeerId), NOW).map((issue) => issue.code);
}

describe('validateALReceiptRecordConfirmation', () => {
    it('accepts an expected recipient before the deadline', () => {
        expect(validateALReceiptRecordConfirmation(openHead, toConfirmation('r1'), NOW)).toEqual([]);
    });

    // The message is the in-memory aggregate's, verbatim, so both paths answer an ACK the same way.
    it('refuses a recipient outside the frozen audience', () => {
        expect(validateALReceiptRecordConfirmation(openHead, toConfirmation('stranger'), NOW)).toEqual([
            {
                code: 'outside-frozen-audience',
                message: 'AL acknowledgement confirms no recipient of the frozen audience'
            }
        ]);
    });

    // The deadline instant is already past: an ACK arriving at it is late, one a millisecond earlier counts.
    it('refuses a confirmation at the deadline and accepts one a millisecond before it', () => {
        expect(validateALReceiptRecordConfirmation(openHead, toConfirmation('r1'), NOW + 5_000)).toEqual([
            { code: 'deadline-expired', message: 'AL acknowledgement arrived after its receipt deadline' }
        ]);
        expect(validateALReceiptRecordConfirmation(openHead, toConfirmation('r1'), NOW + 4_999)).toEqual([]);
    });

    // An ended head refuses every confirmation, and still reports the other issues it finds.
    it('refuses any confirmation against an ended head, with every other issue', () => {
        expect(toEndedHeadIssueCodes('r1')).toEqual(['head-ended']);
        expect(toEndedHeadIssueCodes('stranger')).toEqual(['head-ended', 'outside-frozen-audience']);
    });
});
