import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    newALMulticastMessage,
    newALPrincipalBroadcastMessage,
    newALUnicastMessage,
    type ALAckMode,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { resolveALFrozenMulticastAudience } from '@shared/al-contracts/al-frozen-multicast-audience.ts';
import {
    signALPublicationProof,
    toALPublicationProofSigningInput,
    verifyALPublicationProof
} from '@shared/al-contracts/publication-proof/al-publication-proof.ts';
import { isALDeliveryAdmissionFallbackVerdict } from '@shared/alm/delivery/resolve-al-delivery-fallback-trigger.ts';
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
    ROOM_PUBLICATION_KEY,
    UNAVAILABLE_PUBLICATION_CRYPTO,
    type AvailablePublicationCrypto
} from '../signature/publication-crypto-fixtures.ts';
import { createRtcGrantedTopicsFixture } from './rtc-granted-topic-reader-fixtures.ts';
import {
    createOriginOverlay,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    ORIGIN_PRINCIPAL_REF,
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

const GRANTED_ROUTE = { topicId: PUBLICATION_TOPIC_ID, resourceId: 'feed-1', contextId: ORIGIN_ROOM.groupId };

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

    it('refuses a leg its admission cannot sign as unsupported, naming the leg its sender gave and storing nothing', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const fixture = createGrantedFixture(toUnsignableCrypto(crypto), toKeyedSnapshot(crypto));
        const message = toFeedFrame(createGrantedMulticast('none'), 1);

        const refused = await enqueueLegAndDrain(fixture, message, 'hand-over');

        expect(refused.verdict).toEqual({ kind: 'refused', reason: 'unsupported', detail: expect.stringMatching(/^sign-failed: /) });
        expect(refused.message).toEqual(message);
        expect(refused.entries).toEqual([]);
        expect(isALDeliveryAdmissionFallbackVerdict(refused.verdict)).toBe(true);
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

    it('freezes a granted list to the listed sessions that hold subscribe, a listed non-holder left out, before it signs', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const fixture = createGrantedLeafFixture(crypto, toKeyedSnapshot(crypto, { b: SUBSCRIBE_ONLY, c: PUBLISH_ONLY }));
        const message: ALMessage = {
            ...createGrantedMulticast('receiver'),
            targets: { mode: 'broadcast', scope: 'room', groupRef: ORIGIN_ROOM, recipientPeerIds: ['b', 'c'] }
        };

        const admitted = await enqueueLegAndDrain(fixture, message, 'hand-over');

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(admitted.message.targets).toEqual(toOriginFrozenTargets(['b'], 3));
        expect((await verifyProof(crypto, admitted.message)).left).toBeUndefined();
        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toMatchObject({ mode: 'receiver', expectedPeerIds: ['b'] });
        expect(fixture.channels.c!.sent).toEqual([]);
    });

    it('freezes and signs a granted unicast as a one-recipient multicast its receipt expects alone', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const fixture = createGrantedFixture(crypto, toKeyedSnapshot(crypto));
        const message = createGrantedUnicast();

        const admitted = await enqueueLegAndDrain(fixture, message, 'hand-over');

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(admitted.message.targets).toEqual(toOriginFrozenTargets(['b'], 3));
        expect((await verifyProof(crypto, admitted.message)).left).toBeUndefined();
        expect(fixture.channels.b!.sent[0]?.targets).toEqual(toOriginFrozenTargets(['b'], 3));
        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toMatchObject({ mode: 'receiver', expectedPeerIds: ['b'] });
    });

    it.each<[string, Readonly<Record<string, GroupPublicationTopicPermissions>> | undefined, string]>([
        ['a non-holder', { b: PUBLISH_ONLY }, 'b'],
        ['its own sender', undefined, 'a']
    ])('admits a granted unicast to %s as a complete receipt of zero recipients', async (_name, grants, toPeerId) => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const fixture = createGrantedFixture(crypto, toKeyedSnapshot(crypto, grants));

        const admitted = await enqueueLegAndDrain(fixture, createGrantedUnicast('receiver', toPeerId), 'hand-over');

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(admitted.message.targets).toEqual(toOriginFrozenTargets([], 3));
        expect([...fixture.channels.b!.sent, ...fixture.channels.c!.sent]).toEqual([]);
        expect(fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)).toMatchObject({
            expectedRecipientPeerIds: [],
            complete: true
        });
    });

    it('refuses a granted unicast to a non-holder asking no receipt as no-route, the refusal a fallback takes over', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const fixture = createGrantedFixture(crypto, toKeyedSnapshot(crypto, { b: PUBLISH_ONLY }));

        const refused = await enqueueLegAndDrain(fixture, createGrantedUnicast('none'), 'hand-over');

        expect(refused.verdict).toMatchObject({ kind: 'unroutable', reason: 'no-route' });
        expect(isALDeliveryAdmissionFallbackVerdict(refused.verdict)).toBe(true);
        expect([...fixture.channels.b!.sent, ...fixture.channels.c!.sent]).toEqual([]);
    });

    it('freezes a granted principal broadcast in its room to that principal\'s subscribing sessions', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const { principalId } = ORIGIN_PRINCIPAL_REF;
        const snapshot = toKeyedSnapshot(crypto, { [principalId]: SUBSCRIBE_ONLY });
        const fixture = createGrantedFixture(crypto, {
            ...snapshot,
            activeSessions: snapshot.activeSessions.map((session) => ['b', 'c'].includes(session.sessionId) ? { ...session, principalId } : session),
            members: [...snapshot.members, { ...snapshot.members[0]!, principalId }]
        });
        const message = newALPrincipalBroadcastMessage(
            'a',
            GRANTED_ROUTE,
            { groupRef: ORIGIN_ROOM, principalRef: ORIGIN_PRINCIPAL_REF },
            'room.granted-feed.v1',
            { text: 'feed' },
            { ack: 'none', ttlMs: 30_000 }
        );

        const admitted = await enqueueLegAndDrain(fixture, message, 'hand-over');

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(admitted.message.targets).toEqual(toOriginFrozenTargets(['b', 'c'], 3));
        expect((await verifyProof(crypto, admitted.message)).left).toBeUndefined();
    });

    it.each<{
        name: string;
        director: string | undefined;
        grants: Readonly<Record<string, GroupPublicationTopicPermissions>>;
        verdict: Partial<ALOutboundEnqueueResult['verdict']>;
    }>([
        {
            name: 'a leader that holds subscribe, signed and frozen to the leader alone',
            director: 'c',
            grants: { b: SUBSCRIBE_ONLY, c: SUBSCRIBE_ONLY },
            verdict: { kind: 'admitted' }
        },
        {
            name: 'a leader that holds no subscribe, refused before signing as unsupported',
            director: 'c',
            grants: { b: SUBSCRIBE_ONLY },
            verdict: { kind: 'refused', reason: 'unsupported', detail: RTC_GRANTED_PUBLICATION_REFUSALS.leaderNotSubscribed }
        },
        {
            name: 'no leader at all, refused no-leader as any room send is',
            director: undefined,
            grants: { b: SUBSCRIBE_ONLY, c: SUBSCRIBE_ONLY },
            verdict: { kind: 'refused', reason: 'no-leader' }
        },
        {
            name: 'its own sender as the leader, which holds no subscribe, refused no-leader as any room send is',
            director: 'a',
            grants: { b: SUBSCRIBE_ONLY, c: SUBSCRIBE_ONLY },
            verdict: { kind: 'refused', reason: 'no-leader' }
        }
    ])('carries a granted group-leader leg to $name', async ({ director, grants, verdict }) => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const keyed = toKeyedSnapshot(crypto, grants);
        const fixture = createGrantedFixture(crypto, director === undefined ? keyed : toOriginDirectedSnapshot(keyed, director, Date.now()));

        const result = await enqueueLegAndDrain(fixture, createGrantedMulticast('group-leader'), 'hand-over');

        expect(result.verdict, result.reason).toMatchObject(verdict);
        if (verdict.kind === 'admitted') {
            expect(result.message.targets).toEqual(toOriginFrozenTargets(['c'], 3));
            expect((await verifyProof(crypto, result.message)).left).toBeUndefined();
        }
        else {
            expect(result.entries).toEqual([]);
            expect([...fixture.channels.b!.sent, ...fixture.channels.c!.sent]).toEqual([]);
        }
    });

    it('refuses a granted room broadcast naming its exclusions alone as an audience its origin cannot freeze before it is frozen or signed', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const fixture = createGrantedFixture(crypto, toKeyedSnapshot(crypto));
        const message: ALMessage = {
            ...createGrantedMulticast('none'),
            targets: { mode: 'broadcast', scope: 'room', groupRef: ORIGIN_ROOM, exceptPeerIds: ['c'] }
        };

        const refused = await enqueueLegAndDrain(fixture, message, 'hand-over');

        expect(refused).toMatchObject({
            verdict: { kind: 'refused', reason: 'unsupported', detail: RTC_GRANTED_PUBLICATION_REFUSALS.unfrozenAudience },
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
            detail: RTC_GRANTED_PUBLICATION_REFUSALS.unfrozenAudience
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

    it('refuses a granted send whose narrowed audience passes the RTC room limit as unsupported before it signs, handing over the targets its sender gave', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const fixture = createGrantedFixture(crypto, toSubscribedRoomSnapshot(crypto, 300));
        const message = createGrantedMulticast('receiver');

        const result = await enqueueLegAndDrain(fixture, message, 'hand-over');

        expect(result.verdict).toEqual({
            kind: 'refused',
            reason: 'unsupported',
            detail: 'RTC room multicast audience of 299 recipients exceeds the RTC room limit of 256'
        });
        expect(result.message).toEqual(message);
        expect(isALDeliveryAdmissionFallbackVerdict(result.verdict)).toBe(true);
        expect(result.entries).toEqual([]);
        expect([...fixture.channels.b!.sent, ...fixture.channels.c!.sent]).toEqual([]);
    });

    it('still signs a granted send to a narrowed audience of 256', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const fixture = createGrantedFixture(crypto, toSubscribedRoomSnapshot(crypto, 257));

        const admitted = await enqueueLegAndDrain(fixture, createGrantedMulticast('none'), 'hand-over');

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(resolveALFrozenMulticastAudience(admitted.message.targets)?.recipientPeerIds).toHaveLength(256);
        expect((await verifyProof(crypto, admitted.message)).left).toBeUndefined();
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

describe('the ordering record of a granted publication its RTC origin signs', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('signs a keyed frame over its sequence and its record, which every stored and sent copy carries', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const fixture = createGrantedFixture(crypto, toKeyedSnapshot(crypto));

        const admitted = await enqueueLegAndDrain(fixture, toFeedFrame(createGrantedMulticast('none'), 1), 'hold');
        const stored = await readStoredMessage(fixture, admitted.entries[0]!);

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(admitted.message.ordering).toEqual({ orderingKey: 'feed', epoch: 1, seq: 1, priorSeqByRecipient: {} });
        expect(toALPublicationProofSigningInput(admitted.message)).toContain('["ordering.priorSeqByRecipient",{}]');
        const copies = [...fixture.channels.b!.sent, ...fixture.channels.c!.sent];
        expect(copies).toHaveLength(2);
        for (const carried of [stored, ...copies]) {
            expect(carried.ordering).toEqual(admitted.message.ordering);
            expect(carried.proof).toEqual(admitted.message.proof);
            expect((await verifyProof(crypto, carried)).left).toBeUndefined();
        }
    });

    it('names in the next signed frame a subscriber the narrowed frame before it left out', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const fixture = createGrantedFixture(crypto, toKeyedSnapshot(crypto, { b: SUBSCRIBE_ONLY }));
        const first = await enqueueLegAndDrain(fixture, toFeedFrame(createGrantedMulticast('none'), 1), 'hold');
        fixture.groups.accept('room', toKeyedSnapshot(crypto, { b: SUBSCRIBE_ONLY, c: SUBSCRIBE_ONLY }, 4));

        const second = await enqueueLegAndDrain(fixture, toFeedFrame(createGrantedMulticast('none'), 2), 'hold');

        expect(first.message.targets).toEqual(toOriginFrozenTargets(['b'], 3));
        expect(second.verdict.kind, second.reason).toBe('admitted');
        expect(second.message.targets).toEqual(toOriginFrozenTargets(['b', 'c'], 4));
        expect(second.message.ordering?.priorSeqByRecipient).toEqual({ c: 0 });
        expect((await verifyProof(crypto, second.message)).left).toBeUndefined();
        expect(fixture.channels.c!.sent.at(-1)?.ordering).toEqual(second.message.ordering);
    });

    it('resends the stored signed envelope byte for byte when it re-plans it and when a held frame is dequeued', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const fixture = createGrantedFixture(crypto, toKeyedSnapshot(crypto));
        fixture.overlays.delete('room');

        const held = await enqueueLegAndDrain(fixture, toFeedFrame(createDurableGrantedMulticast(), 1), 'hold');
        const stored = await readStoredMessage(fixture, held.entries[0]!);
        // The stage planner is the manager's own; element access reaches it without widening its type.
        const replanned = fixture.manager['planOutgoingMessage'](stored, 'replan');
        fixture.overlays.accept('room', createOriginOverlay(['b', 'c']));
        await vi.advanceTimersByTimeAsync(200);

        expect(held.verdict, held.reason).toMatchObject({ kind: 'admitted', durable: true });
        expect(stored.ordering).toEqual({ orderingKey: 'feed', epoch: 1, seq: 1, priorSeqByRecipient: {} });
        expect(replanned.msg).toEqual(stored);
        const dequeued = [...fixture.channels.b!.sent, ...fixture.channels.c!.sent];
        expect(dequeued).toHaveLength(2);
        for (const carried of dequeued) {
            expect(toALPublicationProofSigningInput(carried)).toBe(toALPublicationProofSigningInput(stored));
            expect(carried.proof).toEqual(stored.proof);
        }
    });

    it('re-sends a stored granted list from its frozen signed copy without re-signing', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const fixture = createGrantedFixture(crypto, toKeyedSnapshot(crypto));
        fixture.overlays.delete('room');
        const list: ALMessage = {
            ...toFeedFrame(createDurableGrantedMulticast(), 1),
            targets: { mode: 'broadcast', scope: 'room', groupRef: ORIGIN_ROOM, recipientPeerIds: ['b'] }
        };

        const held = await enqueueLegAndDrain(fixture, list, 'hold');
        const stored = await readStoredMessage(fixture, held.entries[0]!);
        // The stage planner is the manager's own; element access reaches it without widening its type.
        const replanned = fixture.manager['planOutgoingMessage'](stored, 'replan');
        fixture.overlays.accept('room', createOriginOverlay(['b', 'c']));
        await vi.advanceTimersByTimeAsync(200);

        expect(held.verdict, held.reason).toMatchObject({ kind: 'admitted', durable: true });
        expect(stored.targets).toEqual(toOriginFrozenTargets(['b'], 3));
        expect((await verifyProof(crypto, stored)).left).toBeUndefined();
        expect(replanned.dropReasonCode, replanned.dropReason).toBeUndefined();
        expect(replanned.msg).toEqual(stored);
        expect(fixture.channels.b!.sent.map((sent) => [sent.targets, sent.proof])).toEqual([[stored.targets, stored.proof]]);
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

/** The origin room's tree, where `b` and `c` are leaves: the origin sends a copy only toward a recipient it froze. */
function createGrantedLeafFixture(crypto: PublicationCrypto, snapshot: GroupSnapshot): RtcOriginOverlayFixture {
    return createRtcOriginOverlayFixture({
        snapshot,
        nextHopPeerIds: ['b', 'c'],
        nextHopsBySessionId: { a: ['b', 'c'], b: ['a'], c: ['a'] },
        grantedTopics: createRtcGrantedTopicsFixture([PUBLICATION_TOPIC_ID]),
        publicationCrypto: crypto
    });
}

/**
 * The room of `a`, `b` and `c` whose snapshot attests `a`'s page key and the room key of `b` and `c`; `grants` is each principal's permissions on the
 * granted topic, absent, `b` and `c` may subscribe; `snapshotVersion`, absent, 3.
 */
function toKeyedSnapshot(
    crypto: AvailablePublicationCrypto,
    grants: Readonly<Record<string, GroupPublicationTopicPermissions>> = { b: SUBSCRIBE_ONLY, c: SUBSCRIBE_ONLY },
    snapshotVersion = 3
): GroupSnapshot {
    return createPublicationRoomSnapshot({
        sessionIds: ['a', 'b', 'c'],
        snapshotVersion,
        keys: { a: toGroupPresencePublicationKey(crypto)!, b: ROOM_PUBLICATION_KEY, c: ROOM_PUBLICATION_KEY },
        grants: { a: PUBLISH_ONLY, ...grants }
    });
}

/**
 * The room of `sessionCount` sessions, `a`, `b`, `c` and then `s0`, `s1`, ...: `a` publishes and every other session subscribes,
 * registering the room key.
 */
function toSubscribedRoomSnapshot(crypto: AvailablePublicationCrypto, sessionCount: number): GroupSnapshot {
    const sessionIds = ['a', 'b', 'c', ...Array.from({ length: sessionCount - 3 }, (_, index) => `s${index}`)];
    const subscribers = Object.fromEntries(sessionIds.slice(1).map((sessionId) => [sessionId, SUBSCRIBE_ONLY]));
    return createPublicationRoomSnapshot({
        sessionIds,
        snapshotVersion: 3,
        keys: { ...Object.fromEntries(sessionIds.map((sessionId) => [sessionId, ROOM_PUBLICATION_KEY])), a: toGroupPresencePublicationKey(crypto)! },
        grants: { a: PUBLISH_ONLY, ...subscribers }
    });
}

/** A granted unicast to `toPeerId` (`b` unless named) in the origin room, asking a receipt unless `ack` says otherwise. */
function createGrantedUnicast(ack: 'none' | 'receiver' = 'receiver', toPeerId = 'b'): ALMessage {
    return newALUnicastMessage('a', GRANTED_ROUTE, toPeerId, 'room.granted-feed.v1', { text: 'feed' }, {
        ack,
        groupRef: ORIGIN_ROOM,
        ttlMs: 30_000
    });
}

/** A frame of the `feed` track at `seq`. */
function toFeedFrame(message: ALMessage, seq: number): ALMessage {
    return { ...message, id: { ...message.id, msgId: `${message.id.msgId}-${seq}` }, ordering: { orderingKey: 'feed', epoch: 1, seq } };
}

/** A granted room multicast its sender keeps in the local outbox, so a carrier gap holds it for a dequeue. */
function createDurableGrantedMulticast(): ALMessage {
    return { ...createGrantedMulticast('none'), qos: { durability: { algo: 'local-outbox' } } };
}

function createGrantedMulticast(ack: ALAckMode): ALMessage {
    return newALMulticastMessage(
        'a',
        GRANTED_ROUTE,
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
