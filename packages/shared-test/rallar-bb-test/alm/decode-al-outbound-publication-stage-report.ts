import type { ALPublicationStageLimits } from '@shared/al-contracts/publication/al-publication-stage-limits.ts';
import type { ALOutboundPublicationCounters } from '@shared/alm/outbound/publication/al-outbound-publication-ledger.ts';
import type { ALOutboundPublicationStageReport } from '@shared/alm/outbound/publication/al-outbound-publication-stage.ts';
import { Either } from '@shared/resilience/Either.ts';

import { decodeRecord } from '../runtime/decode-runtime-result-values.ts';
import { decodeCounts } from './decode-al-volatile-session-report.ts';

const HOLDING_FIELDS = [
    'lanes',
    'streams',
    'staged',
    'stagedBytes'
] as const satisfies readonly (keyof ALOutboundPublicationStageReport)[];
const LIMIT_FIELDS = [
    'maxStreams',
    'maxStagedValues',
    'maxStagedBytes'
] as const satisfies readonly (keyof ALPublicationStageLimits)[];
const COUNTER_FIELDS = [
    'staged',
    'superseded',
    'expired',
    'refused',
    'cancelled',
    'admitted',
    'deferred'
] as const satisfies readonly (keyof ALOutboundPublicationCounters)[];

/** A page's `stats.rallar.alm.publication` block (D480); the left names every bad field under `publication.`. */
export function decodeALOutboundPublicationStageReport(
    value: unknown
): Either<readonly string[], ALOutboundPublicationStageReport> {
    const record = decodeRecord(value);
    const holdings = decodeCounts(value, HOLDING_FIELDS, 'publication');
    const limits = decodeCounts(record.limits, LIMIT_FIELDS, 'publication.limits');
    const counters = decodeCounts(record.counters, COUNTER_FIELDS, 'publication.counters');
    if (holdings.right === undefined || limits.right === undefined || counters.right === undefined) {
        return Either.ofLeft([...(holdings.left ?? []), ...(limits.left ?? []), ...(counters.left ?? [])]);
    }
    const { lanes, streams, staged, stagedBytes } = holdings.right;
    const { maxStreams, maxStagedValues, maxStagedBytes } = limits.right;
    return Either.ofRight({
        lanes,
        streams,
        staged,
        stagedBytes,
        limits: { maxStreams, maxStagedValues, maxStagedBytes },
        counters: toCounters(counters.right)
    });
}

function toCounters(
    counters: Readonly<Record<keyof ALOutboundPublicationCounters, number>>
): ALOutboundPublicationCounters {
    const { staged, superseded, expired, refused, cancelled, admitted, deferred } = counters;
    return { staged, superseded, expired, refused, cancelled, admitted, deferred };
}
