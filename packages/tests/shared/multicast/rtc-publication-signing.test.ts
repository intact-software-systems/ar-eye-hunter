import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newALMulticastMessage, type ALAckMode, type ALMessage, type ALTargets } from '@shared/al-contracts/al-contract.ts';
import {
    signALPublicationProof,
    toALPublicationProofSigningInput,
    verifyALPublicationProof
} from '@shared/al-contracts/publication-proof/al-publication-proof.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { reconstructALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { toGroupPresencePublicationKey } from '@shared/api/group-presence/to-group-presence-publication-key.ts';
import type { GroupPublicationTopicPermissions } from '@shared/api/group-publication/group-publication-grants.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RtcCarrierGapAdmission } from '@shared/multicast/compute-rtc-outbound-carrier-availability.ts';
import { RTC_GRANTED_PUBLICATION_REFUSALS } from '@shared/multicast/publication/compute-rtc-granted-publication-refusal.ts';
import {
    signRtcPublication,
    type RtcPublicationSigningFailure,
    type SignRtcPublicationInput
} from '@shared/multicast/publication/sign-rtc-publication.ts';
import { importEcdsaP256PublicKey } from '@shared/signature/ecdsa-p256-signature.ts';
import type { PublicationCrypto } from '@shared/signature/publication-crypto.ts';

import {
    createAvailablePublicationCryptoFixture,
    UNAVAILABLE_PUBLICATION_CRYPTO,
    type AvailablePublicationCrypto
} from '../signature/publication-crypto-fixtures.ts';
import { createRtcGrantedTopicsFixture } from './rtc-granted-topic-reader-fixtures.ts';
import {
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    ORIGIN_ROOM,
    toOriginDirectedSnapshot,
    toOriginFrozenTargets,
    type RtcOriginOverlayFixture
} from './rtc-origin-overlay-fixture.ts';
import {
    createPublicationRoomSnapshot,
    PUBLICATION_TOPIC_ID,
    PUBLISH_ONLY,
    SUBSCRIBE_ONLY
} from './rtc-publication-proof-fixtures.ts';

describe('the RTC origin of a granted publication', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('signs the admitted room multicast once: the stored row and every transport copy carry one valid proof', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const fixture = createGrantedFixture(crypto, toKeyedSnapshot(crypto));
        const message = createGrantedMulticast('none');

        const admitted = await fixture.manager.enqueueLegIfAbsent(message, 'hold');
        const stored = await readStoredMessage(fixture, admitted.entries[0]!);
        await vi.advanceTimersByTimeAsync(0);

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(admitted.message.proof).toEqual({ alg: 'ES256', keyId: crypto.keyPair.keyId, signature: expect.any(String) });
        expect(admitted.message.targets).toEqual(toOriginFrozenTargets(['b', 'c'], 3));
        const copies = [...fixture.channels.b!.sent, ...fixture.channels.c!.sent];
        expect(copies).toHaveLength(2);
        for (const carried of [stored, ...copies]) {
            expect(carried.proof).toEqual(admitted.message.proof);
            expect(toALPublicationProofSigningInput(carried)).toBe(toALPublicationProofSigningInput(admitted.message));
            expect((await verifyProof(crypto, carried)).left).toBeUndefined();
        }
    });

    // Admission and dequeue are pinned through the leg and its sent copies above; these two stages have no public probe.
    it.each(['replan', 'hand-over'] as const)(
        'keeps a byte-identical signing input in its plan at %s, in the message and in every copy',
        async (stage) => {
            const crypto = await createAvailablePublicationCryptoFixture();
            const fixture = createGrantedFixture(crypto, toKeyedSnapshot(crypto));
            const admitted = await fixture.manager.enqueueLegIfAbsent(createGrantedMulticast('none'), 'hold');
            const signingInput = toALPublicationProofSigningInput(admitted.message);

            // The stage planner is the manager's own; element access reaches it without widening its type.
            const plan = fixture.manager['planOutgoingMessage'](admitted.message, stage);

            expect(plan.dropReasonCode, plan.dropReason).toBeUndefined();
            const copies = plan.preparedMessages.map((prepared) => reconstructALOutboundTransportMessage(prepared, plan.msg));
            expect(copies).toHaveLength(2);
            for (const planned of [plan.msg, ...copies]) {
                expect(planned.proof).toEqual(admitted.message.proof);
                expect(toALPublicationProofSigningInput(planned)).toBe(signingInput);
            }
        }
    );

    it.each<[
        string,
        RtcPublicationSigningFailure['kind'],
        (crypto: AvailablePublicationCrypto) => PublicationCrypto,
        (crypto: AvailablePublicationCrypto) => GroupSnapshot
    ]>([
        ['a keyless page', 'signing-unavailable', () => UNAVAILABLE_PUBLICATION_CRYPTO, (crypto) => toKeyedSnapshot(crypto)],
        ['a page its snapshot names by an older keyId', 'key-not-registered', (crypto) => crypto, () => createOriginSnapshot(['a', 'b', 'c'], 3)]
    ])('refuses %s before admission as unsupported (%s), sending and storing nothing', async (_name, kind, toCrypto, toSnapshot) => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const fixture = createGrantedFixture(toCrypto(crypto), toSnapshot(crypto));
        const message = createGrantedMulticast('none');

        const refused = await enqueueLegAndDrain(fixture, message, 'hand-over');

        expect(refused).toMatchObject({
            verdict: { kind: 'refused', reason: 'unsupported', detail: expect.stringMatching(new RegExp(`^${kind}: `)) },
            message,
            entries: []
        });
        expect(await fixture.resources.workQueue.getAllKeys()).toEqual([]);
        expect([...fixture.channels.b!.sent, ...fixture.channels.c!.sent]).toEqual([]);
    });

    it('freezes a granted publication to the live sessions whose principal holds subscribe before it signs that audience', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const fixture = createGrantedFixture(crypto, toKeyedSnapshot(crypto, { b: SUBSCRIBE_ONLY }));

        const admitted = await enqueueLegAndDrain(fixture, createGrantedMulticast('none'), 'hold');

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(admitted.message.targets).toEqual(toOriginFrozenTargets(['b'], 3));
        expect((await verifyProof(crypto, admitted.message)).left).toBeUndefined();
        expect(fixture.channels.b!.sent.map((sent) => sent.targets)).toEqual([toOriginFrozenTargets(['b'], 3)]);
    });

    it('signs and carries a granted publication that asks a receipt, its receipt expecting the narrowed audience', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const fixture = createGrantedFixture(crypto, toKeyedSnapshot(crypto, { b: SUBSCRIBE_ONLY }));
        const message = createGrantedMulticast('receiver');

        const admitted = await enqueueLegAndDrain(fixture, message, 'hand-over');

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(admitted.message.targets).toEqual(toOriginFrozenTargets(['b'], 3));
        expect(fixture.channels.b!.sent.map((sent) => sent.proof)).toEqual([admitted.message.proof]);
        expect((await verifyProof(crypto, fixture.channels.b!.sent[0]!)).left).toBeUndefined();
        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toMatchObject({ mode: 'receiver', expectedPeerIds: ['b'] });
    });

    it.each<[string, Readonly<Record<string, GroupPublicationTopicPermissions>>, readonly string[] | undefined]>([
        ['holds subscribe, signed and frozen to the leader alone', { b: SUBSCRIBE_ONLY, c: SUBSCRIBE_ONLY }, ['c']],
        ['holds no subscribe, refused before signing as unsupported', { b: SUBSCRIBE_ONLY }, undefined]
    ])('carries a granted group-leader leg whose leader %s', async (_name, grants, recipientPeerIds) => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const fixture = createGrantedFixture(crypto, toOriginDirectedSnapshot(toKeyedSnapshot(crypto, grants), 'c', Date.now()));
        const message = createGrantedMulticast('group-leader');

        const result = await enqueueLegAndDrain(fixture, message, 'hand-over');

        if (recipientPeerIds === undefined) {
            expect(result).toMatchObject({
                verdict: {
                    kind: 'refused',
                    reason: 'unsupported',
                    detail: 'no-leader: the room has no active leader inside the audience the send names'
                },
                message,
                entries: []
            });
            expect(result.message.proof).toBeUndefined();
            expect([...fixture.channels.b!.sent, ...fixture.channels.c!.sent]).toEqual([]);
            return;
        }
        expect(result.verdict.kind, result.reason).toBe('admitted');
        expect(result.message.targets).toEqual(toOriginFrozenTargets(recipientPeerIds, 3));
        expect((await verifyProof(crypto, result.message)).left).toBeUndefined();
    });

    it.each<[string, Partial<Extract<ALTargets, { mode: 'broadcast'; }>>]>([
        ['its exclusions', { exceptPeerIds: ['c'] }],
        ['its fixed list, which the origin would freeze as a multicast', { recipientPeerIds: ['b'] }]
    ])('refuses a granted room broadcast naming %s as not a multicast before it is frozen or signed', async (_name, audience) => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const fixture = createGrantedFixture(crypto, toKeyedSnapshot(crypto));
        const message: ALMessage = {
            ...createGrantedMulticast('none'),
            targets: { mode: 'broadcast', scope: 'room', groupRef: ORIGIN_ROOM, ...audience }
        };

        const refused = await enqueueLegAndDrain(fixture, message, 'hand-over');

        expect(refused).toMatchObject({
            verdict: { kind: 'refused', reason: 'unsupported', detail: RTC_GRANTED_PUBLICATION_REFUSALS.notMulticast },
            message,
            entries: []
        });
        expect(refused.message.proof).toBeUndefined();
        expect(await fixture.resources.workQueue.getAllKeys()).toEqual([]);
        expect([...fixture.channels.b!.sent, ...fixture.channels.c!.sent]).toEqual([]);
    });

    it('refuses through enqueueIfAbsent a granted room broadcast carrying a proof, judged by the targets its sender gave', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const fixture = createGrantedFixture(crypto, toKeyedSnapshot(crypto));
        const message = (await signALPublicationProof({
            subtle: crypto.subtle,
            keyPair: crypto.keyPair,
            message: {
                ...createGrantedMulticast('none'),
                targets: { mode: 'broadcast', scope: 'room', groupRef: ORIGIN_ROOM, recipientPeerIds: ['b'] }
            }
        })).right!;

        const refused = await fixture.manager.enqueueIfAbsent(message);
        await vi.advanceTimersByTimeAsync(0);

        expect(refused.verdict).toEqual({
            kind: 'refused',
            reason: 'unsupported',
            detail: RTC_GRANTED_PUBLICATION_REFUSALS.notMulticast
        });
        expect([...fixture.channels.b!.sent, ...fixture.channels.c!.sent]).toEqual([]);
    });

    it('refuses a granted message without a proof through enqueueIfAbsent, which never signs', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const fixture = createGrantedFixture(crypto, toKeyedSnapshot(crypto));

        const refused = await fixture.manager.enqueueIfAbsent(createGrantedMulticast('none'));
        await vi.advanceTimersByTimeAsync(0);

        expect(refused.verdict).toEqual({
            kind: 'refused',
            reason: 'unsupported',
            detail: RTC_GRANTED_PUBLICATION_REFUSALS.unsigned
        });
        expect([...fixture.channels.b!.sent, ...fixture.channels.c!.sent]).toEqual([]);
    });

    it('holds the page key where no property of the manager reaches it', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const fixture = createGrantedFixture(crypto, toKeyedSnapshot(crypto));
        const manager: object = fixture.manager;

        expect(Reflect.ownKeys(manager)).not.toContain('publicationCrypto');
        expect(Object.values(manager)).not.toContain(crypto);
    });

    it('carries a publication on a topic that is not granted unsigned', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const fixture = createGrantedFixture(crypto, toKeyedSnapshot(crypto));
        const message = { ...createGrantedMulticast('none'), route: { ...createGrantedMulticast('none').route, topicId: 'room.chat' } };

        const admitted = await enqueueLegAndDrain(fixture, message, 'hold');

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(fixture.channels.b!.sent.map((sent) => sent.proof)).toEqual([undefined]);
    });
});

describe('signRtcPublication', () => {
    it('signs a frozen room multicast with the key its own snapshot names', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const message = toFrozen(createGrantedMulticast('none'));

        const signed = await signRtcPublication(toSigningInput(crypto, toKeyedSnapshot(crypto), message));

        expect(signed.right).toEqual({ ...message, proof: { alg: 'ES256', keyId: crypto.keyPair.keyId, signature: expect.any(String) } });
        expect((await verifyProof(crypto, signed.right!)).left).toBeUndefined();
    });

    it.each<[RtcPublicationSigningFailure['kind'], (crypto: AvailablePublicationCrypto) => SignRtcPublicationInput]>([
        [
            'signing-unavailable',
            () => ({
                crypto: UNAVAILABLE_PUBLICATION_CRYPTO,
                snapshot: null,
                selfSessionId: 'a',
                nowEpochMs: Date.now(),
                message: createGrantedMulticast('none')
            })
        ],
        ['no-authority', (crypto) => toSigningInput(crypto, null, createGrantedMulticast('none'))],
        [
            'key-not-registered',
            (crypto) => toSigningInput(crypto, createOriginSnapshot(['a', 'b', 'c'], 3), createGrantedMulticast('none'))
        ],
        ['unfrozen-audience', (crypto) => toSigningInput(crypto, toKeyedSnapshot(crypto), createGrantedMulticast('none'))],
        [
            'sign-failed',
            (crypto) => ({
                ...toSigningInput(crypto, toKeyedSnapshot(crypto), toFrozen(createGrantedMulticast('none'))),
                crypto: toUnsignableCrypto(crypto)
            })
        ]
    ])('answers %s first among the failures the input still holds', async (kind, toInput) => {
        const crypto = await createAvailablePublicationCryptoFixture();

        const signed = await signRtcPublication(toInput(crypto));

        expect(signed.left).toEqual({ kind, message: expect.any(String) });
    });

    it('answers no-authority for a null snapshot before any later step, whose failure the input also holds', async () => {
        const crypto = toUnsignableCrypto(await createAvailablePublicationCryptoFixture());

        const signed = await signRtcPublication(toSigningInput(crypto, null, toFrozen(createGrantedMulticast('none'))));

        expect(signed.left?.kind).toBe('no-authority');
    });

    it('answers key-not-registered for a snapshot naming another keyId of this session', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const older = await createAvailablePublicationCryptoFixture();

        const signed = await signRtcPublication(toSigningInput(crypto, toKeyedSnapshot(older), toFrozen(createGrantedMulticast('none'))));

        expect(signed.left?.kind).toBe('key-not-registered');
    });
});

function createGrantedFixture(crypto: PublicationCrypto, snapshot: GroupSnapshot): RtcOriginOverlayFixture {
    return createRtcOriginOverlayFixture({
        snapshot,
        nextHopPeerIds: ['b', 'c'],
        grantedTopics: createRtcGrantedTopicsFixture([PUBLICATION_TOPIC_ID]),
        publicationCrypto: crypto
    });
}

/**
 * The room of `a`, `b` and `c` whose snapshot attests `a`'s page key; `grants` is each principal's permissions on the
 * granted topic, absent, `b` and `c` may subscribe.
 */
function toKeyedSnapshot(
    crypto: AvailablePublicationCrypto,
    grants: Readonly<Record<string, GroupPublicationTopicPermissions>> = { b: SUBSCRIBE_ONLY, c: SUBSCRIBE_ONLY }
): GroupSnapshot {
    return createPublicationRoomSnapshot({
        sessionIds: ['a', 'b', 'c'],
        snapshotVersion: 3,
        keys: { a: toGroupPresencePublicationKey(crypto)! },
        grants: { a: PUBLISH_ONLY, ...grants }
    });
}

function createGrantedMulticast(ack: ALAckMode): ALMessage {
    return newALMulticastMessage(
        'a',
        { topicId: PUBLICATION_TOPIC_ID, resourceId: 'feed-1', contextId: ORIGIN_ROOM.groupId },
        ORIGIN_ROOM,
        'room.granted-feed.v1',
        { text: 'feed' },
        { ack, reliability: 'best-effort', ttlMs: 30_000, traceId: 'trace-rtc-publication-signing' }
    );
}

/** The page's key pair with a private key WebCrypto refuses to sign with. */
function toUnsignableCrypto(crypto: AvailablePublicationCrypto): AvailablePublicationCrypto {
    return { ...crypto, keyPair: { ...crypto.keyPair, privateKey: {} as CryptoKey } };
}

function toFrozen(message: ALMessage): ALMessage {
    return { ...message, targets: toOriginFrozenTargets(['b', 'c'], 3) };
}

function toSigningInput(crypto: PublicationCrypto, snapshot: GroupSnapshot | null, message: ALMessage): SignRtcPublicationInput {
    return { crypto, snapshot, selfSessionId: 'a', nowEpochMs: Date.now(), message };
}

async function verifyProof(crypto: AvailablePublicationCrypto, message: ALMessage) {
    const publicKey = (await importEcdsaP256PublicKey(crypto.subtle, crypto.keyPair.publicJwk)).right!;
    return await verifyALPublicationProof({ subtle: crypto.subtle, publicKey, message });
}

async function readStoredMessage(fixture: RtcOriginOverlayFixture, entry: ALOutboundEnqueueResult['entries'][number]): Promise<ALMessage> {
    return JSON.parse((await fixture.resources.workQueue.getItem(entry.key))!.resource) as ALMessage;
}

async function enqueueLegAndDrain(fixture: RtcOriginOverlayFixture, message: ALMessage, carrierGap: RtcCarrierGapAdmission) {
    const result = await fixture.manager.enqueueLegIfAbsent(message, carrierGap);
    await vi.advanceTimersByTimeAsync(0);
    return result;
}
