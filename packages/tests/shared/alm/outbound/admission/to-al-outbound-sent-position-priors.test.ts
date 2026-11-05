import { describe, expect, it } from 'vitest';

import { toALOutboundSentPositionPriors } from '@shared/alm/outbound/admission/to-al-outbound-sent-position-priors.ts';

describe('the priors one recording admission reads', () => {
    it('reads each recipient at its own position, 0 for one never sent the track', () => {
        expect(toALOutboundSentPositionPriors({
            recipientPeerIds: ['b', 'c'],
            positions: [{ seq: 4 }, undefined],
            roomPosition: undefined
        })).toEqual({ b: 4, c: 0 });
    });

    it('reads a recipient behind the room-wide sent position at it, and keeps one ahead of it', () => {
        expect(toALOutboundSentPositionPriors({
            recipientPeerIds: ['b', 'c', 'd'],
            positions: [{ seq: 1 }, undefined, { seq: 5 }],
            roomPosition: { seq: 3 }
        })).toEqual({ b: 3, c: 3, d: 5 });
    });
});
