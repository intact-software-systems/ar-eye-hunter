import { decodeCanonicalSubset } from '../../encoding/decode-canonical-subset.ts';
import { getOwnCount, getOwnField } from '../../encoding/get-own-field.ts';
import { Either } from '../../resilience/Either.ts';
import type { ApiJsonValue } from '../api-json-value.ts';
import { decodePlainRecord, hasExactKeys } from '../exact-object-decoding.ts';
import { HELD_TOPOLOGY_RESHAPE_REASONS, type HeldTopologyReshape } from './topology-reshape-gate.ts';

const HELD_RESHAPE_KEYS = ['wantedReasons', 'opensAtEpochMs'] as const satisfies readonly (keyof HeldTopologyReshape)[];

export function decodeHeldTopologyReshape(value: ApiJsonValue): Either<string, HeldTopologyReshape> {
    const fields = decodePlainRecord(value).right;
    if (fields === undefined || !hasExactKeys(fields, HELD_RESHAPE_KEYS)) {
        return Either.ofLeft('Held reshape must be an exact object with wantedReasons and opensAtEpochMs');
    }
    const wantedReasons = decodeCanonicalSubset(
        getOwnField(fields, 'wantedReasons'),
        HELD_TOPOLOGY_RESHAPE_REASONS,
        'Held reshape wantedReasons'
    );
    if (wantedReasons.right === undefined) {
        return Either.ofLeft(wantedReasons.left ?? 'Held reshape wantedReasons is invalid');
    }
    if (wantedReasons.right.length === 0) {
        return Either.ofLeft('Held reshape wantedReasons must not be empty');
    }
    const opensAtEpochMs = getOwnCount(fields, 'opensAtEpochMs');
    if (opensAtEpochMs === null) {
        return Either.ofLeft('Held reshape opensAtEpochMs must be a non-negative safe integer');
    }
    return Either.ofRight({ wantedReasons: wantedReasons.right, opensAtEpochMs });
}
