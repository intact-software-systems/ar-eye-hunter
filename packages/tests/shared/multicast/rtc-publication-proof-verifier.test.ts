import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toGroupPresencePublicationKey } from '@shared/api/group-presence/to-group-presence-publication-key.ts';
import type { GroupPresencePublicationKey, GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { RtcPublicationProofVerifier } from '@shared/multicast/rtc-publication-proof-verifier.ts';
import type { PublicationCrypto } from '@shared/signature/publication-crypto.ts';

import {
    createAvailablePublicationCryptoFixture,
    UNAVAILABLE_PUBLICATION_CRYPTO,
    type AvailablePublicationCrypto
} from '../signature/publication-crypto-fixtures.ts';
import {
    createFrozenGrantedMulticast,
    createPublicationRoomSnapshot,
    PUBLISH_AND_SUBSCRIBE,
    signPublication
} from './rtc-publication-proof-fixtures.ts';

interface VerifierFixture {
    readonly verifier: RtcPublicationProofVerifier;
    readonly groups: LatestRepository<string, GroupSnapshot>;
    readonly sender: AvailablePublicationCrypto;
    readonly calls: { digest: number; verify: number; };
}

describe('RtcPublicationProofVerifier', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('verifies a frame the sender\'s registered key signed, and records that object as verified', async () => {
        const fixture = await createVerifierFixture();
        const signed = await signPublication(fixture.sender, createFeed('feed-1'));

        expect(fixture.verifier.getVerifiedSignature(signed)).toBe(false);
        expect(await fixture.verifier.verifyPublicationProof(signed)).toBe(true);
        expect(fixture.verifier.getVerifiedSignature(signed)).toBe(true);
        expect(fixture.verifier.getVerifiedSignature(structuredClone(signed))).toBe(false);
    });

    it.each(['before', 'after'] as const)(
        'refuses a copy whose payload changed under the same keyId and signature, arriving %s the original',
        async (arrival) => {
            const fixture = await createVerifierFixture();
            const signed = await signPublication(fixture.sender, createFeed('feed-1'));
            const forged: ALMessage = { ...signed, payload: { ...signed.payload, resource: '{"text":"forged"}' } };

            const verdicts = arrival === 'before'
                ? [await fixture.verifier.verifyPublicationProof(forged), await fixture.verifier.verifyPublicationProof(signed)]
                : [await fixture.verifier.verifyPublicationProof(signed), await fixture.verifier.verifyPublicationProof(forged)];

            expect(verdicts).toEqual(arrival === 'before' ? [false, true] : [true, false]);
            expect(fixture.verifier.getVerifiedSignature(forged)).toBe(false);
        }
    );

    it('answers a second, equal message object from its verdict: one digest, no key and no verify', async () => {
        const fixture = await createVerifierFixture();
        const signed = await signPublication(fixture.sender, createFeed('feed-1'));
        await fixture.verifier.verifyPublicationProof(signed);
        const before = { ...fixture.calls };
        // Without its key in the snapshot, only a verdict hit can still answer the copy.
        fixture.groups.accept('room', createRoom({}));

        const copy = structuredClone(signed);

        expect(await fixture.verifier.verifyPublicationProof(copy)).toBe(true);
        expect(fixture.verifier.getVerifiedSignature(copy)).toBe(true);
        expect({ digest: fixture.calls.digest - before.digest, verify: fixture.calls.verify - before.verify }).toEqual({
            digest: 1,
            verify: 0
        });
    });

    it('evicts the oldest verdict at its 1025th', async () => {
        const fixture = await createVerifierFixture();
        const signed = await Promise.all(
            Array.from({ length: 1025 }, async (_, index) => await signPublication(fixture.sender, createFeed(`feed-${index}`)))
        );
        for (const message of signed) {
            await fixture.verifier.verifyPublicationProof(message);
        }
        fixture.groups.accept('room', createRoom({}));

        expect(await fixture.verifier.verifyPublicationProof(structuredClone(signed[0]!))).toBe(false);
        expect(await fixture.verifier.verifyPublicationProof(structuredClone(signed[1]!))).toBe(true);
        expect(await fixture.verifier.verifyPublicationProof(structuredClone(signed[1024]!))).toBe(true);
    });

    it('refuses a registration whose keyId is not its key\'s thumbprint', async () => {
        const fixture = await createVerifierFixture();
        const other = await createAvailablePublicationCryptoFixture();
        const mislabelled: GroupPresencePublicationKey = {
            keyId: fixture.sender.keyPair.keyId,
            publicJwk: other.keyPair.publicJwk
        };
        fixture.groups.accept('room', createRoom({ a: mislabelled }));
        const signed = await signPublication(
            { ...other, keyPair: { ...other.keyPair, keyId: fixture.sender.keyPair.keyId } },
            createFeed('feed-1')
        );

        expect(await fixture.verifier.verifyPublicationProof(signed)).toBe(false);
    });

    it('lets a verdict expire at the frame\'s own expiry', async () => {
        const fixture = await createVerifierFixture();
        const signed = await signPublication(fixture.sender, createFeed('feed-1'));
        await fixture.verifier.verifyPublicationProof(signed);
        fixture.groups.accept('room', createRoom({}));

        vi.setSystemTime(signed.constraints!.expiresAtMs! - 1);
        const live = await fixture.verifier.verifyPublicationProof(structuredClone(signed));
        vi.setSystemTime(signed.constraints!.expiresAtMs!);
        const expired = await fixture.verifier.verifyPublicationProof(structuredClone(signed));

        expect([live, expired]).toEqual([true, false]);
    });

    it('refuses a frame without a proof, or whose sender registered no key', async () => {
        const fixture = await createVerifierFixture();
        const signed = await signPublication(fixture.sender, createFeed('feed-1'));
        const { proof: _proof, ...unsigned } = signed;
        const unregistered = await createVerifierFixture({});

        expect([
            await fixture.verifier.verifyPublicationProof(unsigned),
            await unregistered.verifier.verifyPublicationProof(await signPublication(unregistered.sender, createFeed('feed-2')))
        ]).toEqual([false, false]);
    });

    it('answers every frame unverified on a keyless page', async () => {
        const fixture = await createVerifierFixture();
        const signed = await signPublication(fixture.sender, createFeed('feed-1'));
        const keyless = new RtcPublicationProofVerifier({
            crypto: UNAVAILABLE_PUBLICATION_CRYPTO,
            findGroupSnapshot: () => fixture.groups.read('room'),
            nowEpochMs: Date.now
        });

        expect(await keyless.verifyPublicationProof(signed)).toBe(false);
        expect(keyless.getVerifiedSignature(signed)).toBe(false);
    });
});

/** A receiver `b` whose room snapshot attests the sender `a`'s key, unless `keys` names other registrations. */
async function createVerifierFixture(keys?: Readonly<Record<string, GroupPresencePublicationKey>>): Promise<VerifierFixture> {
    const sender = await createAvailablePublicationCryptoFixture();
    const receiver = await createAvailablePublicationCryptoFixture();
    const groups = new LatestRepository<string, GroupSnapshot>();
    groups.accept('room', createRoom(keys ?? { a: toGroupPresencePublicationKey(sender)! }));
    const calls = { digest: 0, verify: 0 };
    const verifier = new RtcPublicationProofVerifier({
        crypto: toCountingCrypto(receiver, calls),
        findGroupSnapshot: () => groups.read('room'),
        nowEpochMs: Date.now
    });
    return { verifier, groups, sender, calls };
}

function createRoom(keys: Readonly<Record<string, GroupPresencePublicationKey>>): GroupSnapshot {
    return createPublicationRoomSnapshot({
        sessionIds: ['a', 'b'],
        snapshotVersion: 3,
        keys,
        grants: { a: PUBLISH_AND_SUBSCRIBE, b: PUBLISH_AND_SUBSCRIBE }
    });
}

function createFeed(resourceId: string): ALMessage {
    return createFrozenGrantedMulticast({ senderId: 'a', resourceId, recipientPeerIds: ['a', 'b'], snapshotVersion: 3 });
}

/** The receiver page's WebCrypto, counting the digests and verifications the verifier asks of it. */
function toCountingCrypto(crypto: AvailablePublicationCrypto, calls: { digest: number; verify: number; }): PublicationCrypto {
    const subtle = crypto.subtle;
    const counting = Object.create(subtle) as SubtleCrypto;
    Object.assign(counting, {
        digest: (...input: Parameters<SubtleCrypto['digest']>) => {
            calls.digest += 1;
            return subtle.digest(...input);
        },
        verify: (...input: Parameters<SubtleCrypto['verify']>) => {
            calls.verify += 1;
            return subtle.verify(...input);
        },
        importKey: (...input: Parameters<SubtleCrypto['importKey']>) => subtle.importKey(...input)
    });
    return { ...crypto, subtle: counting };
}
