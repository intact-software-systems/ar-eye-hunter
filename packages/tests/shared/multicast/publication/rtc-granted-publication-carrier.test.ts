import { describe, expect, it } from 'vitest';

import { newALBroadcastMessage, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { normalizeALQosPolicy } from '@shared/al-contracts/normalize-al-qos-policy.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundRepairRequest
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { toALOutboundMessage } from '@shared/alm/outbound/to-al-outbound-message.ts';
import { toGroupPresencePublicationKey } from '@shared/api/group-presence/to-group-presence-publication-key.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { RTC_GRANTED_PUBLICATION_REFUSALS } from '@shared/multicast/publication/compute-rtc-granted-publication-refusal.ts';
import { RtcGrantedPublicationCarrier } from '@shared/multicast/publication/rtc-granted-publication-carrier.ts';
import { computeRtcRoomSnapshotAdmission, toRtcRoomSnapshotHandlingPlan } from '@shared/multicast/room-authority/rtc-room-snapshot-admission.ts';
import type { PublicationCrypto } from '@shared/signature/publication-crypto.ts';

import {
    createAvailablePublicationCryptoFixture,
    UNAVAILABLE_PUBLICATION_CRYPTO,
    type AvailablePublicationCrypto
} from '../../signature/publication-crypto-fixtures.ts';
import { createRtcGrantedTopicsFixture } from '../rtc-granted-topic-reader-fixtures.ts';
import { ORIGIN_ROOM, toOriginFrozenTargets } from '../rtc-origin-overlay-fixture.ts';
import {
    createFrozenGrantedMulticast,
    createPublicationRoomSnapshot,
    PUBLICATION_TOPIC_ID,
    PUBLISH_AND_SUBSCRIBE,
    PUBLISH_ONLY,
    SUBSCRIBE_ONLY
} from '../rtc-publication-proof-fixtures.ts';
import { KEYLESS_PUBLICATION_VERIFIER } from '../rtc-publication-proof-verifier-fixtures.ts';
import { NO_RTC_TOPIC_SUBSCRIPTIONS } from '../rtc-topic-subscription-reader-fixtures.ts';

const PROOF = { alg: 'ES256', keyId: 'k'.repeat(43), signature: 's'.repeat(86) } as const;

const GRANTED = createFrozenGrantedMulticast({
    senderId: 'a',
    resourceId: 'feed-1',
    recipientPeerIds: ['a', 'b'],
    snapshotVersion: 3
});

const GRANTED_UNICAST = newALUnicastMessage('a', GRANTED.route, 'b', GRANTED.payload.typeId, {}, { ack: 'none', groupRef: ORIGIN_ROOM });

const GRANTED_LIST = newALBroadcastMessage('a', GRANTED.route, 'room', GRANTED.payload.typeId, {}, {
    ack: 'none',
    groupRef: ORIGIN_ROOM,
    recipientPeerIds: ['b', 'c']
});

const MEMBERS: ALMessage = { ...GRANTED, route: { ...GRANTED.route, topicId: 'room.chat' } };

describe('RtcGrantedPublicationCarrier', () => {
    it('admits a granted unicast and a granted list leg for the shape its sender gave', async () => {
        const carrier = createKeyedCarrier(await createAvailablePublicationCryptoFixture());

        expect(carrier.admitLeg(GRANTED_UNICAST, (leg) => leg).right?.targets).toEqual({
            mode: 'broadcast',
            scope: 'room',
            groupRef: ORIGIN_ROOM,
            recipientPeerIds: ['b']
        });
        expect(carrier.admitLeg(GRANTED_LIST, (leg) => leg).right).toBe(GRANTED_LIST);
    });

    it('refuses a granted leg naming no room before it asks for the admitted message', () => {
        const unicast = newALUnicastMessage('a', GRANTED.route, 'b', GRANTED.payload.typeId, {});

        const admitted = createKeylessCarrier().admitLeg(unicast, () => {
            throw new Error('A shape refusal admits nothing.');
        });

        expect(admitted.left).toBe(RTC_GRANTED_PUBLICATION_REFUSALS.unfrozenAudience);
    });

    it('passes an unfrozen leg of an expired room authority through the room-limit judgement unchanged', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const keyed = createKeyedSnapshot(crypto);
        const expired: GroupSnapshot = { ...keyed, group: { ...keyed.group, expiresAtEpochMs: Date.now() - 1 } };
        const admission = computeRtcRoomSnapshotAdmission({
            message: GRANTED_LIST,
            snapshot: expired,
            overlay: undefined,
            selfPeerId: 'a',
            fromPeerId: undefined,
            recipientPeerId: undefined,
            layoutHistory: { transition: null, replacedLayoutOverlapMs: 15_000 },
            nowMs: Date.now()
        });

        expect(admission.kind).not.toBe('authorized');
        expect(createCarrier(crypto, expired).admitLeg(GRANTED_LIST, (leg) => leg).right).toBe(GRANTED_LIST);
    });

    it('refuses a granted leg whose frozen audience passes the RTC room limit as unsupported after the freeze', async () => {
        const carrier = createKeyedCarrier(await createAvailablePublicationCryptoFixture());
        const recipientPeerIds = Array.from({ length: 257 }, (_, index) => `s${index}`);

        const admitted = carrier.admitLeg(GRANTED_LIST, (leg) => ({ ...leg, targets: toOriginFrozenTargets(recipientPeerIds, 3) }));

        expect(admitted.left).toEqual('RTC room multicast audience of 257 recipients exceeds the RTC room limit of 256');
    });

    it('refuses a leg its origin could not sign before it asks for the admitted message, naming the failure first', () => {
        const admitted = createKeylessCarrier().admitLeg(GRANTED, () => {
            throw new Error('A signing refusal admits nothing.');
        });

        expect(admitted.left).toMatch(/^signing-unavailable: /);
    });

    it('passes a frame of a topic that is not granted through its admission signing unchanged', async () => {
        const signed = await createKeylessCarrier().signAdmitted(MEMBERS);

        expect(signed.right).toBe(MEMBERS);
    });

    it('passes a granted frame another session originated through its admission signing with the origin\'s proof', async () => {
        const relayed = { ...GRANTED, id: { ...GRANTED.id, senderId: 'b' }, proof: PROOF };

        const signed = await createKeylessCarrier().signAdmitted(relayed);

        expect(signed.right).toBe(relayed);
    });

    it('answers a granted frame of its own it cannot sign at admission with the failure, named by its kind first', async () => {
        const signed = await createKeylessCarrier().signAdmitted(GRANTED);

        expect(signed.left).toMatch(/^signing-unavailable: /);
    });

    it('forwards a granted frame as it is, and normalizes any other frame as every carrier does', () => {
        const carrier = createKeylessCarrier();
        const granted = { ...GRANTED, proof: PROOF };
        const effective = normalizeALQosPolicy(MEMBERS).effective;

        expect(carrier.toForwardedMessage(granted, effective)).toBe(granted);
        expect(carrier.toForwardedMessage(MEMBERS, effective)).toEqual(toALOutboundMessage(MEMBERS, effective));
    });

    it('keeps the room\'s not-yet-in-sync plan for an ungranted proof while the room it names is still pending', () => {
        const ungrantedProof = { ...MEMBERS, proof: PROOF };
        const plan = planALMessageHandling(ungrantedProof, {
            nowMs: Date.now(),
            selfPeerId: 'b',
            fromPeerId: 'a',
            connectedPeerIds: ['a'],
            groupMemberPeerIds: ['a', 'b'],
            overlayNeighborPeerIds: []
        });
        const roomPlan = toRtcRoomSnapshotHandlingPlan(plan, { kind: 'pending', reason: 'Awaiting room session authority' }, 'a');
        const snapshot = createPublicationRoomSnapshot({ sessionIds: ['a', 'b'], snapshotVersion: 3, keys: {}, grants: {} });

        const planned = createKeylessCarrier().planIncomingPublication({
            msg: ungrantedProof,
            fromPeerId: 'a',
            snapshot,
            admission: { kind: 'pending', reason: 'Awaiting room session authority' },
            plan,
            roomPlan,
            nowMs: Date.now()
        });

        expect(planned).toBe(roomPlan);
        expect(planned).toMatchObject({ dropReasonCode: 'not-yet-in-sync' });
    });
});

describe('a granted publication\'s repair a relay asks for a recipient below it (S4ii-R3)', () => {
    /** Origin `a` froze `leaf` into its receipted publication, sent through the publish-only relay `r`; `late` joined after. */
    const REPAIRED = createFrozenGrantedMulticast({
        senderId: 'a',
        resourceId: 'feed-repair',
        recipientPeerIds: ['a', 'leaf'],
        snapshotVersion: 3,
        ack: 'receiver'
    });
    const ROOM = createPublicationRoomSnapshot({
        sessionIds: ['a', 'r', 'leaf', 'late'],
        snapshotVersion: 3,
        keys: {},
        grants: { a: PUBLISH_AND_SUBSCRIBE, r: PUBLISH_ONLY, leaf: SUBSCRIBE_ONLY, late: SUBSCRIBE_ONLY }
    });
    /** The copy the overlay planned toward the requester, the relay. */
    const PLANNED: ALOutboundDispatchPlan<ALOutboundTransportMessage> = {
        msg: REPAIRED,
        dropReasonCode: undefined,
        lane: 'volatile',
        preparedMessages: [],
        ackTracking: { enabled: true, timeoutMs: 1_000, maxAttempts: 1, expectedPeerIds: ['leaf'], nextHopPeerIds: ['r'], mode: 'receiver' }
    };

    function planRelayRepair(logicalRecipientPeerId: string | undefined) {
        const request: ALOutboundRepairRequest = {
            trigger: 'nack',
            repair: { enabled: true, algo: 'retransmit', maxAttempts: 1 },
            requestedByPeerId: 'r',
            ...(logicalRecipientPeerId === undefined ? {} : { logicalRecipientPeerId }),
            failedPeerIds: [],
            completedHopPeerIds: [],
            orderingTrackKey: 'room.granted-feed:a:1',
            missingRanges: [{ from: 2, to: 2 }]
        };
        return createKeylessCarrier(ROOM).planRepair(REPAIRED, request, () => PLANNED);
    }

    it('sends the copy to the relay for a recipient the origin froze into the message', () => {
        expect(planRelayRepair('leaf')).toBe(PLANNED);
    });

    it('sends no copy for a recipient outside the frozen audience, whichever relay asks', () => {
        expect(planRelayRepair('late')).toBeUndefined();
    });

    it('admits a requester that names no other recipient on itself, as before: a relay outside the audience gets no copy', () => {
        expect(planRelayRepair(undefined)).toBeUndefined();
    });
});

function createKeylessCarrier(snapshot?: GroupSnapshot): RtcGrantedPublicationCarrier {
    return createCarrier(UNAVAILABLE_PUBLICATION_CRYPTO, snapshot);
}

/** A carrier that can sign: its room of `a`, `b` and `c` attests `a`'s page key, and `b` and `c` may subscribe. */
function createKeyedCarrier(crypto: AvailablePublicationCrypto): RtcGrantedPublicationCarrier {
    return createCarrier(crypto, createKeyedSnapshot(crypto));
}

function createKeyedSnapshot(crypto: AvailablePublicationCrypto): GroupSnapshot {
    return createPublicationRoomSnapshot({
        sessionIds: ['a', 'b', 'c'],
        snapshotVersion: 3,
        keys: { a: toGroupPresencePublicationKey(crypto)! },
        grants: { a: PUBLISH_ONLY, b: SUBSCRIBE_ONLY, c: SUBSCRIBE_ONLY }
    });
}

function createCarrier(publicationCrypto: PublicationCrypto, snapshot: GroupSnapshot | undefined): RtcGrantedPublicationCarrier {
    const groupCache = new LatestRepository<string, GroupSnapshot>();
    if (snapshot !== undefined) {
        groupCache.accept(snapshot.group.groupId, snapshot);
    }
    return new RtcGrantedPublicationCarrier({
        groupCache,
        grantedTopics: createRtcGrantedTopicsFixture([PUBLICATION_TOPIC_ID]),
        publicationCrypto,
        publicationVerifier: KEYLESS_PUBLICATION_VERIFIER,
        topicSubscriptions: NO_RTC_TOPIC_SUBSCRIPTIONS,
        selfPrincipalId: 'a',
        selfSessionId: 'a',
        clock: { nowMs: Date.now }
    });
}
