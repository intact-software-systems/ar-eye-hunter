import type {
  StoredGroupTopologyConfig,
  StoredGroupTopologyOverride,
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import type { RuntimeStateEntryValue } from '../../../../runtime-state/RuntimeStateJsonStore.ts';
import type { RuntimeStateEntry } from '../../../../runtime-state/RuntimeStateRepository.ts';
import * as configBoundary from '../mutation/topology-config-mutation-boundary.ts';
import type {
  GroupTopologyConfigGeneration,
  GroupTopologyConfigGenerationTarget,
  GroupTopologyConfigInvariantGeneration,
  GroupTopologyConfigMutationRecord,
} from '../mutation/group-topology-config-mutation-contracts.ts';
import {
  decodeStoredGroupTopologyConfig,
  decodeStoredGroupTopologyOverride,
  storedTopologyGroupRef,
} from './decode-stored-group-topology-config.ts';
import {
  GroupTopologyConfigRepositoryInvariantCorruptionError,
  type GroupTopologyConfigGenerationSourceEntry,
  type GroupTopologyConfigLegacyKeyMigrationSource,
  toGroupTopologyConfigRepositoryCorruption,
} from './group-topology-config-repository-contracts.ts';
import {
  assertGroupTopologyGenerationStorageSlot,
  assertGroupTopologyInvariantStorageSlot,
  assertGroupTopologyMutationStorageSlot,
  assertGroupTopologyRef,
  decodeGroupTopologyStorageKey,
  groupTopologyConfigStorageKey,
  isSameGroupTopologyRef,
  legacyGroupTopologySourceStorageKey,
} from './group-topology-config-storage-keys.ts';

export function decodeGroupTopologyMutationEntry(
  entry: RuntimeStateEntry,
  trustedRef: GroupRef,
  trustedRequestId: string,
): GroupTopologyConfigMutationRecord {
  return decodeGroupTopologyMutationValue(
    entry,
    parseGroupTopologyEntryValue(entry),
    trustedRef,
    trustedRequestId,
  );
}

export function decodeGroupTopologyMutationValue(
  entry: RuntimeStateEntry,
  value: unknown,
  trustedRef: GroupRef,
  trustedRequestId: string,
): GroupTopologyConfigMutationRecord {
  const decoded = assertGroupTopologyMutationStorageSlot(entry.key, trustedRef, trustedRequestId);
  const expected = { groupRef: decoded, requestId: decoded.requestId };
  const record = validateGroupTopologyBoundary(entry.key, () =>
    configBoundary.readTopologyConfigMutationRecordBoundary(value, expected),
  );
  assertGroupTopologyRef({
    actual: record.groupRef,
    expected: decoded,
    storageKey: entry.key,
    slot: 'mutation value',
  });
  return record;
}

export function decodeGroupTopologyGenerationEntry(
  entry: RuntimeStateEntry,
  trustedRef: GroupRef,
  trustedTarget: GroupTopologyConfigGenerationTarget,
): GroupTopologyConfigGeneration {
  return decodeGroupTopologyGenerationValue(
    entry,
    parseGroupTopologyEntryValue(entry),
    trustedRef,
    trustedTarget,
  );
}

export function decodeGroupTopologyGenerationValue(
  entry: RuntimeStateEntry,
  value: unknown,
  trustedRef: GroupRef,
  trustedTarget: GroupTopologyConfigGenerationTarget,
): GroupTopologyConfigGeneration {
  const decoded = assertGroupTopologyGenerationStorageSlot(entry.key, trustedRef, trustedTarget);
  const generation = validateGroupTopologyBoundary(entry.key, () =>
    configBoundary.readTopologyConfigGenerationBoundary(value, decoded, decoded.target),
  );
  assertGroupTopologyRef({
    actual: generation.groupRef,
    expected: decoded,
    storageKey: entry.key,
    slot: 'generation value',
  });
  return generation;
}

export function decodeGroupTopologyInvariantEntry(
  entry: RuntimeStateEntry,
  trustedRef: GroupRef,
): GroupTopologyConfigInvariantGeneration {
  return decodeGroupTopologyInvariantValue(entry, parseGroupTopologyEntryValue(entry), trustedRef);
}

export function decodeGroupTopologyInvariantValue(
  entry: RuntimeStateEntry,
  value: unknown,
  trustedRef: GroupRef,
): GroupTopologyConfigInvariantGeneration {
  const decoded = assertGroupTopologyInvariantStorageSlot(entry.key, trustedRef);
  const generation = validateGroupTopologyBoundary(entry.key, () =>
    configBoundary.readTopologyConfigInvariantGenerationBoundary(value, decoded),
  );
  assertGroupTopologyRef({
    actual: generation.groupRef,
    expected: decoded,
    storageKey: entry.key,
    slot: 'invariant-generation value',
  });
  return generation;
}

export function assertRetainedGroupTopologyEntry(entry: RuntimeStateEntry, label: string): void {
  if (entry.expireAtTimestamp !== NEVER_EXPIRE_AT_TIMESTAMP) {
    throw toGroupTopologyConfigRepositoryCorruption(
      entry.key,
      `Stored topology config ${label} must not expire`,
    );
  }
}

export function decodeCanonicalGroupTopologyGenerationSourceEntry(
  entry: RuntimeStateEntry,
  target: GroupTopologyConfigGenerationTarget,
  trustedRef?: GroupRef,
): GroupTopologyConfigGenerationSourceEntry {
  const decoded = decodeGroupTopologyStorageKey(entry.key);
  if (trustedRef) {
    assertGroupTopologyRef({
      actual: decoded,
      expected: trustedRef,
      storageKey: entry.key,
      slot: 'requested generation-source slot',
    });
  }
  const value = decodeGroupTopologySourceValue(entry, target, decoded);
  assertGroupTopologyRef({
    actual: value.groupRef,
    expected: decoded,
    storageKey: entry.key,
    slot: 'generation-source value',
  });
  return {
    entry,
    source: { groupRef: decoded, target, version: value.version },
    value,
  };
}

export function assertCanonicalGroupTopologySourceEntry(
  entry: RuntimeStateEntry,
  target: GroupTopologyConfigGenerationTarget,
  trustedRef: GroupRef,
): void {
  decodeCanonicalGroupTopologyGenerationSourceEntry(entry, target, trustedRef);
}

export function toValidatedLiveGroupTopologySourceEntry(
  stored: RuntimeStateEntryValue<StoredGroupTopologyConfig>,
  target: 'config',
  trustedRef: GroupRef,
): RuntimeStateEntryValue<StoredGroupTopologyConfig>;
export function toValidatedLiveGroupTopologySourceEntry(
  stored: RuntimeStateEntryValue<StoredGroupTopologyOverride>,
  target: 'override',
  trustedRef: GroupRef,
): RuntimeStateEntryValue<StoredGroupTopologyOverride>;
export function toValidatedLiveGroupTopologySourceEntry(
  stored: RuntimeStateEntryValue<StoredGroupTopologyConfig | StoredGroupTopologyOverride>,
  target: GroupTopologyConfigGenerationTarget,
  trustedRef: GroupRef,
): RuntimeStateEntryValue<StoredGroupTopologyConfig | StoredGroupTopologyOverride> {
  const entry = { ...stored.entry, value: JSON.stringify(stored.value) };
  const validated = decodeCanonicalGroupTopologyGenerationSourceEntry(entry, target, trustedRef);
  return { entry: stored.entry, value: validated.value };
}

export function decodeGroupTopologyLegacyKeyMigrationEntry(
  entry: RuntimeStateEntry,
  target: GroupTopologyConfigGenerationTarget,
): GroupTopologyConfigLegacyKeyMigrationSource | undefined {
  const value = decodeGroupTopologySourceValue(entry, target);
  const canonicalKey = groupTopologyConfigStorageKey(value.groupRef);
  if (entry.key === canonicalKey) {
    const decoded = decodeGroupTopologyStorageKey(entry.key);
    assertGroupTopologyRef({
      actual: value.groupRef,
      expected: decoded,
      storageKey: entry.key,
      slot: 'generation-source value',
    });
    return undefined;
  }
  if (entry.key !== legacyGroupTopologySourceStorageKey(value.groupRef)) {
    throw toGroupTopologyConfigRepositoryCorruption(
      entry.key,
      'Stored topology config legacy key differs from its value',
    );
  }
  return {
    entry,
    canonicalKey,
    source: { groupRef: value.groupRef, target, version: value.version },
    value,
  };
}

export async function readGroupTopologyJsonValue<T>(
  entry: RuntimeStateEntry,
  parse: () => Promise<T>,
): Promise<T> {
  try {
    return await parse();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw toGroupTopologyConfigRepositoryCorruption(
        entry.key,
        `Stored topology config JSON is invalid: ${error.message}`,
      );
    }
    throw error;
  }
}

function parseGroupTopologyEntryValue(entry: RuntimeStateEntry): unknown {
  return validateGroupTopologyBoundary(entry.key, () => JSON.parse(entry.value));
}

function decodeGroupTopologySourceValue(
  entry: RuntimeStateEntry,
  target: GroupTopologyConfigGenerationTarget,
  expectedRef?: GroupRef,
): StoredGroupTopologyConfig | StoredGroupTopologyOverride {
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.value);
  } catch (error) {
    throw toGroupTopologyConfigRepositoryCorruption(
      entry.key,
      `Stored topology config JSON is invalid: ${
        error instanceof Error ? error.message : 'invalid JSON'
      }`,
    );
  }
  const value = validateGroupTopologyBoundary(entry.key, () => {
    const storedRef = storedTopologyGroupRef(parsed);
    if (expectedRef) {
      assertGroupTopologyRef({
        actual: storedRef,
        expected: expectedRef,
        storageKey: entry.key,
        slot: 'generation-source value',
      });
    }
    return target === 'config'
      ? decodeStoredGroupTopologyConfig(parsed, storedRef)
      : decodeStoredGroupTopologyOverride(parsed, storedRef);
  });
  const expectedExpiry =
    target === 'config'
      ? NEVER_EXPIRE_AT_TIMESTAMP
      : (value as StoredGroupTopologyOverride).expiresAtEpochMs;
  if (entry.expireAtTimestamp !== expectedExpiry) {
    throw toGroupTopologyConfigRepositoryCorruption(
      entry.key,
      `Stored topology ${target} physical expiry differs from its value contract`,
    );
  }
  return value;
}

function validateGroupTopologyBoundary<T>(storageKey: string, validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (error instanceof GroupTopologyConfigRepositoryInvariantCorruptionError) {
      throw error;
    }
    throw toGroupTopologyConfigRepositoryCorruption(
      storageKey,
      error instanceof Error ? error.message : 'Stored topology config value is invalid',
    );
  }
}
