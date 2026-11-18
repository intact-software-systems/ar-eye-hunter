import { getOwnCount, getOwnField } from '../../encoding/get-own-field.ts';
import type { BackoffGateState } from '../../resilience/backoff-gate.ts';
import { Either } from '../../resilience/Either.ts';
import type { ApiJsonValue } from '../api-json-value.ts';
import { decodePlainRecord, hasExactKeys } from '../exact-object-decoding.ts';
import {
    HELD_TOPOLOGY_RESHAPE_REASONS,
    type HeldTopologyReshapeReason,
    type TopologyReshapeGateState
} from './topology-reshape-gate.ts';

const STATE_KEYS = ['gate', 'wantedReasons'] as const satisfies readonly (keyof TopologyReshapeGateState)[];
const GATE_KEYS = [
    'lastPassAtEpochMs',
    'consecutiveHeldPasses',
    'heldAtEpochMs'
] as const satisfies readonly (keyof BackoffGateState)[];

export function decodeTopologyReshapeGateState(value: ApiJsonValue): Either<string, TopologyReshapeGateState> {
    const fields = decodePlainRecord(value).right;
    if (fields === undefined || !hasExactKeys(fields, STATE_KEYS)) {
        return Either.ofLeft('Topology reshape gate state must be an exact object with gate and wantedReasons');
    }
    const gate = decodeBackoffGateState(getOwnField(fields, 'gate'));
    const wantedReasons = decodeHeldTopologyReshapeReasons(getOwnField(fields, 'wantedReasons'));
    if (gate.right === undefined || wantedReasons.right === undefined) {
        return Either.ofLeft(gate.left ?? wantedReasons.left ?? 'Topology reshape gate state is invalid');
    }
    return Either.ofRight({ gate: gate.right, wantedReasons: wantedReasons.right });
}

function decodeBackoffGateState(value: ApiJsonValue): Either<string, BackoffGateState> {
    const fields = decodePlainRecord(value).right;
    if (fields === undefined || !hasExactKeys(fields, GATE_KEYS)) {
        return Either.ofLeft('Topology reshape gate must be an exact object with its own fields');
    }
    const lastPassAtEpochMs = getOwnNullableCount(fields, 'lastPassAtEpochMs');
    const consecutiveHeldPasses = getOwnCount(fields, 'consecutiveHeldPasses');
    const heldAtEpochMs = getOwnNullableCount(fields, 'heldAtEpochMs');
    if (lastPassAtEpochMs === undefined || consecutiveHeldPasses === null || heldAtEpochMs === undefined) {
        return Either.ofLeft('Topology reshape gate fields must be non-negative integers, the instants or null');
    }
    if (lastPassAtEpochMs === null && heldAtEpochMs !== null) {
        return Either.ofLeft('Topology reshape gate heldAtEpochMs must be null before the first pass');
    }
    return Either.ofRight({ lastPassAtEpochMs, consecutiveHeldPasses, heldAtEpochMs });
}

function decodeHeldTopologyReshapeReasons(value: ApiJsonValue): Either<string, readonly HeldTopologyReshapeReason[]> {
    if (!Array.isArray(value)) {
        return Either.ofLeft('Topology reshape gate wantedReasons must be an array');
    }
    const reasons = HELD_TOPOLOGY_RESHAPE_REASONS.filter((reason) => value.includes(reason));
    if (reasons.length !== value.length || reasons.some((reason, index) => reason !== value[index])) {
        return Either.ofLeft('Topology reshape gate wantedReasons must be known, unique and in canonical order');
    }
    return Either.ofRight(reasons);
}

/** Null for an own null field, the count for a non-negative safe integer, else undefined. */
function getOwnNullableCount(record: object, key: string): number | null | undefined {
    return getOwnField(record, key) === null ? null : getOwnCount(record, key) ?? undefined;
}
