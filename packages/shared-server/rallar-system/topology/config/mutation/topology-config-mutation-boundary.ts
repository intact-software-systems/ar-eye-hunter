// Genuine untrusted-entry boundary for persisted topology mutation data.
import type { EffectiveGroupTopologyConfig } from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import { validateEffectiveGroupTopologyConfig } from '../group-topology-config.ts';
export function readTopologyConfigGenerationBoundary(value: unknown) {
  if (!isTopologyConfigRecord(value)) {
    throw new TypeError('Topology config generation is invalid');
  }
  return value;
}

export function readTopologyConfigInvariantGenerationBoundary(value: unknown) {
  if (!isTopologyConfigRecord(value)) {
    throw new TypeError('Topology config invariant generation is invalid');
  }
  return value;
}

export function readStoredTopologyConfigBoundary(value: unknown) {
  if (!isTopologyConfigRecord(value)) {
    throw new TypeError('Stored topology config is invalid');
  }
  return value;
}

export function readStoredTopologyOverrideBoundary(value: unknown) {
  if (!isTopologyConfigRecord(value)) {
    throw new TypeError('Stored topology override is invalid');
  }
  return value;
}

export function readTopologyConfigMutationRecordBoundary(value: unknown) {
  if (!isTopologyConfigRecord(value)) {
    throw new TypeError('Topology config mutation record is invalid');
  }
  return value;
}

export function readTopologyConfigReceiptBoundary(value: unknown) {
  if (!isTopologyConfigRecord(value)) {
    throw new TypeError('Topology config receipt is invalid');
  }
  return value;
}

export function validateTopologyStorageRevision(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Object.is(value, -0)) {
    throw new TypeError(`${label} is invalid`);
  }
}

export function validateTopologyPositiveInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${label} is invalid`);
  }
}

export function validateTopologyGroupRef(value: unknown, label: string): void {
  if (!isTopologyConfigRecord(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  requireTopologyString(value.applicationId, `${label} applicationId`);
  if (value.workspaceId !== undefined) {
    requireTopologyString(value.workspaceId, `${label} workspaceId`);
  }
  requireTopologyString(value.groupId, `${label} groupId`);
}

export function sameTopologyGroupRef(left: GroupRef, right: GroupRef): boolean {
  return (
    left.applicationId === right.applicationId &&
    left.workspaceId === right.workspaceId &&
    left.groupId === right.groupId
  );
}

export function requireTopologyString(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} is invalid`);
  }
}

export function isTopologyConfigRecord(value: unknown): value is Record<string, typeof value> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function validateTopologyConfigExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  label: string,
): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new TypeError(`${label} fields are invalid`);
  }
}

export function validateAcceptedTopologyConfig(
  value: unknown,
  label: string,
): asserts value is EffectiveGroupTopologyConfig {
  if (!isTopologyConfigRecord(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  validateTopologyConfigExactKeys(
    value,
    ['topologyKind', 'degreeLimit', 'treeMinSize', 'meshMinSize', 'meshParamK'],
    label,
  );
  const { topologyKind, degreeLimit, treeMinSize, meshMinSize, meshParamK } = value;
  if (
    topologyKind !== 'auto' &&
    topologyKind !== 'star' &&
    topologyKind !== 'tree' &&
    topologyKind !== 'mesh'
  ) {
    throw new TypeError(`${label} topologyKind is invalid`);
  }
  validateTopologyPositiveInteger(degreeLimit, `${label} degreeLimit`);
  validateTopologyPositiveInteger(treeMinSize, `${label} treeMinSize`);
  validateTopologyPositiveInteger(meshMinSize, `${label} meshMinSize`);
  validateTopologyPositiveInteger(meshParamK, `${label} meshParamK`);
  validateEffectiveGroupTopologyConfig({
    topologyKind,
    degreeLimit,
    treeMinSize,
    meshMinSize,
    meshParamK,
  });
}

export function validateTopologyCausalRevision(
  value: unknown,
  label: string,
): asserts value is GroupStateCausalRevision {
  if (!isTopologyConfigRecord(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  validateTopologyConfigExactKeys(value, ['groupRevision', 'presenceRevision'], label);
  validateTopologyStorageRevision(value.groupRevision, `${label} groupRevision`);
  validateTopologyStorageRevision(value.presenceRevision, `${label} presenceRevision`);
}

export type TopologyConfigRecord = ReturnType<typeof readTopologyConfigReceiptBoundary>;
