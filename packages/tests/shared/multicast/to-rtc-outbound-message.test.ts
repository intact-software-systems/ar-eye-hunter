import { describe, expect, it } from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { normalizeALQosPolicy } from '@shared/al-contracts/normalize-al-qos-policy.ts';
import { toALOutboundMessage } from '@shared/alm/outbound/to-al-outbound-message.ts';
import { toRtcOutboundMessage } from '@shared/multicast/to-rtc-outbound-message.ts';

import { ORIGIN_ROOM } from './rtc-origin-overlay-fixture.ts';

const MESSAGE = newALMulticastMessage(
    'a',
    { topicId: 'room.granted-feed', resourceId: 'feed-1', contextId: ORIGIN_ROOM.groupId },
    ORIGIN_ROOM,
    'room.granted-feed.v1',
    {},
    { ack: 'none', reliability: 'best-effort', ttlMs: 30_000 }
);

describe('toRtcOutboundMessage', () => {
    it('returns a message carrying a publication proof unchanged: its origin normalized it before signing', () => {
        const proven: ALMessage = { ...MESSAGE, proof: { alg: 'ES256', keyId: 'k'.repeat(43), signature: 's'.repeat(86) } };

        expect(toRtcOutboundMessage(proven, normalizeALQosPolicy(MESSAGE).effective)).toBe(proven);
    });

    it('normalizes any other message as every carrier does', () => {
        const effective = normalizeALQosPolicy(MESSAGE).effective;

        expect(toRtcOutboundMessage(MESSAGE, effective)).toEqual(toALOutboundMessage(MESSAGE, effective));
        expect(toRtcOutboundMessage(MESSAGE, effective).qos?.expiry).toBeDefined();
    });
});
