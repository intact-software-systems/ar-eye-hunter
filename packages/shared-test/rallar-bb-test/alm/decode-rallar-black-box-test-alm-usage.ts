import type { ALVolatileSessionReport } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { RallarBlackBoxTestAlmUsage } from '../rallar-black-box-test-contracts.ts';
import { decodeRecord } from '../runtime/decode-runtime-result-values.ts';
import { decodeALOutboundPublicationStageReport } from './decode-al-outbound-publication-stage-report.ts';
import { decodeALVolatileSessionReport, decodeCount } from './decode-al-volatile-session-report.ts';

/** A page's `stats.rallar.alm` block, read off page output or a recorded `stats` event; the left names every bad field. */
export function decodeRallarBlackBoxTestAlmUsage(
    value: unknown
): Either<readonly string[], RallarBlackBoxTestAlmUsage> {
    const record = decodeRecord(value);
    const counts = {
        orderingTracks: decodeCount(record.orderingTracks),
        deliveredMarkers: decodeCount(record.deliveredMarkers),
        repliesHeld: decodeCount(record.repliesHeld),
        replyWaitsOpen: decodeCount(record.replyWaitsOpen)
    };
    const countIssues = Object.entries(counts)
        .filter(([, count]) => count === undefined)
        .map(([name]) => `${name} is not a count`);
    const report = decodeALVolatileSessionReport(value);
    const publication = decodeALOutboundPublicationStageReport(record.publication);
    if (report.right === undefined || publication.right === undefined || !hasEveryCount(counts)) {
        return Either.ofLeft([...(report.left ?? []), ...countIssues, ...(publication.left ?? [])]);
    }
    return Either.ofRight({ ...report.right, ...counts, publication: publication.right });
}

function hasEveryCount(
    counts: Readonly<
        Record<
            keyof Omit<RallarBlackBoxTestAlmUsage, keyof ALVolatileSessionReport | 'publication'>,
            number | undefined
        >
    >
): counts is Readonly<Record<keyof typeof counts, number>> {
    return Object.values(counts).every((count) => count !== undefined);
}
