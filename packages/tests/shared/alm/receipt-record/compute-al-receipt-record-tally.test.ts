import type {
    ALReceiptRecordConfirmation,
    ALReceiptRecordEndedHead,
    ALReceiptRecordOpenHead,
    ALReceiptRecordOpening
} from '@shared/alm/receipt-record/al-receipt-record-rows.ts';
import { computeALReceiptRecordTally } from '@shared/alm/receipt-record/compute-al-receipt-record-tally.ts';
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

function toRows(...rows: readonly (readonly [string, ALReceiptRecordConfirmation['kind']])[]) {
    return rows.map(([recipientPeerId, kind]) => ({ recipientPeerId, kind, countedAtEpochMs: NOW }));
}

describe('computeALReceiptRecordTally', () => {
    // A stranger's row cannot count: the classes come from the frozen audience only.
    it('counts only expected recipients, by class', () => {
        const rows = toRows(['r3', 'confirmed'], ['r1', 'outside'], ['stranger', 'confirmed']);
        expect(computeALReceiptRecordTally(openHead, rows)).toEqual({
            confirmedRecipientPeerIds: ['r3'],
            outsideAudienceRecipientPeerIds: ['r1'],
            complete: false
        });
    });

    // Completeness is the receipt's rule: at least one confirmation and nobody left owing an answer.
    it('is complete when every recipient answered and one confirmed, and not when all are outside', () => {
        const answered = toRows(['r1', 'confirmed'], ['r2', 'outside'], ['r3', 'confirmed']);
        const allOutside = toRows(['r1', 'outside'], ['r2', 'outside'], ['r3', 'outside']);
        expect(computeALReceiptRecordTally(openHead, answered).complete).toBe(true);
        expect(computeALReceiptRecordTally(openHead, allOutside).complete).toBe(false);
    });

    it('lets a confirmation outrank a later outside answer from the same recipient', () => {
        expect(computeALReceiptRecordTally(openHead, toRows(['r1', 'confirmed'], ['r1', 'outside']))).toEqual({
            confirmedRecipientPeerIds: ['r1'],
            outsideAudienceRecipientPeerIds: [],
            complete: false
        });
    });

    // A repeated id in the frozen audience must not leave the receipt owing a second confirmation, and a
    // terminal set built from the tally must name that recipient once, as the in-memory aggregate does.
    it('completes an audience that names one recipient twice once that recipient confirms, listing it once', () => {
        const head: ALReceiptRecordOpenHead = {
            phase: 'open',
            opening: { ...opening, expectedRecipientPeerIds: ['r1', 'r1'] }
        };
        expect(computeALReceiptRecordTally(head, toRows(['r1', 'confirmed']))).toEqual({
            confirmedRecipientPeerIds: ['r1'],
            outsideAudienceRecipientPeerIds: [],
            complete: true
        });
    });

    // The mirror case: a repeated id answering outside the audience is listed once in the outside set.
    it('lists a repeated recipient once in the outside set', () => {
        const head: ALReceiptRecordOpenHead = {
            phase: 'open',
            opening: { ...opening, expectedRecipientPeerIds: ['r1', 'r1', 'r2'] }
        };
        expect(computeALReceiptRecordTally(head, toRows(['r1', 'outside'], ['r2', 'confirmed']))).toEqual({
            confirmedRecipientPeerIds: ['r2'],
            outsideAudienceRecipientPeerIds: ['r1'],
            complete: true
        });
    });

    // An ended head is the final word: a row written after the ending (r3) must not change it.
    it('reads an ended head from its own sets and ignores rows', () => {
        const head: ALReceiptRecordEndedHead = {
            phase: 'timed-out',
            opening,
            confirmedRecipientPeerIds: ['r1'],
            outsideAudienceRecipientPeerIds: ['r2'],
            endedAtEpochMs: NOW + 5_000
        };
        expect(computeALReceiptRecordTally(head, toRows(['r3', 'confirmed']))).toEqual({
            confirmedRecipientPeerIds: ['r1'],
            outsideAudienceRecipientPeerIds: ['r2'],
            complete: false
        });
    });
});
