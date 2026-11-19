import { decodePlainRecord, hasExactKeys } from '@shared/api/exact-object-decoding.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { decodeTopologyReshapeGateState } from '@shared/api/topology-plan/decode-topology-reshape-gate-state.ts';
import type { TopologyReshapeGateState } from '@shared/api/topology-plan/topology-reshape-gate.ts';
import { getOwnField } from '@shared/encoding/get-own-field.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import {
    computeRuntimeStateConditionalWrite,
    type RuntimeStateConditionalWrite
} from '../../../runtime-state/compute-runtime-state-conditional-write.ts';
import { groupStateGroupStorageKey } from '../../group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { decodeJsonWireValue, type JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from './rtc-topology-errors.ts';

export const RTC_TOPOLOGY_RESHAPE_GATES_NAMESPACE = 'rtc-topology:reshape-gates';

export interface StoredTopologyReshapeGate {
    readonly state: TopologyReshapeGateState;
    readonly revision: number;
}

interface StoredTopologyReshapeGateValue {
    readonly groupRef: GroupRef;
    readonly state: TopologyReshapeGateState;
}

const STORED_VALUE_KEYS = ['groupRef', 'state'] as const satisfies readonly (keyof StoredTopologyReshapeGateValue)[];
const GROUP_REF_KEYS = ['applicationId', 'workspaceId', 'groupId'] as const satisfies readonly (keyof GroupRef)[];

/** A null revision inserts where the room holds no gate; otherwise the row is replaced only at that revision. */
export function computeRtcTopologyReshapeGateWrite(
    groupRef: GroupRef,
    state: TopologyReshapeGateState,
    expectedRevision: number | null
): RuntimeStateConditionalWrite {
    const stored: StoredTopologyReshapeGateValue = {
        groupRef: {
            applicationId: groupRef.applicationId,
            workspaceId: groupRef.workspaceId,
            groupId: groupRef.groupId
        },
        state
    };
    const row = {
        namespace: RTC_TOPOLOGY_RESHAPE_GATES_NAMESPACE,
        key: groupStateGroupStorageKey(groupRef),
        value: JSON.stringify(stored),
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    };
    return computeRuntimeStateConditionalWrite(
        expectedRevision === null
            ? { ...row, operation: 'insert' }
            : { ...row, operation: 'update', expectedRevision }
    );
}

/** The row's own room must be the room its key names; anything else is corruption. */
export function decodeStoredTopologyReshapeGate(key: string, value: string): TopologyReshapeGateState {
    try {
        const stored = decodeJsonWireValue(JSON.parse(value), 'Stored RTC topology reshape gate');
        return decodeStoredTopologyReshapeGateValue(key, stored);
    }
    catch (error) {
        throw new RtcTopologyRepositoryInvariantCorruptionError(
            key,
            error instanceof Error ? error.message : 'Stored RTC topology reshape gate is invalid'
        );
    }
}

function decodeStoredTopologyReshapeGateValue(key: string, value: JsonWireValue): TopologyReshapeGateState {
    const fields = decodePlainRecord(value).right;
    if (fields === undefined || !hasExactKeys(fields, STORED_VALUE_KEYS)) {
        throw new TypeError('Stored RTC topology reshape gate fields are invalid');
    }
    const groupRef = decodeStoredGroupRef(getOwnField(fields, 'groupRef'));
    if (groupRef === null || groupStateGroupStorageKey(groupRef) !== key) {
        throw new TypeError('Stored RTC topology reshape gate group identity is inconsistent');
    }
    const state = decodeTopologyReshapeGateState(getOwnField(fields, 'state'));
    if (state.right === undefined) {
        throw new TypeError(state.left);
    }
    return state.right;
}

function decodeStoredGroupRef(value: JsonWireValue): GroupRef | null {
    const fields = decodePlainRecord(value).right;
    if (fields === undefined || !hasExactKeys(fields, GROUP_REF_KEYS)) {
        return null;
    }
    const [applicationId, workspaceId, groupId] = GROUP_REF_KEYS.map((field) => getOwnField(fields, field));
    return typeof applicationId === 'string' && typeof workspaceId === 'string' && typeof groupId === 'string'
        ? { applicationId, workspaceId, groupId }
        : null;
}
