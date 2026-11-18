import {
    AL_CONGESTION_EPISODE_BOUNDS_MS,
    type ALOutboundCongestionEpisodes
} from '@shared/alm/outbound/congestion/al-outbound-congestion-episodes.ts';
import { decodeBoundedHistogramOnBounds } from '@shared/measurement/bounded-histogram.ts';
import { Either } from '@shared/resilience/Either.ts';

import { decodeRecord } from '../runtime/decode-runtime-result-values.ts';
import { decodeCounts } from './decode-al-volatile-session-report.ts';

const COUNT_FIELDS = [
    'openEpisodes',
    'unrecordedSamples'
] as const satisfies readonly (keyof ALOutboundCongestionEpisodes.Figures)[];

/** A page's `stats.rallar.alm.congestionEpisodes` block; the left names every bad field under `congestionEpisodes.`. */
export function decodeALOutboundCongestionEpisodes(
    value: unknown
): Either<readonly string[], ALOutboundCongestionEpisodes.Figures> {
    const record = decodeRecord(value);
    const durationMs = decodeBoundedHistogramOnBounds(
        record.durationMs,
        'congestionEpisodes.durationMs',
        AL_CONGESTION_EPISODE_BOUNDS_MS
    );
    const counts = decodeCounts(value, COUNT_FIELDS, 'congestionEpisodes');
    if (durationMs.right === undefined || counts.right === undefined) {
        return Either.ofLeft([...(durationMs.left ?? []), ...(counts.left ?? [])]);
    }
    const { openEpisodes, unrecordedSamples } = counts.right;
    return Either.ofRight({ durationMs: durationMs.right, openEpisodes, unrecordedSamples });
}
