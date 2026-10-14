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
    const counts = {
        dropped: decodeNonNegativeInteger(record.dropped),
        deferred: decodeNonNegativeInteger(record.deferred),
        handedOver: decodeNonNegativeInteger(record.handedOver),
        rateLimited: decodeNonNegativeInteger(record.rateLimited),
        circuitOpen: decodeNonNegativeInteger(record.circuitOpen),
        queuedBytesHighWater: decodeNonNegativeInteger(record.queuedBytesHighWater)
    } satisfies Record<(typeof COUNTER_NAMES)[number], number | undefined>;
    const { dropped, deferred, handedOver, rateLimited, circuitOpen, queuedBytesHighWater } = counts;
    if (
        dropped === undefined || deferred === undefined || handedOver === undefined ||
        rateLimited === undefined || circuitOpen === undefined || queuedBytesHighWater === undefined
    ) {
        return Either.ofLeft(
            COUNTER_NAMES.filter((name) => counts[name] === undefined).map((name) => `${name} is not a count`)
        );
    }
    return Either.ofRight({ dropped, deferred, handedOver, rateLimited, circuitOpen, queuedBytesHighWater });
}
