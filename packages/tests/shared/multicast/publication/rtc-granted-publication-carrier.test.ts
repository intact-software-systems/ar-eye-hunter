import { describe, expect, it } from 'vitest';

import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { normalizeALQosPolicy } from '@shared/al-contracts/normalize-al-qos-policy.ts';
import { toALOutboundMessage } from '@shared/alm/outbound/to-al-outbound-message.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { RTC_GRANTED_PUBLICATION_REFUSALS } from '@shared/multicast/publication/compute-rtc-granted-publication-refusal.ts';
import { RtcGrantedPublicationCarrier } from '@shared/multicast/publication/rtc-granted-publication-carrier.ts';

import { UNAVAILABLE_PUBLICATION_CRYPTO } from '../../signature/publication-crypto-fixtures.ts';
import { createRtcGrantedTopicsFixture } from '../rtc-granted-topic-reader-fixtures.ts';
import { createFrozenGrantedMulticast, PUBLICATION_TOPIC_ID } from '../rtc-publication-proof-fixtures.ts';
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
    it('refuses a granted leg for the shape its sender gave before it asks for the admitted message', async () => {
        const unicast = newALUnicastMessage('a', GRANTED.route, 'b', GRANTED.payload.typeId, {});

        const signed = await createKeylessCarrier().signLeg(unicast, () => {
            throw new Error('A shape refusal admits nothing.');
        });

        expect(signed.left).toBe(RTC_GRANTED_PUBLICATION_REFUSALS.notMulticast);
    });

    it('names a signing failure by its kind first', async () => {
        const signed = await createKeylessCarrier().signLeg(GRANTED, (msg) => msg);

        expect(signed.left).toMatch(/^signing-unavailable: /);
    });

    it('forwards a granted frame as it is, and normalizes any other frame as every carrier does', () => {
        const carrier = createKeylessCarrier();
        const granted = { ...GRANTED, proof: PROOF };
        const effective = normalizeALQosPolicy(MEMBERS).effective;

        expect(carrier.toForwardedMessage(granted, effective)).toBe(granted);
        expect(carrier.toForwardedMessage(MEMBERS, effective)).toEqual(toALOutboundMessage(MEMBERS, effective));
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
