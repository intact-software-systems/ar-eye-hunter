import {
    toALReceiptRecordConfirmationKey,
    toALReceiptRecordConfirmationPrefix,
    toALReceiptRecordHeadKey,
    toALReceiptRecordNamespace,
    type ALReceiptRecordRef
} from '@shared/alm/receipt-record/al-receipt-record-keys.ts';
import { describe, expect, it } from 'vitest';

describe('receipt record keys', () => {
    // The growth sampler reads `server-ws-qbox:*:receipt:record`, and every key carries the namespace verbatim.
    it('builds the namespace and each state key in the stored form', () => {
        const ref = { originPeerId: 'o', msgId: 'm' };
        expect(toALReceiptRecordNamespace('server-ws-qbox:*')).toBe('server-ws-qbox:*:receipt:record');
        expect(toALReceiptRecordHeadKey('ns', ref)).toBe('ns:receipt:["o","m"]');
        expect(toALReceiptRecordConfirmationPrefix('ns', ref)).toBe('ns:receipt-ack:["o","m"]:');
        expect(toALReceiptRecordConfirmationKey('ns', ref, 'r1')).toBe('ns:receipt-ack:["o","m"]:r1');
    });

    // A delimiter, quote or escape-looking character inside an identity must not let one message's rows be read,
    // listed by prefix, or overwritten as another's: each pair below differs only in where such a character sits.
    it('keeps look-alike identities apart', () => {
        const refs: readonly ALReceiptRecordRef[] = [
            ['o', 'm'],
            ['o', 'm:x'],
            ['o:m', 'x'],
            ['o"', 'm'],
            ['o', '"m'],
            ['o', 'm"]:r1'],
            ['o', 'm%22'],
            ['o%', 'm']
        ].map(([originPeerId, msgId]) => ({ originPeerId, msgId }));
        const headKeys = refs.map((ref) => toALReceiptRecordHeadKey('ns', ref));
        const prefixes = refs.map((ref) => toALReceiptRecordConfirmationPrefix('ns', ref));
        const confirmationKeys = refs.map((ref) => toALReceiptRecordConfirmationKey('ns', ref, 'r1'));

        expect(new Set(headKeys).size).toBe(refs.length);
        prefixes.forEach((prefix, prefixIndex) => {
            confirmationKeys.forEach((key, keyIndex) => {
                expect(key.startsWith(prefix)).toBe(prefixIndex === keyIndex);
            });
            headKeys.forEach((key) => {
                expect(key.startsWith(prefix)).toBe(false);
            });
        });
    });
});
