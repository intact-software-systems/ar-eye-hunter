import {
    ALAdmissionCorruptionError,
    decodeALAdmissionValue,
    type ALAdmissionDecoder
} from '@shared/alm/al-admission-decoder.ts';
import {
    toALReceiptRecordConfirmationKey,
    toALReceiptRecordHeadKey
} from '@shared/alm/receipt-record/al-receipt-record-keys.ts';
import {
    decodeALReceiptRecordConfirmation,
    decodeALReceiptRecordHead,
    type ALReceiptRecordConfirmation,
    type ALReceiptRecordEndedHead,
    type ALReceiptRecordHead,
    type ALReceiptRecordOpenHead,
    type ALReceiptRecordOpening
} from '@shared/alm/receipt-record/al-receipt-record-rows.ts';
import { describe, expect, it } from 'vitest';

const ref = { originPeerId: 'origin', msgId: 'msg-1' };
const headKey = toALReceiptRecordHeadKey('ns', ref);
const confirmationKey = toALReceiptRecordConfirmationKey('ns', ref, 'r1');
const opening: ALReceiptRecordOpening = {
    ...ref,
    traceId: 'trace-1',
    expectedRecipientPeerIds: ['r1', 'r2', 'r3'],
    snapshotVersion: 4,
    deadlineAtMs: 10_000
};
const openHead: ALReceiptRecordOpenHead = { phase: 'open', opening };
// r3 confirmed from outside the audience snapshot, so both terminal sets are present and non-empty.
const endedHead: ALReceiptRecordEndedHead = {
    phase: 'timed-out',
    opening,
    confirmedRecipientPeerIds: ['r1'],
    outsideAudienceRecipientPeerIds: ['r3'],
    endedAtEpochMs: 10_500
};
const confirmation: ALReceiptRecordConfirmation = { recipientPeerId: 'r1', kind: 'confirmed', countedAtEpochMs: 9_000 };

interface RefusalCase {
    readonly name: string;
    readonly value: object;
    readonly key: string;
    readonly decode: ALAdmissionDecoder<ALReceiptRecordHead | ALReceiptRecordConfirmation>;
}

const refusals: readonly RefusalCase[] = [
    // A head copied under another message's key would answer for a receipt it does not describe.
    {
        name: 'a head under another message head key',
        value: openHead,
        key: toALReceiptRecordHeadKey('ns', { ...ref, msgId: 'msg-2' }),
        decode: decodeALReceiptRecordHead
    },
    { name: 'an unknown phase', value: { ...openHead, phase: 'done' }, key: headKey, decode: decodeALReceiptRecordHead },
    // An open head's count lives in its confirmation rows; a stored set beside it would be a second truth.
    {
        name: 'an open head that carries a confirmed set',
        value: { ...openHead, confirmedRecipientPeerIds: ['r1'] },
        key: headKey,
        decode: decodeALReceiptRecordHead
    },
    {
        name: 'an ended head without its end time',
        value: {
            phase: endedHead.phase,
            opening,
            confirmedRecipientPeerIds: endedHead.confirmedRecipientPeerIds,
            outsideAudienceRecipientPeerIds: endedHead.outsideAudienceRecipientPeerIds
        },
        key: headKey,
        decode: decodeALReceiptRecordHead
    },
    // 257 is one past the AL collection limit of 256 audience entries.
    {
        name: 'an audience past the collection limit',
        value: {
            ...openHead,
            opening: { ...opening, expectedRecipientPeerIds: Array.from({ length: 257 }, (_, index) => `r${index}`) }
        },
        key: headKey,
        decode: decodeALReceiptRecordHead
    },
    {
        name: 'a negative deadline',
        value: { ...openHead, opening: { ...opening, deadlineAtMs: -1 } },
        key: headKey,
        decode: decodeALReceiptRecordHead
    },
    // A confirmation under another recipient's key would count the wrong recipient.
    {
        name: 'a confirmation under another recipient key',
        value: confirmation,
        key: toALReceiptRecordConfirmationKey('ns', ref, 'r2'),
        decode: decodeALReceiptRecordConfirmation
    },
    {
        name: 'an unknown confirmation kind',
        value: { ...confirmation, kind: 'maybe' },
        key: confirmationKey,
        decode: decodeALReceiptRecordConfirmation
    }
];

describe('receipt record rows', () => {
    it('reads back an open head and an ended head as written', () => {
        expect(decodeALAdmissionValue(openHead, headKey, decodeALReceiptRecordHead)).toEqual(openHead);
        expect(decodeALAdmissionValue(endedHead, headKey, decodeALReceiptRecordHead)).toEqual(endedHead);
        expect(decodeALAdmissionValue(confirmation, confirmationKey, decodeALReceiptRecordConfirmation))
            .toEqual(confirmation);
    });

    // A corrupt row must fail closed at the storage boundary, never be read as absent or as another row.
    it.each(refusals)('refuses a row that is not what its key names: $name', ({ value, key, decode }) => {
        expect(() => decodeALAdmissionValue(value, key, decode)).toThrow(ALAdmissionCorruptionError);
    });
});
