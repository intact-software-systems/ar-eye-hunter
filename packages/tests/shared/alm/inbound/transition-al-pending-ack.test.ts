import { describe, expect, it } from 'vitest';

import { trackALPendingAckSnapshot } from '@shared/alm/inbound/transition-al-pending-ack.ts';

describe('inbound pending ACK transition', () => {
    // A relay that once planned local delivery stays a logical recipient: a later track that planned
    // none must not drop its own ACK, or the origin's `receiver` receipt never completes.
    it('keeps the relay a logical recipient once it was one', () => {
        const transition = trackALPendingAckSnapshot({
            msgId: 'message',
            current: {
                toPeerId: 'origin',
                status: 'subtree-complete',
                localReady: true,
                localRecipient: true,
                expectedFromPeerIds: ['child'],
                ackedFromPeerIds: [],
                carrier: 'rtc'
            },
            acks: [],
            toPeerId: 'origin',
            expectedFromPeerIds: ['child'],
            localReady: true,
            localRecipient: false,
            expireAtTimestamp: undefined,
            carrier: 'rtc'
        });

        expect(transition.pending?.localRecipient).toBe(true);
    });
});
