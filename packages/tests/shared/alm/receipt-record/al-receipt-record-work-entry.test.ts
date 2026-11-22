import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { toALInboundWorkType } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { toALOutboundWorkType } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import {
    computeALReceiptRecordWorkEntry,
    decodeALReceiptRecordWorkEntry,
    toALReceiptRecordWorkKey,
    toALReceiptRecordWorkType,
    type ALReceiptRecordWorkKind
} from '@shared/alm/receipt-record/al-receipt-record-work-entry.ts';
import { fnv1a64 } from '@shared/queuebox/AppQueueIdentity.ts';
import { describe, expect, it } from 'vitest';

const ref = { originPeerId: 'origin', msgId: 'msg-1' };

function computeWork(kind: ALReceiptRecordWorkKind) {
    return computeALReceiptRecordWorkEntry({
        namespace: 'ns',
        work: { kind, ref },
        observedAtMs: 1_000,
        readyAtMs: 6_000,
        expireAtTimestamp: 36_000
    });
}

describe('al-receipt-record work entry', () => {
    // A worker claims by type id: a type shared with another AL owner would hand that owner's rows to the record's
    // worker, and a shared topic would let a record key collide with an outbound or inbound key.
    it('gives the record a work type and topics no other AL owner uses', () => {
        const type = toALReceiptRecordWorkType('ns');

        expect(type).toBe(`AL_RECEIPT_RECORD:${fnv1a64('ns')}`);
        expect([toALOutboundWorkType('ns'), toALInboundWorkType('ns', 'ws'), 'WS_OUTBOX']).not.toContain(type);
        expect(toALReceiptRecordWorkKey('ns', 'deadline', ref).topicId).toBe('AL_RECEIPT_DEADLINE');
        expect(toALReceiptRecordWorkKey('ns', 'ended', ref).topicId).toBe('AL_RECEIPT_ENDED');
    });

    it('reads back the work it wrote', () => {
        expect(decodeALReceiptRecordWorkEntry(computeWork('deadline'), 'ns')).toEqual({ kind: 'deadline', ref });
        expect(decodeALReceiptRecordWorkEntry(computeWork('ended'), 'ns')).toEqual({ kind: 'ended', ref });
    });

    // Each row is well formed storage but not this record's work; reading any of them as the record's would let a
    // worker act on another namespace's receipt, another owner's row, or the wrong phase of a receipt.
    it('refuses work that is not this record\'s', () => {
        const deadline = computeWork('deadline');
        const foreignEntries = [
            { entry: deadline, namespace: 'other' },
            { entry: { ...deadline, typeId: toALOutboundWorkType('ns') }, namespace: 'ns' },
            { entry: { ...deadline, resource: '{invalid-json' }, namespace: 'ns' },
            { entry: { ...deadline, key: toALReceiptRecordWorkKey('ns', 'ended', ref) }, namespace: 'ns' }
        ];

        for (const { entry, namespace } of foreignEntries) {
            expect(() => decodeALReceiptRecordWorkEntry(entry, namespace)).toThrow(ALAdmissionCorruptionError);
        }
    });

    // Joining the two ids with a separator would give both refs the context 'o:m:x'; the JSON pair keeps them apart.
    it('keeps the work of look-alike ids apart', () => {
        const first = toALReceiptRecordWorkKey('ns', 'deadline', { originPeerId: 'o', msgId: 'm:x' });
        const second = toALReceiptRecordWorkKey('ns', 'deadline', { originPeerId: 'o:m', msgId: 'x' });

        expect(first).not.toEqual(second);
    });
});
