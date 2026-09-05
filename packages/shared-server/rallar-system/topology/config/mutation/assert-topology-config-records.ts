import type {
    GroupTopologyConfigPatch,
    StoredGroupTopologyConfig,
    StoredGroupTopologyOverride
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { assertTopologyConfigReceipt } from './assert-topology-config-receipt.ts';
import type {
    GroupTopologyConfigGeneration,
    GroupTopologyConfigGenerationTarget,
    GroupTopologyConfigInvariantGeneration,
    GroupTopologyConfigMutationRecord
} from './group-topology-config-mutation-contracts.ts';
import {
    assertAcceptedTopologyConfig,
    assertTopologyConfigExactKeys,
    assertTopologyGroupRef,
    assertTopologyPositiveInteger,
    assertTopologyStorageRevision,
    requireTopologyString,
    sameTopologyGroupRef
} from './topology-config-mutation-validation-values.ts';

export function assertGroupTopologyConfigGeneration(
    candidate: GroupTopologyConfigGeneration,
    expectedRef: GroupRef,
    expectedTarget: GroupTopologyConfigGenerationTarget
): GroupTopologyConfigGeneration {
    const value = candidate;
    assertTopologyConfigExactKeys(
        value,
        ['groupRef', 'target', 'version'],
        'Topology config generation'
    );
    assertTopologyGroupRef(value.groupRef, 'Topology config generation groupRef');
    if (!sameTopologyGroupRef(value.groupRef, expectedRef)) {
        throw new TypeError('Topology config generation has the wrong groupRef');
    }
    if (value.target !== expectedTarget) {
        throw new TypeError('Topology config generation has the wrong target');
    }
    assertTopologyPositiveInteger(value.version, 'Topology config generation version');
    return value;
}

export function assertGroupTopologyConfigInvariantGeneration(
    candidate: GroupTopologyConfigInvariantGeneration,
    expectedRef: GroupRef
): GroupTopologyConfigInvariantGeneration {
    const value = candidate;
    assertTopologyConfigExactKeys(
        value,
        ['groupRef', 'version'],
        'Topology config invariant generation'
    );
    assertTopologyGroupRef(value.groupRef, 'Topology config invariant generation groupRef');
    if (!sameTopologyGroupRef(value.groupRef, expectedRef)) {
        throw new TypeError('Topology config invariant generation has the wrong groupRef');
    }
    assertTopologyPositiveInteger(value.version, 'Topology config invariant generation version');
    return value;
}

export function assertStoredGroupTopologyConfig(
    candidate: StoredGroupTopologyConfig,
    expectedRef: GroupRef
): StoredGroupTopologyConfig {
    const value = candidate;
    assertTopologyConfigExactKeys(value, storedTopologyConfigKeys, 'Stored topology config');
    assertTopologyGroupRef(value.groupRef, 'Stored topology config groupRef');
    if (!sameTopologyGroupRef(value.groupRef, expectedRef)) {
        throw new TypeError('Stored topology config has the wrong groupRef');
    }
    assertAcceptedTopologyConfig(value.config, 'Stored topology config config');
    assertTopologyPositiveInteger(value.version, 'Stored topology config version');
    assertTopologyStorageRevision(value.createdAtEpochMs, 'Stored topology config created time');
    assertTopologyStorageRevision(value.updatedAtEpochMs, 'Stored topology config updated time');
    if (Number(value.updatedAtEpochMs) < Number(value.createdAtEpochMs)) {
        throw new TypeError('Stored topology config updated before creation');
    }
    requireTopologyString(value.updatedByPrincipalId, 'Stored topology config principal');
    if (value.requestId !== null) {
        requireTopologyString(value.requestId, 'Stored topology config requestId');
    }
    return value;
}

export function assertStoredGroupTopologyOverride(
    candidate: StoredGroupTopologyOverride,
    expectedRef: GroupRef
): StoredGroupTopologyOverride {
    const value = candidate;
    const base = { ...value } as StoredGroupTopologyConfig & {
        expiresAtEpochMs?: number;
    };
    delete base.expiresAtEpochMs;
    assertStoredGroupTopologyConfig(base, expectedRef);
    assertTopologyConfigExactKeys(
        value,
        [...storedTopologyConfigKeys, 'expiresAtEpochMs'],
        'Stored topology override'
    );
    assertTopologyStorageRevision(value.expiresAtEpochMs, 'Stored topology override expiry');
    if (Number(value.expiresAtEpochMs) <= Number(value.updatedAtEpochMs)) {
        throw new TypeError('Stored topology override expiry must follow update');
    }
    return value;
}

export function assertGroupTopologyConfigMutationRecord(
    candidate: GroupTopologyConfigMutationRecord,
    expected: Readonly<{ groupRef: GroupRef; requestId: string; }>
): GroupTopologyConfigMutationRecord {
    const value = candidate;
    assertTopologyConfigExactKeys(
        value,
        ['groupRef', 'requestId', 'commandHash', 'receipt'],
        'Topology config mutation record'
    );
    assertTopologyGroupRef(value.groupRef, 'Topology config mutation record groupRef');
    if (!sameTopologyGroupRef(value.groupRef, expected.groupRef)) {
        throw new TypeError('Topology config mutation record has the wrong groupRef');
    }
    requireTopologyString(value.requestId, 'Topology config mutation requestId');
    if (value.requestId !== expected.requestId) {
        throw new TypeError('Topology config mutation record has the wrong requestId');
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(String(value.commandHash))) {
        throw new TypeError('Topology config mutation record hash is invalid');
    }
    const receipt = assertTopologyConfigReceipt(value.receipt, expected.groupRef);
    if (receipt.commandHash !== value.commandHash) {
        throw new TypeError('Topology config receipt hash differs from record');
    }
    if (receipt.commandId !== value.requestId) {
        throw new TypeError('Topology config receipt commandId differs from requestId');
    }
    if (receipt.requestId !== value.requestId) {
        throw new TypeError('Topology config receipt requestId differs from record');
    }
    return value;
}

export function normalizeGroupTopologyConfigPatch(
    patch: GroupTopologyConfigPatch
): GroupTopologyConfigPatch {
    return {
        ...(patch.topologyKind === undefined ? {} : { topologyKind: patch.topologyKind }),
        ...(patch.degreeLimit === undefined ? {} : { degreeLimit: patch.degreeLimit }),
        ...(patch.treeMinSize === undefined ? {} : { treeMinSize: patch.treeMinSize }),
        ...(patch.meshMinSize === undefined ? {} : { meshMinSize: patch.meshMinSize }),
        ...(patch.meshParamK === undefined ? {} : { meshParamK: patch.meshParamK })
    };
}

const storedTopologyConfigKeys = [
    'groupRef',
    'config',
    'version',
    'createdAtEpochMs',
    'updatedAtEpochMs',
    'updatedByPrincipalId',
    'requestId'
] as const;
