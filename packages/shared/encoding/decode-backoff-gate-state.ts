import { decodePlainRecord, hasExactKeys } from '../api/exact-object-decoding.ts';
import type { BackoffGateState } from '../resilience/backoff-gate.ts';
import { Either } from '../resilience/Either.ts';
import { getOwnCount, getOwnNullableCount } from './get-own-field.ts';

const GATE_KEYS = [
    'lastPassAtEpochMs',
    'consecutiveHeldPasses',
    'heldAtEpochMs'
] as const satisfies readonly (keyof BackoffGateState)[];

/** A stored gate: an exact object whose instants are null or non-negative integers, held only after a first pass. */
export function decodeBackoffGateState(value: unknown): Either<string, BackoffGateState> {
    const fields = decodePlainRecord(value).right;
    if (fields === undefined || !hasExactKeys(fields, GATE_KEYS)) {
        return Either.ofLeft('Backoff gate state must be an exact object with its own fields');
    }
    const lastPassAtEpochMs = getOwnNullableCount(fields, 'lastPassAtEpochMs');
    const consecutiveHeldPasses = getOwnCount(fields, 'consecutiveHeldPasses');
    const heldAtEpochMs = getOwnNullableCount(fields, 'heldAtEpochMs');
    if (lastPassAtEpochMs === undefined || consecutiveHeldPasses === null || heldAtEpochMs === undefined) {
        return Either.ofLeft('Backoff gate state fields must be non-negative integers, the instants or null');
    }
    if (lastPassAtEpochMs === null && heldAtEpochMs !== null) {
        return Either.ofLeft('Backoff gate state heldAtEpochMs must be null before the first pass');
    }
    return Either.ofRight({ lastPassAtEpochMs, consecutiveHeldPasses, heldAtEpochMs });
}
