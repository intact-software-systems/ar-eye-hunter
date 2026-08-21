// Genuine untrusted-entry boundary for persisted topology mutation data.
import type {
    GroupTopologyConfigMutationReceipt,
    StoredGroupTopologyConfig,
    StoredGroupTopologyOverride
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type {
    GroupTopologyConfigGeneration,
    GroupTopologyConfigGenerationTarget,
    GroupTopologyConfigInvariantGeneration,
    GroupTopologyConfigMutationRecord
} from './group-topology-config-mutation-contracts.ts';
import { validateTopologyConfigReceipt } from './validate-topology-config-receipt.ts';
import {
    validateGroupTopologyConfigGeneration,
    validateGroupTopologyConfigInvariantGeneration,
    validateGroupTopologyConfigMutationRecord,
    validateStoredGroupTopologyConfig,
    validateStoredGroupTopologyOverride
} from './validate-topology-config-records.ts';

export function readTopologyConfigGenerationBoundary(
    value: unknown,
    expectedRef: GroupRef,
    expectedTarget: GroupTopologyConfigGenerationTarget
): GroupTopologyConfigGeneration {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Topology config generation is invalid');
    }
    return validateGroupTopologyConfigGeneration(
        value as GroupTopologyConfigGeneration,
        expectedRef,
        expectedTarget
    );
}

export function readTopologyConfigInvariantGenerationBoundary(
    value: unknown,
    expectedRef: GroupRef
): GroupTopologyConfigInvariantGeneration {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Topology config invariant generation is invalid');
    }
    return validateGroupTopologyConfigInvariantGeneration(
        value as GroupTopologyConfigInvariantGeneration,
        expectedRef
    );
}

export function readStoredTopologyConfigBoundary(
    value: unknown,
    expectedRef: GroupRef
): StoredGroupTopologyConfig {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Stored topology config is invalid');
    }
    return validateStoredGroupTopologyConfig(value as StoredGroupTopologyConfig, expectedRef);
}

export function readStoredTopologyOverrideBoundary(
    value: unknown,
    expectedRef: GroupRef
): StoredGroupTopologyOverride {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Stored topology override is invalid');
    }
    return validateStoredGroupTopologyOverride(value as StoredGroupTopologyOverride, expectedRef);
}

export function readTopologyConfigMutationRecordBoundary(
    value: unknown,
    expected: Readonly<{ groupRef: GroupRef; requestId: string; }>
): GroupTopologyConfigMutationRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Topology config mutation record is invalid');
    }
    return validateGroupTopologyConfigMutationRecord(
        value as GroupTopologyConfigMutationRecord,
        expected
    );
}

export function readTopologyConfigReceiptBoundary(
    value: unknown,
    expectedRef: GroupRef
): GroupTopologyConfigMutationReceipt {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Topology config receipt is invalid');
    }
    return validateTopologyConfigReceipt(value as GroupTopologyConfigMutationReceipt, expectedRef);
}
