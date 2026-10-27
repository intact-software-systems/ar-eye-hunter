import type { ALVolatileSessionReport } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { RallarBlackBoxTestAlmUsage } from '../rallar-black-box-test-contracts.ts';
import { decodeRecord } from '../runtime/decode-runtime-result-values.ts';
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
    return decodeALVolatileSessionReport(value).fold(
        (issues) => Either.ofLeft<readonly string[], RallarBlackBoxTestAlmUsage>([...issues, ...countIssues]),
        (report) =>
            hasEveryCount(counts)
                ? Either.ofRight({ ...report, ...counts })
                : Either.ofLeft(countIssues)
    );
}

function hasEveryCount(
    counts: Readonly<Record<keyof Omit<RallarBlackBoxTestAlmUsage, keyof ALVolatileSessionReport>, number | undefined>>
): counts is Readonly<Record<keyof typeof counts, number>> {
    return Object.values(counts).every((count) => count !== undefined);
}
