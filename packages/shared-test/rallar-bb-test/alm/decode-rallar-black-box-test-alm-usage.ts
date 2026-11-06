import type { ALInboundOrderingCounters } from '@shared/alm/inbound/al-inbound-ordering-counters.ts';
import type { ALVolatileSessionReport } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { RallarBlackBoxTestAlmUsage } from '../rallar-black-box-test-contracts.ts';
import { decodeRecord } from '../runtime/decode-runtime-result-values.ts';
import { decodeALOutboundPublicationStageReport } from './decode-al-outbound-publication-stage-report.ts';
import { decodeALVolatileSessionReport, decodeCount, decodeCounts } from './decode-al-volatile-session-report.ts';

const ORDERING_FIELDS = [
    'entered',
    'omitted',
    'witnessed',
    'beforeEntry'
] as const satisfies readonly (keyof ALInboundOrderingCounters)[];

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
    const ordering = decodeCounts(record.ordering, ORDERING_FIELDS, 'ordering');
    if (
        report.right === undefined || publication.right === undefined || ordering.right === undefined ||
        !hasEveryCount(counts)
    ) {
        return Either.ofLeft([
            ...(report.left ?? []),
            ...countIssues,
            ...(publication.left ?? []),
            ...(ordering.left ?? [])
        ]);
    }
    const { entered, omitted, witnessed, beforeEntry } = ordering.right;
    return Either.ofRight({
        ...report.right,
        ...counts,
        publication: publication.right,
        ordering: { entered, omitted, witnessed, beforeEntry }
    });
}

function hasEveryCount(
    counts: Readonly<
        Record<
            keyof Omit<RallarBlackBoxTestAlmUsage, keyof ALVolatileSessionReport | 'publication' | 'ordering'>,
            number | undefined
        >
    >
): counts is Readonly<Record<keyof typeof counts, number>> {
    return Object.values(counts).every((count) => count !== undefined);
}
