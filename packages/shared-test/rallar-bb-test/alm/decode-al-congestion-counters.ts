import type { ALCongestionCounters } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { Either } from '@shared/resilience/Either.ts';

import { decodeNonNegativeInteger, decodeRecord } from '../runtime/decode-runtime-result-values.ts';

const COUNTER_NAMES = [
    'dropped',
    'deferred',
    'handedOver',
    'rateLimited',
    'circuitOpen',
    'queuedBytesHighWater'
] as const satisfies readonly (keyof ALCongestionCounters)[];

/** A page's congestion counters, read off page output or a recorded `stats` event; the left names every bad field. */
export function decodeALCongestionCounters(value: unknown): Either<readonly string[], ALCongestionCounters> {
    const record = decodeRecord(value);
    const issues = COUNTER_NAMES
        .filter((name) => decodeNonNegativeInteger(record[name]) === undefined)
        .map((name) => `${name} is not a count`);
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    return Either.ofRight({
        dropped: record.dropped as number,
        deferred: record.deferred as number,
        handedOver: record.handedOver as number,
        rateLimited: record.rateLimited as number,
        circuitOpen: record.circuitOpen as number,
        queuedBytesHighWater: record.queuedBytesHighWater as number
    });
}
