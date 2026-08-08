import type {
  StoredGroupTopologyConfig,
  StoredGroupTopologyOverride,
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import {
  validateStoredGroupTopologyConfig,
  validateStoredGroupTopologyOverride,
} from '../topology/config/mutation/validate-topology-config-mutation-records.ts';

const LEGACY_CONFIG_KEYS = [
  'groupRef',
  'config',
  'version',
  'createdAtEpochMs',
  'updatedAtEpochMs',
  'updatedByPrincipalId',
] as const;

const LEGACY_OVERRIDE_KEYS = [
  ...LEGACY_CONFIG_KEYS,
  'expiresAtEpochMs',
] as const;

export function decodeStoredGroupTopologyConfig(
  value: unknown,
  expectedRef?: GroupRef,
): StoredGroupTopologyConfig {
  const normalized = hasExactKeys(value, LEGACY_CONFIG_KEYS)
    ? { ...value, requestId: null }
    : value;
  const validationRef = expectedRef ?? storedTopologyGroupRef(normalized);
  validateStoredGroupTopologyConfig(normalized, validationRef);
  return normalized;
}

export function decodeStoredGroupTopologyOverride(
  value: unknown,
  expectedRef?: GroupRef,
): StoredGroupTopologyOverride {
  const normalized = hasExactKeys(value, LEGACY_OVERRIDE_KEYS)
    ? { ...value, requestId: null }
    : value;
  const validationRef = expectedRef ?? storedTopologyGroupRef(normalized);
  validateStoredGroupTopologyOverride(normalized, validationRef);
  return normalized;
}

export function storedTopologyGroupRef(value: unknown): GroupRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Stored topology config generation source is invalid');
  }
  const groupRef = (value as Readonly<{ groupRef?: unknown }>).groupRef;
  if (!groupRef || typeof groupRef !== 'object' || Array.isArray(groupRef)) {
    throw new TypeError(
      'Stored topology config generation source groupRef is invalid',
    );
  }
  const candidate = groupRef as Readonly<Record<string, unknown>>;
  if (
    typeof candidate.applicationId !== 'string' ||
    candidate.applicationId.trim().length === 0 ||
    (candidate.workspaceId !== undefined &&
      (typeof candidate.workspaceId !== 'string' ||
        candidate.workspaceId.trim().length === 0)) ||
    typeof candidate.groupId !== 'string' ||
    candidate.groupId.trim().length === 0
  ) {
    throw new TypeError(
      'Stored topology config generation source groupRef is invalid',
    );
  }
  return {
    applicationId: candidate.applicationId,
    workspaceId: typeof candidate.workspaceId === 'string'
      ? candidate.workspaceId
      : DEFAULT_STATE_WORKSPACE_ID,
    groupId: candidate.groupId,
  };
}

function hasExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value).sort();
  return JSON.stringify(actualKeys) ===
    JSON.stringify([...expectedKeys].sort());
}
