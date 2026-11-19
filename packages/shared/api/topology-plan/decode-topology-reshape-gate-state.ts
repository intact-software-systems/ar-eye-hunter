import { decodeCanonicalSubset } from '../../encoding/decode-canonical-subset.ts';
import { getOwnField } from '../../encoding/get-own-field.ts';
import { decodeBackoffGateState } from '../../resilience/decode-backoff-gate-state.ts';
import { Either } from '../../resilience/Either.ts';
import type { ApiJsonValue } from '../api-json-value.ts';
import { decodePlainRecord, hasExactKeys } from '../exact-object-decoding.ts';
import { HELD_TOPOLOGY_RESHAPE_REASONS, type TopologyReshapeGateState } from './topology-reshape-gate.ts';

const STATE_KEYS = ['gate', 'wantedReasons'] as const satisfies readonly (keyof TopologyReshapeGateState)[];

export function decodeTopologyReshapeGateState(value: ApiJsonValue): Either<string, TopologyReshapeGateState> {
    const fields = decodePlainRecord(value).right;
    if (fields === undefined || !hasExactKeys(fields, STATE_KEYS)) {
        return Either.ofLeft('Topology reshape gate state must be an exact object with gate and wantedReasons');
    }
    const gate = decodeBackoffGateState(getOwnField(fields, 'gate'));
    const wantedReasons = decodeCanonicalSubset(
        getOwnField(fields, 'wantedReasons'),
        HELD_TOPOLOGY_RESHAPE_REASONS,
        'Topology reshape gate wantedReasons'
    );
    if (gate.right === undefined || wantedReasons.right === undefined) {
        return Either.ofLeft(gate.left ?? wantedReasons.left ?? 'Topology reshape gate state is invalid');
    }
    return Either.ofRight({ gate: gate.right, wantedReasons: wantedReasons.right });
}
