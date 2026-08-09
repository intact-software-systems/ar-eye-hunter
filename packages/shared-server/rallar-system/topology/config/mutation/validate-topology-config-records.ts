import type {
  GroupTopologyConfigPatch,
  StoredGroupTopologyConfig,
  StoredGroupTopologyOverride,
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type {
  GroupTopologyConfigGeneration,
  GroupTopologyConfigGenerationTarget,
  GroupTopologyConfigInvariantGeneration,
  GroupTopologyConfigMutationRecord,
} from './group-topology-config-mutation-contracts.ts';
import {
  requireTopologyString,
  sameTopologyGroupRef,
  validateAcceptedTopologyConfig,
  validateTopologyConfigExactKeys,
  validateTopologyGroupRef,
  validateTopologyPositiveInteger,
  validateTopologyStorageRevision,
} from './topology-config-mutation-validation-values.ts';
import { validateTopologyConfigReceipt } from './validate-topology-config-receipt.ts';

export function validateGroupTopologyConfigGeneration(
  candidate: GroupTopologyConfigGeneration,
  expectedRef: GroupRef,
  expectedTarget: GroupTopologyConfigGenerationTarget,
): GroupTopologyConfigGeneration {
  const value = candidate;
  validateTopologyConfigExactKeys(
    value,
    ['groupRef', 'target', 'version'],
    'Topology config generation',
  );
  validateTopologyGroupRef(value.groupRef, 'Topology config generation groupRef');
  if (!sameTopologyGroupRef(value.groupRef, expectedRef)) {
    throw new TypeError('Topology config generation has the wrong groupRef');
  }
  if (value.target !== expectedTarget) {
    throw new TypeError('Topology config generation has the wrong target');
  }
  validateTopologyPositiveInteger(value.version, 'Topology config generation version');
  return value;
}

export function validateGroupTopologyConfigInvariantGeneration(
  candidate: GroupTopologyConfigInvariantGeneration,
  expectedRef: GroupRef,
): GroupTopologyConfigInvariantGeneration {
  const value = candidate;
  validateTopologyConfigExactKeys(
    value,
    ['groupRef', 'version'],
    'Topology config invariant generation',
  );
  validateTopologyGroupRef(value.groupRef, 'Topology config invariant generation groupRef');
  if (!sameTopologyGroupRef(value.groupRef, expectedRef)) {
    throw new TypeError('Topology config invariant generation has the wrong groupRef');
  }
  validateTopologyPositiveInteger(value.version, 'Topology config invariant generation version');
  return value;
}

export function validateStoredGroupTopologyConfig(
  candidate: StoredGroupTopologyConfig,
  expectedRef: GroupRef,
): StoredGroupTopologyConfig {
  const value = candidate;
  validateTopologyConfigExactKeys(value, storedTopologyConfigKeys, 'Stored topology config');
  validateTopologyGroupRef(value.groupRef, 'Stored topology config groupRef');
  if (!sameTopologyGroupRef(value.groupRef, expectedRef)) {
    throw new TypeError('Stored topology config has the wrong groupRef');
  }
  validateAcceptedTopologyConfig(value.config, 'Stored topology config config');
  validateTopologyPositiveInteger(value.version, 'Stored topology config version');
  validateTopologyStorageRevision(value.createdAtEpochMs, 'Stored topology config created time');
  validateTopologyStorageRevision(value.updatedAtEpochMs, 'Stored topology config updated time');
  if (Number(value.updatedAtEpochMs) < Number(value.createdAtEpochMs)) {
    throw new TypeError('Stored topology config updated before creation');
  }
  requireTopologyString(value.updatedByPrincipalId, 'Stored topology config principal');
  if (value.requestId !== null) {
    requireTopologyString(value.requestId, 'Stored topology config requestId');
  }
  return value;
}

export function validateStoredGroupTopologyOverride(
  candidate: StoredGroupTopologyOverride,
  expectedRef: GroupRef,
): StoredGroupTopologyOverride {
  const value = candidate;
  const base = { ...value } as StoredGroupTopologyConfig & {
    expiresAtEpochMs?: number;
  };
  delete base.expiresAtEpochMs;
  validateStoredGroupTopologyConfig(base, expectedRef);
  validateTopologyConfigExactKeys(
    value,
    [...storedTopologyConfigKeys, 'expiresAtEpochMs'],
    'Stored topology override',
  );
  validateTopologyStorageRevision(value.expiresAtEpochMs, 'Stored topology override expiry');
  if (Number(value.expiresAtEpochMs) <= Number(value.updatedAtEpochMs)) {
    throw new TypeError('Stored topology override expiry must follow update');
  }
  return value;
}

export function validateGroupTopologyConfigMutationRecord(
  candidate: GroupTopologyConfigMutationRecord,
  expected: Readonly<{ groupRef: GroupRef; requestId: string }>,
): GroupTopologyConfigMutationRecord {
  const value = candidate;
  validateTopologyConfigExactKeys(
    value,
    ['groupRef', 'requestId', 'commandHash', 'receipt'],
    'Topology config mutation record',
  );
  validateTopologyGroupRef(value.groupRef, 'Topology config mutation record groupRef');
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
  const receipt = validateTopologyConfigReceipt(value.receipt, expected.groupRef);
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
  patch: GroupTopologyConfigPatch,
): GroupTopologyConfigPatch {
  return {
    ...(patch.topologyKind === undefined ? {} : { topologyKind: patch.topologyKind }),
    ...(patch.degreeLimit === undefined ? {} : { degreeLimit: patch.degreeLimit }),
    ...(patch.treeMinSize === undefined ? {} : { treeMinSize: patch.treeMinSize }),
    ...(patch.meshMinSize === undefined ? {} : { meshMinSize: patch.meshMinSize }),
    ...(patch.meshParamK === undefined ? {} : { meshParamK: patch.meshParamK }),
  };
}

const storedTopologyConfigKeys = [
  'groupRef',
  'config',
  'version',
  'createdAtEpochMs',
  'updatedAtEpochMs',
  'updatedByPrincipalId',
  'requestId',
] as const;
