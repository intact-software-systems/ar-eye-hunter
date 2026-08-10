import type {
  StoredGroupTopologyConfig,
  StoredGroupTopologyOverride,
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import type { RuntimeStateEntryValue } from '../../../../runtime-state/RuntimeStateJsonStore.ts';
import type {
  GroupTopologyConfigGeneration,
  GroupTopologyConfigGenerationTarget,
  GroupTopologyConfigInvariantGeneration,
  GroupTopologyConfigMutationRecord,
} from '../mutation/group-topology-config-mutation-contracts.ts';
import {
  validateGroupTopologyConfigGeneration,
  validateGroupTopologyConfigInvariantGeneration,
  validateGroupTopologyConfigMutationRecord,
  validateStoredGroupTopologyConfig,
  validateStoredGroupTopologyOverride,
} from '../mutation/validate-topology-config-records.ts';
import {
  assertCanonicalGroupTopologySourceEntry,
  assertRetainedGroupTopologyEntry,
  decodeGroupTopologyGenerationEntry,
  decodeGroupTopologyGenerationValue,
  decodeGroupTopologyInvariantEntry,
  decodeGroupTopologyInvariantValue,
  decodeGroupTopologyMutationEntry,
  decodeGroupTopologyMutationValue,
  toValidatedLiveGroupTopologySourceEntry,
} from './group-topology-config-persistence-codec.ts';
import type {
  GroupTopologyConfigCommitResult,
  GroupTopologyConfigDeleteResult,
} from './group-topology-config-repository-contracts.ts';
import {
  GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
  GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
  GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
  GROUP_TOPOLOGY_CONFIG_NAMESPACE,
  GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
} from './group-topology-config-runtime-namespaces.ts';
import { GroupTopologyConfigSourceRepository } from './group-topology-config-source-repository.ts';
import {
  createGroupTopologyMutationExactReadDecoders,
  createGroupTopologyMutationExactReadLocations,
  readGroupTopologyMutationExactEntries,
  type GroupTopologyMutationExactReadResult,
} from './read-exact-group-topology-config-mutation.ts';

type GroupTopologyMutationStoredValue =
  | StoredGroupTopologyConfig
  | StoredGroupTopologyOverride
  | GroupTopologyConfigGeneration
  | GroupTopologyConfigInvariantGeneration
  | GroupTopologyConfigMutationRecord;

export class GroupTopologyConfigRepository extends GroupTopologyConfigSourceRepository {
  async readMutationExactEntries(
    ref: GroupRef,
    requestId: string | null,
  ): Promise<GroupTopologyMutationExactReadResult> {
    const locations = createGroupTopologyMutationExactReadLocations(
      this,
      {
        invariant: GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
        config: GROUP_TOPOLOGY_CONFIG_NAMESPACE,
        override: GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
        generation: GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
        idempotency: GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
      },
      ref,
      requestId,
    );
    const decoders = createGroupTopologyMutationExactReadDecoders(ref, requestId, {
      validateSourceRaw: assertCanonicalGroupTopologySourceEntry,
      decodeConfigLive: (stored, trustedRef) =>
        toValidatedLiveGroupTopologySourceEntry(
          stored as RuntimeStateEntryValue<StoredGroupTopologyConfig>,
          'config',
          trustedRef,
        ),
      decodeOverrideLive: (stored, trustedRef) =>
        toValidatedLiveGroupTopologySourceEntry(
          stored as RuntimeStateEntryValue<StoredGroupTopologyOverride>,
          'override',
          trustedRef,
        ),
      validateInvariantRaw: decodeGroupTopologyInvariantEntry,
      validateInvariantLive: decodeGroupTopologyInvariantValue,
      validateGenerationRaw: decodeGroupTopologyGenerationEntry,
      validateGenerationLive: decodeGroupTopologyGenerationValue,
      validateMutationRaw: decodeGroupTopologyMutationEntry,
      validateMutationLive: decodeGroupTopologyMutationValue,
      assertRetained: assertRetainedGroupTopologyEntry,
    });
    return await readGroupTopologyMutationExactEntries(
      this.runtimeRepository,
      locations,
      async (namespace, entry) =>
        await this.toLiveEntryValue<GroupTopologyMutationStoredValue>(namespace, entry),
      decoders,
    );
  }

  async findConfigEntry(
    ref: GroupRef,
  ): Promise<RuntimeStateEntryValue<StoredGroupTopologyConfig> | undefined> {
    const raw = await this.runtimeRepository.findEntry(
      GROUP_TOPOLOGY_CONFIG_NAMESPACE,
      this.configKey(ref),
    );
    if (!raw) {
      return undefined;
    }
    assertCanonicalGroupTopologySourceEntry(raw, 'config', ref);
    const stored = await this.toLiveEntryValue<StoredGroupTopologyConfig>(
      GROUP_TOPOLOGY_CONFIG_NAMESPACE,
      raw,
    );
    return stored ? toValidatedLiveGroupTopologySourceEntry(stored, 'config', ref) : undefined;
  }

  async findConfig(ref: GroupRef): Promise<StoredGroupTopologyConfig | undefined> {
    return (await this.findConfigEntry(ref))?.value;
  }

  async commitConfig(
    config: StoredGroupTopologyConfig,
    expectedRevision: number | null,
  ): Promise<GroupTopologyConfigCommitResult> {
    validateStoredGroupTopologyConfig(config, config.groupRef);
    const result =
      expectedRevision === null
        ? await this.putValueIfAbsent(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            this.configKey(config.groupRef),
            config,
            NEVER_EXPIRE_AT_TIMESTAMP,
          )
        : await this.putValueIfRevision(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            this.configKey(config.groupRef),
            config,
            NEVER_EXPIRE_AT_TIMESTAMP,
            expectedRevision,
          );
    return result.status === 'applied'
      ? { status: 'accepted', storageRevision: result.revision }
      : { status: 'conflict' };
  }

  async deleteConfig(
    ref: GroupRef,
    expectedRevision: number,
  ): Promise<GroupTopologyConfigDeleteResult> {
    const result = await this.deleteValueIfRevision(
      GROUP_TOPOLOGY_CONFIG_NAMESPACE,
      this.configKey(ref),
      expectedRevision,
    );
    return result.status === 'applied' ? { status: 'accepted' } : { status: 'conflict' };
  }

  async findOverrideEntry(
    ref: GroupRef,
  ): Promise<RuntimeStateEntryValue<StoredGroupTopologyOverride> | undefined> {
    const raw = await this.runtimeRepository.findEntry(
      GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
      this.overrideKey(ref),
    );
    if (!raw) {
      return undefined;
    }
    assertCanonicalGroupTopologySourceEntry(raw, 'override', ref);
    const stored = await this.toLiveEntryValue<StoredGroupTopologyOverride>(
      GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
      raw,
    );
    return stored ? toValidatedLiveGroupTopologySourceEntry(stored, 'override', ref) : undefined;
  }

  async findOverride(ref: GroupRef): Promise<StoredGroupTopologyOverride | undefined> {
    return (await this.findOverrideEntry(ref))?.value;
  }

  async commitOverride(
    override: StoredGroupTopologyOverride,
    expectedRevision: number | null,
  ): Promise<GroupTopologyConfigCommitResult> {
    validateStoredGroupTopologyOverride(override, override.groupRef);
    const result =
      expectedRevision === null
        ? await this.putValueIfAbsent(
            GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
            this.overrideKey(override.groupRef),
            override,
            override.expiresAtEpochMs,
          )
        : await this.putValueIfRevision(
            GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
            this.overrideKey(override.groupRef),
            override,
            override.expiresAtEpochMs,
            expectedRevision,
          );
    return result.status === 'applied'
      ? { status: 'accepted', storageRevision: result.revision }
      : { status: 'conflict' };
  }

  async deleteOverride(
    ref: GroupRef,
    expectedRevision: number,
  ): Promise<GroupTopologyConfigDeleteResult> {
    const result = await this.deleteValueIfRevision(
      GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
      this.overrideKey(ref),
      expectedRevision,
    );
    return result.status === 'applied' ? { status: 'accepted' } : { status: 'conflict' };
  }

  async findMutationRecordEntry(
    ref: GroupRef,
    requestId: string,
  ): Promise<RuntimeStateEntryValue<GroupTopologyConfigMutationRecord> | undefined> {
    const raw = await this.runtimeRepository.findEntry(
      GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
      this.mutationKey(ref, requestId),
    );
    if (!raw) {
      return undefined;
    }
    decodeGroupTopologyMutationEntry(raw, ref, requestId);
    assertRetainedGroupTopologyEntry(raw, 'mutation record');
    const stored = await this.toLiveEntryValue<GroupTopologyConfigMutationRecord>(
      GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
      raw,
    );
    if (stored) {
      decodeGroupTopologyMutationValue(stored.entry, stored.value, ref, requestId);
    }
    return stored;
  }

  async findMutationRecord(
    ref: GroupRef,
    requestId: string,
  ): Promise<GroupTopologyConfigMutationRecord | undefined> {
    return (await this.findMutationRecordEntry(ref, requestId))?.value;
  }

  async insertMutationRecord(
    record: GroupTopologyConfigMutationRecord,
  ): Promise<GroupTopologyConfigCommitResult> {
    validateGroupTopologyConfigMutationRecord(record, {
      groupRef: record.groupRef,
      requestId: record.requestId,
    });
    const result = await this.putValueIfAbsent(
      GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
      this.mutationKey(record.groupRef, record.requestId),
      record,
      NEVER_EXPIRE_AT_TIMESTAMP,
    );
    return result.status === 'applied'
      ? { status: 'accepted', storageRevision: result.revision }
      : { status: 'conflict' };
  }

  async findGenerationEntry(
    ref: GroupRef,
    target: GroupTopologyConfigGenerationTarget,
  ): Promise<RuntimeStateEntryValue<GroupTopologyConfigGeneration> | undefined> {
    const raw = await this.runtimeRepository.findEntry(
      GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
      this.generationKey(ref, target),
    );
    if (!raw) {
      return undefined;
    }
    decodeGroupTopologyGenerationEntry(raw, ref, target);
    assertRetainedGroupTopologyEntry(raw, 'target generation');
    const stored = await this.toLiveEntryValue<GroupTopologyConfigGeneration>(
      GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
      raw,
    );
    if (stored) {
      decodeGroupTopologyGenerationValue(stored.entry, stored.value, ref, target);
    }
    return stored;
  }

  async commitGeneration(
    generation: GroupTopologyConfigGeneration,
    expectedRevision: number | null,
  ): Promise<GroupTopologyConfigCommitResult> {
    validateGroupTopologyConfigGeneration(generation, generation.groupRef, generation.target);
    const result =
      expectedRevision === null
        ? await this.putValueIfAbsent(
            GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
            this.generationKey(generation.groupRef, generation.target),
            generation,
            NEVER_EXPIRE_AT_TIMESTAMP,
          )
        : await this.putValueIfRevision(
            GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
            this.generationKey(generation.groupRef, generation.target),
            generation,
            NEVER_EXPIRE_AT_TIMESTAMP,
            expectedRevision,
          );
    return result.status === 'applied'
      ? { status: 'accepted', storageRevision: result.revision }
      : { status: 'conflict' };
  }

  async findInvariantGenerationEntry(
    ref: GroupRef,
  ): Promise<RuntimeStateEntryValue<GroupTopologyConfigInvariantGeneration> | undefined> {
    const raw = await this.runtimeRepository.findEntry(
      GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
      this.invariantGenerationKey(ref),
    );
    if (!raw) {
      return undefined;
    }
    decodeGroupTopologyInvariantEntry(raw, ref);
    assertRetainedGroupTopologyEntry(raw, 'invariant generation');
    const stored = await this.toLiveEntryValue<GroupTopologyConfigInvariantGeneration>(
      GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
      raw,
    );
    if (stored) {
      decodeGroupTopologyInvariantValue(stored.entry, stored.value, ref);
    }
    return stored;
  }

  async commitInvariantGeneration(
    generation: GroupTopologyConfigInvariantGeneration,
    expectedRevision: number | null,
  ): Promise<GroupTopologyConfigCommitResult> {
    validateGroupTopologyConfigInvariantGeneration(generation, generation.groupRef);
    const result =
      expectedRevision === null
        ? await this.putValueIfAbsent(
            GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
            this.invariantGenerationKey(generation.groupRef),
            generation,
            NEVER_EXPIRE_AT_TIMESTAMP,
          )
        : await this.putValueIfRevision(
            GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
            this.invariantGenerationKey(generation.groupRef),
            generation,
            NEVER_EXPIRE_AT_TIMESTAMP,
            expectedRevision,
          );
    return result.status === 'applied'
      ? { status: 'accepted', storageRevision: result.revision }
      : { status: 'conflict' };
  }
}
