import { describe, expect, it } from 'vitest';

import { computeALOrderingPriorSeqRecord } from '@shared/alm/outbound/admission/compute-al-ordering-prior-seq-record.ts';

const TRACK_KEY = 'room-1:session-a:1';

describe('the prior-sequence record an authority signs on an ordered copy', () => {
    it('lists a recipient last sent a sequence below the previous one: its omission', () => {
        expect(computeALOrderingPriorSeqRecord({ trackKey: TRACK_KEY, seq: 5, priorSeqByRecipient: { b: 2 } })).toEqual({ b: 2 });
    });

    it('omits a recipient last sent the previous sequence: it reads the record as seq - 1', () => {
        expect(computeALOrderingPriorSeqRecord({ trackKey: TRACK_KEY, seq: 5, priorSeqByRecipient: { b: 4 } })).toEqual({});
    });

    it('lists a recipient never sent the track as 0, even on its first sequence', () => {
        expect(computeALOrderingPriorSeqRecord({ trackKey: TRACK_KEY, seq: 1, priorSeqByRecipient: { b: 0, c: 0 } }))
            .toEqual({ b: 0, c: 0 });
        expect(computeALOrderingPriorSeqRecord({ trackKey: TRACK_KEY, seq: 5, priorSeqByRecipient: { b: 0 } })).toEqual({ b: 0 });
    });

    it('omits a recipient already at or past the sequence: a receipt retry is not an exclusion', () => {
        expect(computeALOrderingPriorSeqRecord({ trackKey: TRACK_KEY, seq: 5, priorSeqByRecipient: { b: 5, c: 9 } })).toEqual({});
    });

    it('records nobody for an empty audience', () => {
        expect(computeALOrderingPriorSeqRecord({ trackKey: TRACK_KEY, seq: 5, priorSeqByRecipient: {} })).toEqual({});
    });
});
