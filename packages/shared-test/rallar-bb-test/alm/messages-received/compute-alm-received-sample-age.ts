import { AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS } from '@shared/alm/outbound/publication/al-outbound-publication-figures.ts';
import { assertBoundedHistogram } from '@shared/measurement/assert-bounded-histogram.ts';
import { computeBoundedHistogramRecorded } from '@shared/measurement/bounded-histogram.ts';

import { isJsonRecordValue } from '../../schema/json-schema-validation.ts';
import type { AlmReceivedSampleAge } from '../rallar-black-box-alm-result-values.ts';

import type { AlmMatchingArrival } from './observe-alm-matching-messages.ts';

/**
 * A copy whose payload holds no number at `from` has no age, and one stamped after it arrived a negative one: the
 * histogram refuses both, so each is counted as unrecorded instead of being clamped into a bucket.
 */
export function computeAlmReceivedSampleAge(
    arrivals: readonly AlmMatchingArrival[],
    from: string
): AlmReceivedSampleAge {
    const recorded = computeBoundedHistogramRecorded(
        assertBoundedHistogram(AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS, 'AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS'),
        arrivals.map(({ atEpochMs, copy }) => {
            const sentAtEpochMs = isJsonRecordValue(copy.payload) ? copy.payload[from] : undefined;
            return typeof sentAtEpochMs === 'number' ? atEpochMs - sentAtEpochMs : Number.NaN;
        })
    );
    return { from, ageMs: recorded.histogram, unrecordedSamples: recorded.unrecordedSamples };
}
