import type { GroupRef } from '@shared/api/group-types.ts';

import type { RuntimeStateEntryValue } from '../../../../runtime-state/runtime-state-json-store.ts';
import { RuntimeStateJsonStore } from '../../../../runtime-state/runtime-state-json-store.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateEntryPageOptions,
    RuntimeStateRepositoryLike
} from '../../../../runtime-state/runtime-state-repository.ts';
import type { JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import type { GroupTopologyConfigGenerationTarget } from '../mutation/group-topology-config-mutation-contracts.ts';
import { readGroupTopologyJsonValue } from './group-topology-config-json-decoding.ts';
import type {
    GroupTopologyConfigGenerationSource,
    GroupTopologyConfigGenerationSourceEntry
} from './group-topology-config-repository-contracts.ts';
import { groupTopologyConfigSourceNamespace } from './group-topology-config-runtime-namespaces.ts';
import { decodeCanonicalGroupTopologyGenerationSourceEntry } from './group-topology-config-source-codec.ts';
import {
    groupTopologyConfigStorageKey,
    groupTopologyGenerationSourceStorageKey,
    groupTopologyGenerationStorageKey,
    groupTopologyInvariantGenerationStorageKey,
    groupTopologyMutationStorageKey,
    groupTopologyOverrideStorageKey
} from './group-topology-config-storage-keys.ts';

export class GroupTopologyConfigSourceRepository extends RuntimeStateJsonStore {
    readonly runtimeRepository: RuntimeStateRepositoryLike;

    constructor(runtimeRepository: RuntimeStateRepositoryLike) {
        super(runtimeRepository);
        this.runtimeRepository = runtimeRepository;
    }

    async findGenerationSourceEntry(
        ref: GroupRef,
        target: GroupTopologyConfigGenerationTarget
    ): Promise<GroupTopologyConfigGenerationSourceEntry | undefined> {
        const entry = await this.runtimeRepository.findEntry(
            groupTopologyConfigSourceNamespace(target),
            this.sourceKey(ref, target)
        );
        if (!entry) {
            return undefined;
        }
        return decodeCanonicalGroupTopologyGenerationSourceEntry(entry, target, ref);
    }

    async findGenerationSource(
        ref: GroupRef,
        target: GroupTopologyConfigGenerationTarget
    ): Promise<GroupTopologyConfigGenerationSource | undefined> {
        return (await this.findGenerationSourceEntry(ref, target))?.source;
    }

    async listGenerationSources(
        target: GroupTopologyConfigGenerationTarget
    ): Promise<readonly GroupTopologyConfigGenerationSource[]> {
        const entries = await this.runtimeRepository.findAllEntries(
            groupTopologyConfigSourceNamespace(target)
        );
        return entries.map(
            (entry) => decodeCanonicalGroupTopologyGenerationSourceEntry(entry, target).source
        );
    }

    async listGenerationSourcesPage(
        target: GroupTopologyConfigGenerationTarget,
        options: RuntimeStateEntryPageOptions
    ): Promise<readonly GroupTopologyConfigGenerationSourceEntry[]> {
        const entries = await this.listEntriesPage(
            groupTopologyConfigSourceNamespace(target),
            '',
            options
        );
        return entries.map((entry) => decodeCanonicalGroupTopologyGenerationSourceEntry(entry, target));
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

    protected override async toLiveJsonEntryValue(
        namespace: string,
        entry: RuntimeStateEntry
    ): Promise<RuntimeStateEntryValue<JsonWireValue> | undefined> {
        return await readGroupTopologyJsonValue(
            entry,
            async () => await super.toLiveJsonEntryValue(namespace, entry)
        );
    }

    private sourceKey(ref: GroupRef, target: GroupTopologyConfigGenerationTarget): string {
        return groupTopologyGenerationSourceStorageKey(ref, target);
    }
}
