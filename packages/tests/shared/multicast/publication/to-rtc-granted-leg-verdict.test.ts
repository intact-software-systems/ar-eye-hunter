import { describe, expect, it } from 'vitest';

import type { RtcCarrierGapAdmission } from '@shared/multicast/compute-rtc-outbound-carrier-availability.ts';
import { toRtcGrantedLegVerdict } from '@shared/multicast/publication/to-rtc-granted-leg-verdict.ts';

describe('toRtcGrantedLegVerdict', () => {
    it.each<[RtcCarrierGapAdmission, ReturnType<typeof toRtcGrantedLegVerdict>]>([
        ['hold', { kind: 'refused', reason: 'unauthorized', detail: 'addressee' }],
        ['hand-over', { kind: 'unroutable', reason: 'no-route', detail: 'addressee' }]
    ])('answers the origin\'s unauthorized judgement of the addressee on a %s leg', (carrierGap, verdict) => {
        expect(toRtcGrantedLegVerdict({ reason: 'unauthorized', detail: 'addressee' }, carrierGap)).toEqual(verdict);
    });

    it.each<RtcCarrierGapAdmission>(['hold', 'hand-over'])('answers an unsupported leg refused unsupported on a %s leg', (carrierGap) => {
        expect(toRtcGrantedLegVerdict({ reason: 'unsupported', detail: 'shape' }, carrierGap))
            .toEqual({ kind: 'refused', reason: 'unsupported', detail: 'shape' });
    });
});
