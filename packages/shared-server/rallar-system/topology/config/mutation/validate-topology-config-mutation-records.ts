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
  isTopologyConfigRecord,
  requireTopologyString,
  sameTopologyGroupRef,
  validateAcceptedTopologyConfig,
  validateTopologyConfigExactKeys,
  validateTopologyGroupRef,
  validateTopologyPositiveInteger,
  validateTopologyStorageRevision,
} from './topology-config-mutation-validation-primitives.ts';
import { validateTopologyConfigReceipt } from './validate-topology-config-receipt.ts';

export function validateGroupTopologyConfigGeneration(
  value: unknown,
  expectedRef: GroupRef,
  expectedTarget: GroupTopologyConfigGenerationTarget,
): asserts value is GroupTopologyConfigGeneration {
  if (!isTopologyConfigRecord(value)) {
    throw new TypeError('Topology config generation is invalid');
  }
  validateTopologyConfigExactKeys(
    value,
    ['groupRef', 'target', 'version'],
    'Topology config generation',
  );
  validateTopologyGroupRef(value.groupRef, 'Topology config generation groupRef');
  if (!sameTopologyGroupRef(value.groupRef as GroupRef, expectedRef)) {
    throw new TypeError('Topology config generation has the wrong groupRef');
  }
  if (value.target !== expectedTarget) {
    throw new TypeError('Topology config generation has the wrong target');
  }
  validateTopologyPositiveInteger(value.version, 'Topology config generation version');
}

export function validateGroupTopologyConfigInvariantGeneration(
  value: unknown,
  expectedRef: GroupRef,
): asserts value is GroupTopologyConfigInvariantGeneration {
  if (!isTopologyConfigRecord(value)) {
    throw new TypeError('Topology config invariant generation is invalid');
  }
  validateTopologyConfigExactKeys(
    value,
    ['groupRef', 'version'],
    'Topology config invariant generation',
  );
  validateTopologyGroupRef(value.groupRef, 'Topology config invariant generation groupRef');
  if (!sameTopologyGroupRef(value.groupRef as GroupRef, expectedRef)) {
    throw new TypeError('Topology config invariant generation has the wrong groupRef');
  }
  validateTopologyPositiveInteger(value.version, 'Topology config invariant generation version');
}

export function validateStoredGroupTopologyConfig(
  value: unknown,
  expectedRef: GroupRef,
): asserts value is StoredGroupTopologyConfig {
  if (!isTopologyConfigRecord(value)) throw new TypeError('Stored topology config is invalid');
  validateTopologyConfigExactKeys(value, storedTopologyConfigKeys, 'Stored topology config');
  validateTopologyGroupRef(value.groupRef, 'Stored topology config groupRef');
  if (!sameTopologyGroupRef(value.groupRef as GroupRef, expectedRef)) {
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
}

export function validateStoredGroupTopologyOverride(
  value: unknown,
  expectedRef: GroupRef,
): asserts value is StoredGroupTopologyOverride {
  if (!isTopologyConfigRecord(value)) throw new TypeError('Stored topology override is invalid');
  const base = { ...value };
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
}

export function validateGroupTopologyConfigMutationRecord(
  value: unknown,
  expected: Readonly<{ groupRef: GroupRef; requestId: string }>,
): asserts value is GroupTopologyConfigMutationRecord {
  if (!isTopologyConfigRecord(value)) {
    throw new TypeError('Topology config mutation record is invalid');
  }
  validateTopologyConfigExactKeys(
    value,
    ['groupRef', 'requestId', 'commandHash', 'receipt'],
    'Topology config mutation record',
  );
  validateTopologyGroupRef(value.groupRef, 'Topology config mutation record groupRef');
  if (!sameTopologyGroupRef(value.groupRef as GroupRef, expected.groupRef)) {
    throw new TypeError('Topology config mutation record has the wrong groupRef');
  }
  requireTopologyString(value.requestId, 'Topology config mutation requestId');
  if (value.requestId !== expected.requestId) {
    throw new TypeError('Topology config mutation record has the wrong requestId');
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(String(value.commandHash))) {
    throw new TypeError('Topology config mutation record hash is invalid');
  }
  validateTopologyConfigReceipt(value.receipt, expected.groupRef);
  if (value.receipt.commandHash !== value.commandHash) {
    throw new TypeError('Topology config receipt hash differs from record');
  }
  if (value.receipt.commandId !== value.requestId) {
    throw new TypeError('Topology config receipt commandId differs from requestId');
  }
  if (value.receipt.requestId !== value.requestId) {
    throw new TypeError('Topology config receipt requestId differs from record');
  }
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
