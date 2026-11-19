import { isApiJsonObject } from '../api/api-json-value.ts';
import { Either } from '../resilience/Either.ts';
import type { TransportFaultObservation } from './transport-fault-port.ts';

type TransportFaultActedDecision = TransportFaultObservation['decision'];

/** How many frames one fault acted on, by decision. A frame the fault let pass is in none of them. */
export type TransportFaultActedCounts = Readonly<Record<TransportFaultActedDecision, number>>;

const NO_FRAME_ACTED_ON: TransportFaultActedCounts = {
    drop: 0,
    delay: 0,
    rewrite: 0,
    'not-ready': 0,
    backpressure: 0
};

const ACTED_DECISIONS: readonly TransportFaultActedDecision[] = [
    'drop',
    'delay',
    'rewrite',
    'not-ready',
    'backpressure'
];

export function toTransportFaultActedCounts(
    observations: readonly TransportFaultObservation[],
    faultId: string
): TransportFaultActedCounts {
    const counts = { ...NO_FRAME_ACTED_ON };
    for (const observation of observations) {
        if (observation.faultId === faultId) {
            counts[observation.decision] += 1;
        }
    }
    return counts;
}

export function decodeTransportFaultActedCounts(value: unknown): Either<string, TransportFaultActedCounts> {
    if (!isApiJsonObject(value)) {
        return Either.ofLeft('acted counts must be an object');
    }
    const counts = { ...NO_FRAME_ACTED_ON };
    for (const decision of ACTED_DECISIONS) {
        const count = value[decision];
        if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
            return Either.ofLeft(`acted counts need a whole number of ${decision} frames`);
        }
        counts[decision] = count;
    }
    return Either.ofRight(counts);
}
