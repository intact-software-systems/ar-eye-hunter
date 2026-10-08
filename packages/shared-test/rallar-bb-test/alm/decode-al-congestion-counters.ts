import type { ALCongestionCounters } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { Either } from '@shared/resilience/Either.ts';

import { decodeNonNegativeInteger, decodeRecord } from '../runtime/decode-runtime-result-values.ts';

/** A page's congestion counters, read off page output or a recorded `stats` event; the left names every bad field. */
export function decodeALCongestionCounters(value: unknown): Either<readonly string[], ALCongestionCounters> {
    const record = decodeRecord(value);
    const dropped = decodeNonNegativeInteger(record.dropped);
    const deferred = decodeNonNegativeInteger(record.deferred);
    const handedOver = decodeNonNegativeInteger(record.handedOver);
    if (dropped === undefined || deferred === undefined || handedOver === undefined) {
        return Either.ofLeft([
            ...(dropped === undefined ? ['dropped is not a count'] : []),
            ...(deferred === undefined ? ['deferred is not a count'] : []),
            ...(handedOver === undefined ? ['handedOver is not a count'] : [])
        ]);
    }
    return Either.ofRight({ dropped, deferred, handedOver });
}
