import { Either } from '@shared/resilience/Either.ts';

import type { RallarBlackBoxTestAlmUsage } from '../rallar-black-box-test-contracts.ts';
import { decodeRecord } from '../runtime/decode-runtime-result-values.ts';
import { decodeALVolatileSessionReport } from './decode-al-volatile-session-report.ts';

/** A page's `stats.rallar.alm` block, read off page output or a recorded `stats` event; the left names every bad field. */
export function decodeRallarBlackBoxTestAlmUsage(
    value: unknown
): Either<readonly string[], RallarBlackBoxTestAlmUsage> {
    const orderingTracks = decodeRecord(value).orderingTracks;
    const isTrackCount = typeof orderingTracks === 'number' && Number.isInteger(orderingTracks) && orderingTracks >= 0;
    return decodeALVolatileSessionReport(value).fold(
        (issues) =>
            Either.ofLeft<readonly string[], RallarBlackBoxTestAlmUsage>(
                isTrackCount ? issues : [...issues, 'orderingTracks is not a count']
            ),
        (report) =>
            isTrackCount
                ? Either.ofRight({ ...report, orderingTracks })
                : Either.ofLeft(['orderingTracks is not a count'])
    );
}
