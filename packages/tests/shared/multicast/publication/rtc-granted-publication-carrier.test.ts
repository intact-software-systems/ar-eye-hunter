import { describe, expect, it } from 'vitest';

import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { normalizeALQosPolicy } from '@shared/al-contracts/normalize-al-qos-policy.ts';
import { toALOutboundMessage } from '@shared/alm/outbound/to-al-outbound-message.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { RTC_GRANTED_PUBLICATION_REFUSALS } from '@shared/multicast/publication/compute-rtc-granted-publication-refusal.ts';
import { RtcGrantedPublicationCarrier } from '@shared/multicast/publication/rtc-granted-publication-carrier.ts';
import { toRtcRoomSnapshotHandlingPlan } from '@shared/multicast/rtc-room-snapshot-admission.ts';

import { UNAVAILABLE_PUBLICATION_CRYPTO } from '../../signature/publication-crypto-fixtures.ts';
import { createRtcGrantedTopicsFixture } from '../rtc-granted-topic-reader-fixtures.ts';
import {
    createFrozenGrantedMulticast,
    createPublicationRoomSnapshot,
    PUBLICATION_TOPIC_ID
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

const MEMBERS: ALMessage = { ...GRANTED, route: { ...GRANTED.route, topicId: 'room.chat' } };

describe('RtcGrantedPublicationCarrier', () => {
    it('refuses a granted leg for the shape its sender gave before it asks for the admitted message', () => {
        const unicast = newALUnicastMessage('a', GRANTED.route, 'b', GRANTED.payload.typeId, {});

        const admitted = createKeylessCarrier().admitLeg(unicast, () => {
            throw new Error('A shape refusal admits nothing.');
        });

        expect(admitted.left).toBe(RTC_GRANTED_PUBLICATION_REFUSALS.notMulticast);
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

function createKeylessCarrier(): RtcGrantedPublicationCarrier {
    return new RtcGrantedPublicationCarrier({
        groupCache: new LatestRepository<string, GroupSnapshot>(),
        grantedTopics: createRtcGrantedTopicsFixture([PUBLICATION_TOPIC_ID]),
        publicationCrypto: UNAVAILABLE_PUBLICATION_CRYPTO,
        publicationVerifier: KEYLESS_PUBLICATION_VERIFIER,
        topicSubscriptions: NO_RTC_TOPIC_SUBSCRIPTIONS,
        selfPrincipalId: 'a',
        selfSessionId: 'a',
        clock: { nowMs: Date.now }
    });
}
