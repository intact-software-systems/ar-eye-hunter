import { Either } from '@shared/resilience/Either.ts';

import type { RallarBlackBoxTestAlmUsage } from '../rallar-black-box-test-contracts.ts';
import { decodeRecord } from '../runtime/decode-runtime-result-values.ts';
import { decodeALVolatileSessionReport, decodeCount } from './decode-al-volatile-session-report.ts';

/** A page's `stats.rallar.alm` block, read off page output or a recorded `stats` event; the left names every bad field. */
export function decodeRallarBlackBoxTestAlmUsage(
    value: unknown
): Either<readonly string[], RallarBlackBoxTestAlmUsage> {
    const record = decodeRecord(value);
    const orderingTracks = decodeCount(record.orderingTracks);
    const deliveredMarkers = decodeCount(record.deliveredMarkers);
    const countIssues = [
        ...(orderingTracks === undefined ? ['orderingTracks is not a count'] : []),
        ...(deliveredMarkers === undefined ? ['deliveredMarkers is not a count'] : [])
    ];
    return decodeALVolatileSessionReport(value).fold(
        (issues) => Either.ofLeft<readonly string[], RallarBlackBoxTestAlmUsage>([...issues, ...countIssues]),
        (report) =>
            orderingTracks === undefined || deliveredMarkers === undefined
                ? Either.ofLeft(countIssues)
                : Either.ofRight({ ...report, orderingTracks, deliveredMarkers })
    );
}
