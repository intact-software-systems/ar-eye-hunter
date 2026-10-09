import { Either } from '@shared/resilience/Either.ts';

import type { RallarBlackBoxTestAlmUsage } from '../rallar-black-box-test-contracts.ts';
import { decodeRecord } from '../runtime/decode-runtime-result-values.ts';
import { decodeALVolatileSessionReport, decodeCount } from './decode-al-volatile-session-report.ts';

/** A page's `stats.rallar.alm` block, read off page output or a recorded `stats` event; the left names every bad field. */
export function decodeRallarBlackBoxTestAlmUsage(
    value: unknown
): Either<readonly string[], RallarBlackBoxTestAlmUsage> {
    const orderingTracks = decodeCount(decodeRecord(value).orderingTracks);
    return decodeALVolatileSessionReport(value).fold(
        (issues) =>
            Either.ofLeft<readonly string[], RallarBlackBoxTestAlmUsage>(
                orderingTracks === undefined ? [...issues, 'orderingTracks is not a count'] : issues
            ),
        (report) =>
            orderingTracks === undefined
                ? Either.ofLeft(['orderingTracks is not a count'])
                : Either.ofRight({ ...report, orderingTracks })
    );
}
