import type { GroupRef } from '@shared/api/group-types.ts';

import {
  decodeGroupStateGroupStorageKey,
  decodeGroupStateIdempotencyStorageKey,
  groupStateGroupStorageKey,
  groupStateIdempotencyStorageKey,
} from '../../../group-state/persistence/group-state-storage-keys.ts';
// prettier-ignore
import type { GroupTopologyConfigGenerationTarget }
  from '../mutation/group-topology-config-mutation-contracts.ts';
// prettier-ignore
import { toGroupTopologyConfigRepositoryCorruption }
  from './group-topology-config-repository-contracts.ts';

interface GroupTopologyChildStorageKey {
  readonly groupRef: GroupRef;
  readonly value: string;
}

export interface GroupTopologyRefExpectation {
  readonly actual: GroupRef;
  readonly expected: GroupRef;
  readonly storageKey: string;
  readonly slot: string;
}

export function groupTopologyConfigStorageKey(ref: GroupRef): string {
  return groupStateGroupStorageKey(ref);
}

export function groupTopologyOverrideStorageKey(ref: GroupRef): string {
  return groupStateGroupStorageKey(ref);
}

export function groupTopologyMutationStorageKey(ref: GroupRef, requestId: string): string {
  return groupStateIdempotencyStorageKey(ref, requestId);
}

export function groupTopologyGenerationStorageKey(
  ref: GroupRef,
  target: GroupTopologyConfigGenerationTarget,
): string {
  return groupTopologyChildStorageKey(ref, 'target', target);
}

export function groupTopologyInvariantGenerationStorageKey(ref: GroupRef): string {
  return groupTopologyChildStorageKey(ref, 'invariant', 'effective-config');
}

export function groupTopologyGenerationSourceStorageKey(
  ref: GroupRef,
  target: GroupTopologyConfigGenerationTarget,
): string {
  return target === 'config'
    ? groupTopologyConfigStorageKey(ref)
    : groupTopologyOverrideStorageKey(ref);
}

export function legacyGroupTopologySourceStorageKey(ref: GroupRef): string {
  return [
    `app=${encodeURIComponent(ref.applicationId)}`,
    `ws=${encodeURIComponent(ref.workspaceId ?? '_')}`,
    `group=${encodeURIComponent(ref.groupId)}`,
  ].join(':');
}

export function decodeGroupTopologyStorageKey(storageKey: string): GroupRef {
  try {
    return decodeGroupStateGroupStorageKey(storageKey);
  } catch (error) {
    throw toGroupTopologyConfigRepositoryCorruption(
      storageKey,
      error instanceof Error ? error.message : 'Stored topology config group key is invalid',
    );
  }
}

export function assertGroupTopologyMutationStorageSlot(
  storageKey: string,
  trustedRef: GroupRef,
  trustedRequestId: string,
): GroupRef & Readonly<{ requestId: string }> {
  const decoded = decodeGroupTopologyMutationStorageKey(storageKey);
  assertGroupTopologyRef({
    actual: decoded,
    expected: trustedRef,
    storageKey,
    slot: 'requested mutation slot',
  });
  if (decoded.requestId !== trustedRequestId) {
    throw toGroupTopologyConfigRepositoryCorruption(
      storageKey,
      'Stored topology config request differs from the requested slot',
    );
  }
  return decoded;
}

export function assertGroupTopologyGenerationStorageSlot(
  storageKey: string,
  trustedRef: GroupRef,
  trustedTarget: GroupTopologyConfigGenerationTarget,
): GroupRef & Readonly<{ target: GroupTopologyConfigGenerationTarget }> {
  const decoded = decodeGroupTopologyGenerationStorageKey(storageKey);
  assertGroupTopologyRef({
    actual: decoded,
    expected: trustedRef,
    storageKey,
    slot: 'requested generation slot',
  });
  if (decoded.target !== trustedTarget) {
    throw toGroupTopologyConfigRepositoryCorruption(
      storageKey,
      'Stored topology config generation target differs from the requested slot',
    );
  }
  return decoded;
}

export function assertGroupTopologyInvariantStorageSlot(
  storageKey: string,
  trustedRef: GroupRef,
): GroupRef {
  const decoded = decodeGroupTopologyInvariantGenerationStorageKey(storageKey);
  assertGroupTopologyRef({
    actual: decoded,
    expected: trustedRef,
    storageKey,
    slot: 'requested invariant-generation slot',
  });
  return decoded;
}

export function assertGroupTopologyRef(input: GroupTopologyRefExpectation): void {
  if (!isSameGroupTopologyRef(input.actual, input.expected)) {
    throw toGroupTopologyConfigRepositoryCorruption(
      input.storageKey,
      `Stored topology config identity differs from the ${input.slot}`,
    );
  }
}

export function isSameGroupTopologyRef(left: GroupRef, right: GroupRef): boolean {
  return (
    left.applicationId === right.applicationId &&
    left.workspaceId === right.workspaceId &&
    left.groupId === right.groupId
  );
}

function groupTopologyChildStorageKey(ref: GroupRef, name: string, value: string): string {
  return `${groupStateGroupStorageKey(ref)}:${name}=${encodeURIComponent(value)}`;
}

function decodeGroupTopologyMutationStorageKey(
  storageKey: string,
): GroupRef & Readonly<{ requestId: string }> {
  try {
    return decodeGroupStateIdempotencyStorageKey(storageKey);
  } catch (error) {
    throw toGroupTopologyConfigRepositoryCorruption(
      storageKey,
      error instanceof Error ? error.message : 'Stored topology config mutation key is invalid',
    );
  }
}

function decodeGroupTopologyGenerationStorageKey(
  storageKey: string,
): GroupRef & Readonly<{ target: GroupTopologyConfigGenerationTarget }> {
  const decoded = decodeGroupTopologyChildStorageKey(storageKey, 'target');
  if (decoded.value !== 'config' && decoded.value !== 'override') {
    throw toGroupTopologyConfigRepositoryCorruption(
      storageKey,
      'Stored topology config generation target is invalid',
    );
  }
  return { ...decoded.groupRef, target: decoded.value };
}

function decodeGroupTopologyInvariantGenerationStorageKey(storageKey: string): GroupRef {
  const decoded = decodeGroupTopologyChildStorageKey(storageKey, 'invariant');
  if (decoded.value !== 'effective-config') {
    throw toGroupTopologyConfigRepositoryCorruption(
      storageKey,
      'Stored topology config invariant slot is invalid',
    );
  }
  return decoded.groupRef;
}

function decodeGroupTopologyChildStorageKey(
  storageKey: string,
  name: string,
): GroupTopologyChildStorageKey {
  const parts = storageKey.split(':');
  if (parts.length !== 4) {
    throw toGroupTopologyConfigRepositoryCorruption(
      storageKey,
      `Stored topology config ${name} key has invalid arity`,
    );
  }
  const groupRef = decodeGroupTopologyStorageKey(parts.slice(0, 3).join(':'));
  const prefix = `${name}=`;
  if (!parts[3]?.startsWith(prefix)) {
    throw toGroupTopologyConfigRepositoryCorruption(
      storageKey,
      `Stored topology config key is missing ${name}`,
    );
  }
  let value: string;
  try {
    value = decodeURIComponent(parts[3].slice(prefix.length));
  } catch {
    throw toGroupTopologyConfigRepositoryCorruption(
      storageKey,
      `Stored topology config key has invalid ${name} encoding`,
    );
  }
  if (groupTopologyChildStorageKey(groupRef, name, value) !== storageKey) {
    throw toGroupTopologyConfigRepositoryCorruption(
      storageKey,
      `Stored topology config ${name} key is not canonical`,
    );
  }
  return { groupRef, value };
}
