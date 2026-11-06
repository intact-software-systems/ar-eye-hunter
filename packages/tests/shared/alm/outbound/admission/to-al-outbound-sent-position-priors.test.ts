import { describe, expect, it } from 'vitest';

import { toALOutboundSentPositionPriors } from '@shared/alm/outbound/admission/to-al-outbound-sent-position-priors.ts';

const NO_SHARED_POSITIONS = [undefined, undefined, undefined];

describe('the priors one recording admission reads', () => {
    it('reads each recipient at its own position, 0 for one never sent the track', () => {
        expect(toALOutboundSentPositionPriors({
            recipientPeerIds: ['b', 'c'],
            positions: [{ seq: 4 }, undefined],
            sharedPositions: NO_SHARED_POSITIONS,
            roomPosition: undefined
        })).toEqual({ b: 4, c: 0 });
    });

    it('reads a recipient behind an unresolved room-wide sent position at it, and keeps one ahead of it', () => {
        expect(toALOutboundSentPositionPriors({
            recipientPeerIds: ['b', 'c', 'd'],
            positions: [{ seq: 1 }, undefined, { seq: 5 }],
            sharedPositions: NO_SHARED_POSITIONS,
            roomPosition: { seq: 3, resolvedSeq: 0 }
        })).toEqual({ b: 3, c: 3, d: 5 });
    });

    it('reads every recipient at least at a floor whose receipt resolved a lower sequence only', () => {
        expect(toALOutboundSentPositionPriors({
            recipientPeerIds: ['a', 'b', 'c'],
            positions: NO_SHARED_POSITIONS,
            sharedPositions: [{ seq: 2 }, { seq: 2 }, undefined],
            roomPosition: { seq: 3, resolvedSeq: 2 }
        })).toEqual({ a: 3, b: 3, c: 3 });
    });

    it('reads the recipients a resolved floor\'s receipt named at their shared rows, and the rest at their own', () => {
        expect(toALOutboundSentPositionPriors({
            recipientPeerIds: ['a', 'b', 'c'],
            positions: NO_SHARED_POSITIONS,
            sharedPositions: [{ seq: 3 }, { seq: 3 }, undefined],
            roomPosition: { seq: 3, resolvedSeq: 3 }
        })).toEqual({ a: 3, b: 3, c: 0 });
    });

    it('keeps an own row higher than the receipted sequence', () => {
        expect(toALOutboundSentPositionPriors({
            recipientPeerIds: ['a', 'b'],
            positions: [{ seq: 5 }, { seq: 1 }],
            sharedPositions: [{ seq: 3 }, { seq: 3 }],
            roomPosition: { seq: 3, resolvedSeq: 3 }
        })).toEqual({ a: 5, b: 3 });
    });
});
