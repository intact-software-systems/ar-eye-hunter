import type { GroupRef } from '@shared/api/group-types.ts';

import type { RuntimeStateEntryValue } from '../../../../runtime-state/RuntimeStateJsonStore.ts';
import { RuntimeStateJsonStore } from '../../../../runtime-state/RuntimeStateJsonStore.ts';
import type {
  RuntimeStateEntry,
  RuntimeStateEntryPageOptions,
  RuntimeStateRepositoryLike,
} from '../../../../runtime-state/RuntimeStateRepository.ts';
// prettier-ignore
import type { GroupTopologyConfigGenerationTarget }
  from '../mutation/group-topology-config-mutation-contracts.ts';
import {
  decodeCanonicalGroupTopologyGenerationSourceEntry,
  decodeGroupTopologyLegacyKeyMigrationEntry,
  readGroupTopologyJsonValue,
} from './group-topology-config-persistence-codec.ts';
import type {
  GroupTopologyConfigGenerationSource,
  GroupTopologyConfigGenerationSourceEntry,
  GroupTopologyConfigLegacyKeyMigrationPage,
  GroupTopologyConfigLegacyKeyMigrationSource,
} from './group-topology-config-repository-contracts.ts';
import {
  groupTopologyConfigStorageKey,
  groupTopologyGenerationSourceStorageKey,
  groupTopologyGenerationStorageKey,
  groupTopologyInvariantGenerationStorageKey,
  groupTopologyMutationStorageKey,
  groupTopologyOverrideStorageKey,
  isSameGroupTopologyRef,
  legacyGroupTopologySourceStorageKey,
} from './group-topology-config-storage-keys.ts';
import { groupTopologyConfigSourceNamespace } from './group-topology-config-runtime-namespaces.ts';

export class GroupTopologyConfigSourceRepository extends RuntimeStateJsonStore {
  constructor(readonly runtimeRepository: RuntimeStateRepositoryLike) {
    super(runtimeRepository);
  }

  async findGenerationSourceEntry(
    ref: GroupRef,
    target: GroupTopologyConfigGenerationTarget,
  ): Promise<GroupTopologyConfigGenerationSourceEntry | undefined> {
    const entry = await this.runtimeRepository.findEntry(
      groupTopologyConfigSourceNamespace(target),
      this.sourceKey(ref, target),
    );
    if (!entry) {
      return undefined;
    }
    return decodeCanonicalGroupTopologyGenerationSourceEntry(entry, target, ref);
  }

  async findGenerationSource(
    ref: GroupRef,
    target: GroupTopologyConfigGenerationTarget,
  ): Promise<GroupTopologyConfigGenerationSource | undefined> {
    return (await this.findGenerationSourceEntry(ref, target))?.source;
  }

  async listGenerationSources(
    target: GroupTopologyConfigGenerationTarget,
  ): Promise<readonly GroupTopologyConfigGenerationSource[]> {
    const entries = await this.runtimeRepository.findAllEntries(
      groupTopologyConfigSourceNamespace(target),
    );
    return entries.map(
      (entry) => decodeCanonicalGroupTopologyGenerationSourceEntry(entry, target).source,
    );
  }

  async listGenerationSourcesPage(
    target: GroupTopologyConfigGenerationTarget,
    options: RuntimeStateEntryPageOptions,
  ): Promise<readonly GroupTopologyConfigGenerationSourceEntry[]> {
    const entries = await this.listEntriesPage(
      groupTopologyConfigSourceNamespace(target),
      '',
      options,
    );
    return entries.map((entry) => decodeCanonicalGroupTopologyGenerationSourceEntry(entry, target));
  }

  async findLegacyKeyMigrationSource(
    ref: GroupRef,
    target: GroupTopologyConfigGenerationTarget,
  ): Promise<GroupTopologyConfigLegacyKeyMigrationSource | undefined> {
    const canonicalKey = this.sourceKey(ref, target);
    const legacyKey = legacyGroupTopologySourceStorageKey(ref);
    if (canonicalKey === legacyKey) {
      return undefined;
    }
    const entry = await this.runtimeRepository.findEntry(
      groupTopologyConfigSourceNamespace(target),
      legacyKey,
    );
    if (!entry) {
      return undefined;
    }
    const migration = decodeGroupTopologyLegacyKeyMigrationEntry(entry, target);
    if (!migration) {
      return undefined;
    }
    return isSameGroupTopologyRef(migration.source.groupRef, ref) ? migration : undefined;
  }

  async listLegacyKeyMigrationSourcesPage(
    target: GroupTopologyConfigGenerationTarget,
    options: RuntimeStateEntryPageOptions,
  ): Promise<GroupTopologyConfigLegacyKeyMigrationPage> {
    const entries = await this.listEntriesPage(
      groupTopologyConfigSourceNamespace(target),
      '',
      options,
    );
    return {
      sources: entries
        .map((entry) => decodeGroupTopologyLegacyKeyMigrationEntry(entry, target))
        .filter(
          (entry): entry is GroupTopologyConfigLegacyKeyMigrationSource => entry !== undefined,
        ),
      ...(entries.length === 0 ? {} : { afterKey: entries[entries.length - 1]!.key }),
      hasMore: entries.length >= Math.max(1, Math.floor(options.limit)),
    };
  }

  configKey(ref: GroupRef): string {
    return groupTopologyConfigStorageKey(ref);
  }

  overrideKey(ref: GroupRef): string {
    return groupTopologyOverrideStorageKey(ref);
  }

  mutationKey(ref: GroupRef, requestId: string): string {
    return groupTopologyMutationStorageKey(ref, requestId);
  }

  generationKey(ref: GroupRef, target: GroupTopologyConfigGenerationTarget): string {
    return groupTopologyGenerationStorageKey(ref, target);
  }

  invariantGenerationKey(ref: GroupRef): string {
    return groupTopologyInvariantGenerationStorageKey(ref);
  }

  protected override async toLiveEntryValue<T>(
    namespace: string,
    entry: RuntimeStateEntry,
  ): Promise<RuntimeStateEntryValue<T> | undefined> {
    return await readGroupTopologyJsonValue(
      entry,
      async () => await super.toLiveEntryValue<T>(namespace, entry),
    );
  }

  private sourceKey(ref: GroupRef, target: GroupTopologyConfigGenerationTarget): string {
    return groupTopologyGenerationSourceStorageKey(ref, target);
  }
}
