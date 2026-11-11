import { describe, expect, it } from 'vitest';

import type { ALAckPayload } from '@shared/al-contracts/al-control.ts';
import type { ALReceiptControl } from '@shared/al-contracts/receipt-proof/al-receipt-proof.ts';
import { toGroupPresencePublicationKey } from '@shared/api/group-presence/to-group-presence-publication-key.ts';
import type { GroupPresencePublicationKey } from '@shared/api/group-types.ts';
import { toBase64Url } from '@shared/encoding/base64url.ts';
import { RtcReceiptProofVerifier } from '@shared/multicast/receipt-proof/rtc-receipt-proof-verifier.ts';

import { createCountingSubtleCrypto } from '../../signature/counting-subtle-crypto-fixtures.ts';
import { createAvailablePublicationCryptoFixture, type AvailablePublicationCrypto } from '../../signature/publication-crypto-fixtures.ts';

import { signTestALReceiptControl, toTestALAckPayload } from '../../../al-control-test-payloads.ts';

const RECIPIENT_ACK: ALReceiptControl = {
    type: 'ack',
    payload: toTestALAckPayload({ ackedMsgId: 'm1', fromPeerId: 'c', toPeerId: 'a', observedAtEpochMs: 1_700_000_000_000 })
};

describe('RtcReceiptProofVerifier', () => {
    it('refuses missing-proof, unknown-key, key-mismatch and invalid-signature in that order, with no crypto before the last', async () => {
        const c = await createAvailablePublicationCryptoFixture();
        const b = await createAvailablePublicationCryptoFixture();
        const counting = createCountingSubtleCrypto();
        const verifier = new RtcReceiptProofVerifier({ crypto: { kind: 'available', subtle: counting.subtle }, nowEpochMs: Date.now });
        const signedByC = await signTestALReceiptControl(c, RECIPIENT_ACK);
        const signedByB = await signTestALReceiptControl(b, RECIPIENT_ACK);
        const tampered = withAckFields(signedByC, { status: 'accepted' });

        const missing = await verifier.verifyReceiptProof(RECIPIENT_ACK, undefined);
        const unknownKey = await verifier.verifyReceiptProof(signedByC, undefined);
        const mismatched = await verifier.verifyReceiptProof(signedByB, toKey(c));
        const cryptoBeforeTheLast = { ...counting.counts };
        const invalid = await verifier.verifyReceiptProof(tampered, toKey(c));

        expect([missing.left?.kind, unknownKey.left?.kind, mismatched.left?.kind, invalid.left?.kind]).toEqual([
            'missing-proof',
            'unknown-key',
            'key-mismatch',
            'invalid-signature'
        ]);
        expect(missing.left).toEqual({ kind: 'missing-proof', claimedRecipientPeerId: 'c', channelPeerId: 'c' });
        expect(cryptoBeforeTheLast).toEqual({ digest: 0, sign: 0, verify: 0, importKey: 0 });
        expect(counting.counts.verify).toBe(1);
    });

    it('names the claimed recipient and the channel peer of a refused control', async () => {
        const verifier = new RtcReceiptProofVerifier({ crypto: { kind: 'unavailable' }, nowEpochMs: Date.now });
        const relayed = withAckFields(RECIPIENT_ACK, { fromPeerId: 'r', logicalRecipientPeerId: 'c' });

        expect((await verifier.verifyReceiptProof(relayed, undefined)).left).toEqual({
            kind: 'missing-proof',
            claimedRecipientPeerId: 'c',
            channelPeerId: 'r'
        });
    });

    it('refuses invalid-signature on a page without WebCrypto', async () => {
        const c = await createAvailablePublicationCryptoFixture();
        const keyless = new RtcReceiptProofVerifier({ crypto: { kind: 'unavailable' }, nowEpochMs: Date.now });

        expect((await keyless.verifyReceiptProof(await signTestALReceiptControl(c, RECIPIENT_ACK), toKey(c))).left?.kind)
            .toBe('invalid-signature');
    });

    it('refuses a frozen key whose key id is not its own thumbprint, though the signature verifies under its JWK', async () => {
        const c = await createAvailablePublicationCryptoFixture();
        const otherKeyId = (await createAvailablePublicationCryptoFixture()).keyPair.keyId;
        const signedByC = await signTestALReceiptControl(c, RECIPIENT_ACK);
        const renamed = withAckFields(signedByC, { proof: { ...signedByC.payload.proof!, keyId: otherKeyId } });
        const verifier = new RtcReceiptProofVerifier({ crypto: { kind: 'available', subtle: c.subtle }, nowEpochMs: Date.now });

        expect((await verifier.verifyReceiptProof(renamed, { keyId: otherKeyId, publicJwk: c.keyPair.publicJwk })).left?.kind)
            .toBe('invalid-signature');
        expect((await verifier.verifyReceiptProof(signedByC, toKey(c))).right).toBe(true);
    });

    it('refuses a frozen key whose JWK is not its key id even after a verdict for that key id and signature was cached', async () => {
        const c = await createAvailablePublicationCryptoFixture();
        const b = await createAvailablePublicationCryptoFixture();
        const signedByC = await signTestALReceiptControl(c, RECIPIENT_ACK);
        const verifier = new RtcReceiptProofVerifier({ crypto: { kind: 'available', subtle: c.subtle }, nowEpochMs: Date.now });
        expect((await verifier.verifyReceiptProof(signedByC, toKey(c))).right).toBe(true);

        const misnamed: GroupPresencePublicationKey = { keyId: c.keyPair.keyId, publicJwk: b.keyPair.publicJwk };

        expect((await verifier.verifyReceiptProof(signedByC, misnamed)).left?.kind).toBe('invalid-signature');
    });

    it('verifies once and answers a repeat from the cache', async () => {
        const c = await createAvailablePublicationCryptoFixture();
        const counting = createCountingSubtleCrypto();
        const verifier = new RtcReceiptProofVerifier({ crypto: { kind: 'available', subtle: counting.subtle }, nowEpochMs: Date.now });
        const signed = await signTestALReceiptControl(c, RECIPIENT_ACK);

        const first = await verifier.verifyReceiptProof(signed, toKey(c));
        const repeat = await verifier.verifyReceiptProof(signed, toKey(c));

        expect([first.right, repeat.right]).toEqual([true, true]);
        expect(counting.counts.verify).toBe(1);
        expect(counting.counts.importKey).toBe(1);
    });

    it('never caches a refusal, and a flood of refused controls leaves a cached verdict in place', async () => {
        const c = await createAvailablePublicationCryptoFixture();
        const counting = createCountingSubtleCrypto();
        const verifier = new RtcReceiptProofVerifier({ crypto: { kind: 'available', subtle: counting.subtle }, nowEpochMs: Date.now });
        const signed = await signTestALReceiptControl(c, RECIPIENT_ACK);
        const proof = signed.payload.proof!;
        expect((await verifier.verifyReceiptProof(signed, toKey(c))).right).toBe(true);
        const forged = withAckFields(signed, { proof: { ...proof, signature: 'A'.repeat(86) } });

        expect((await verifier.verifyReceiptProof(forged, toKey(c))).left?.kind).toBe('invalid-signature');
        expect((await verifier.verifyReceiptProof(forged, toKey(c))).left?.kind).toBe('invalid-signature');
        expect(counting.counts.verify).toBe(3);
        for (let index = 0; index < 1_023; index++) {
            const flood = withAckFields(signed, { proof: { ...proof, signature: toRandomSignature() } });
            expect((await verifier.verifyReceiptProof(flood, toKey(c))).left?.kind).toBe('invalid-signature');
        }
        const verifiesAfterTheFlood = counting.counts.verify;
        const trueAgain = await verifier.verifyReceiptProof(signed, toKey(c));

        expect(verifiesAfterTheFlood).toBe(1 + 1_025);
        expect(trueAgain.right).toBe(true);
        expect(counting.counts.verify).toBe(verifiesAfterTheFlood);
    });
});

function withAckFields(control: ALReceiptControl, fields: Partial<ALAckPayload>): ALReceiptControl {
    if (control.type !== 'ack') {
        throw new TypeError('The fixture control is an ACK');
    }
    return { type: 'ack', payload: { ...control.payload, ...fields } };
}

function toKey(crypto: AvailablePublicationCrypto): GroupPresencePublicationKey {
    return toGroupPresencePublicationKey(crypto)!;
}

function toRandomSignature(): string {
    return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(64)));
}
