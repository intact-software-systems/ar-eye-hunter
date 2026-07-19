import type { GroupRef } from '@shared/api/group-types.ts';
import type {
    StoredGroupTopologyConfig,
    StoredGroupTopologyOverride,
} from '@shared/api/graph-topology-management-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/RuntimeStateJsonStore.ts';
import { RuntimeStateJsonStore } from '../../runtime-state/RuntimeStateJsonStore.ts';
import type {
    RuntimeStateRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import type {
    GroupTopologyConfigGeneration,
    GroupTopologyConfigGenerationTarget,
    GroupTopologyConfigInvariantGeneration,
    GroupTopologyConfigMutationRecord,
} from '../services/group-topology-config-mutations.ts';
import {
    validateGroupTopologyConfigGeneration,
    validateGroupTopologyConfigInvariantGeneration,
    validateGroupTopologyConfigMutationRecord,
    validateStoredGroupTopologyConfig,
    validateStoredGroupTopologyOverride,
} from '../services/group-topology-config-mutations.ts';

export const GROUP_TOPOLOGY_CONFIG_NAMESPACE = 'group-topology:config';
export const GROUP_TOPOLOGY_OVERRIDE_NAMESPACE = 'group-topology:override';
export const GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE =
    'group-topology:config-mutation';
export const GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE =
    'group-topology:config-generation';
export const GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE =
    'group-topology:config-invariant-generation';

export type GroupTopologyConfigCommitResult =
    | Readonly<{ status: 'accepted'; storageRevision: number }>
    | Readonly<{ status: 'conflict' }>;

export type GroupTopologyConfigDeleteResult =
    | Readonly<{ status: 'accepted' }>
    | Readonly<{ status: 'conflict' }>;

export class GroupTopologyConfigRepository extends RuntimeStateJsonStore {
    constructor(
        readonly runtimeRepository:
            RuntimeStateRepositoryLike,
    ) {
        super(runtimeRepository);
    }

    async findConfigEntry(
        ref: GroupRef,
    ): Promise<RuntimeStateEntryValue<StoredGroupTopologyConfig> | undefined> {
        const stored = await this.getEntryValue<StoredGroupTopologyConfig>(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            this.configKey(ref),
        );
        if (!stored) return undefined;
        return {
            entry: stored.entry,
            value: decodeStoredGroupTopologyConfig(stored.value, ref),
        };
    }

    async findConfig(
        ref: GroupRef,
    ): Promise<StoredGroupTopologyConfig | undefined> {
        return (await this.findConfigEntry(ref))?.value;
    }

    async commitConfig(
        input: StoredGroupTopologyConfig,
        expectedRevision: number | null,
    ): Promise<GroupTopologyConfigCommitResult> {
        validateStoredGroupTopologyConfig(input, input.groupRef);
        const result = expectedRevision === null
            ? await this.putValueIfAbsent(
                GROUP_TOPOLOGY_CONFIG_NAMESPACE,
                this.configKey(input.groupRef),
                input,
                NEVER_EXPIRE_AT_TIMESTAMP,
            )
            : await this.putValueIfRevision(
                GROUP_TOPOLOGY_CONFIG_NAMESPACE,
                this.configKey(input.groupRef),
                input,
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
        return result.status === 'applied'
            ? { status: 'accepted' }
            : { status: 'conflict' };
    }

    async findOverrideEntry(
        ref: GroupRef,
    ): Promise<RuntimeStateEntryValue<StoredGroupTopologyOverride> | undefined> {
        const stored = await this.getEntryValue<StoredGroupTopologyOverride>(
            GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
            this.overrideKey(ref),
        );
        if (!stored) return undefined;
        return {
            entry: stored.entry,
            value: decodeStoredGroupTopologyOverride(stored.value, ref),
        };
    }

    async findOverride(
        ref: GroupRef,
    ): Promise<StoredGroupTopologyOverride | undefined> {
        return (await this.findOverrideEntry(ref))?.value;
    }

    async commitOverride(
        input: StoredGroupTopologyOverride,
        expectedRevision: number | null,
    ): Promise<GroupTopologyConfigCommitResult> {
        validateStoredGroupTopologyOverride(input, input.groupRef);
        const result = expectedRevision === null
            ? await this.putValueIfAbsent(
                GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
                this.overrideKey(input.groupRef),
                input,
                input.expiresAtEpochMs,
            )
            : await this.putValueIfRevision(
                GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
                this.overrideKey(input.groupRef),
                input,
                input.expiresAtEpochMs,
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
        return result.status === 'applied'
            ? { status: 'accepted' }
            : { status: 'conflict' };
    }

    async findMutationRecordEntry(
        ref: GroupRef,
        requestId: string,
    ): Promise<RuntimeStateEntryValue<GroupTopologyConfigMutationRecord> | undefined> {
        const stored = await this.getEntryValue<GroupTopologyConfigMutationRecord>(
            GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
            this.mutationKey(ref, requestId),
        );
        if (stored) {
            validateGroupTopologyConfigMutationRecord(stored.value, {
                groupRef: ref,
                requestId,
            });
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
        const stored = await this.getEntryValue<GroupTopologyConfigGeneration>(
            GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
            this.generationKey(ref, target),
        );
        if (stored) validateGroupTopologyConfigGeneration(stored.value, ref, target);
        return stored;
    }

    async commitGeneration(
        input: GroupTopologyConfigGeneration,
        expectedRevision: number | null,
    ): Promise<GroupTopologyConfigCommitResult> {
        validateGroupTopologyConfigGeneration(input, input.groupRef, input.target);
        const result = expectedRevision === null
            ? await this.putValueIfAbsent(
                GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
                this.generationKey(input.groupRef, input.target),
                input,
                NEVER_EXPIRE_AT_TIMESTAMP,
            )
            : await this.putValueIfRevision(
                GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
                this.generationKey(input.groupRef, input.target),
                input,
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
        const stored = await this.getEntryValue<GroupTopologyConfigInvariantGeneration>(
            GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
            this.invariantGenerationKey(ref),
        );
        if (stored) {
            validateGroupTopologyConfigInvariantGeneration(stored.value, ref);
        }
        return stored;
    }

    async commitInvariantGeneration(
        input: GroupTopologyConfigInvariantGeneration,
        expectedRevision: number | null,
    ): Promise<GroupTopologyConfigCommitResult> {
        validateGroupTopologyConfigInvariantGeneration(input, input.groupRef);
        const result = expectedRevision === null
            ? await this.putValueIfAbsent(
                GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
                this.invariantGenerationKey(input.groupRef),
                input,
                NEVER_EXPIRE_AT_TIMESTAMP,
            )
            : await this.putValueIfRevision(
                GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
                this.invariantGenerationKey(input.groupRef),
                input,
                NEVER_EXPIRE_AT_TIMESTAMP,
                expectedRevision,
            );
        return result.status === 'applied'
            ? { status: 'accepted', storageRevision: result.revision }
            : { status: 'conflict' };
    }

    configKey(ref: GroupRef): string {
        return [this.scopeKey(ref), this.idKey('group', ref.groupId)].join(':');
    }

    overrideKey(ref: GroupRef): string {
        return [this.scopeKey(ref), this.idKey('group', ref.groupId)].join(':');
    }

    mutationKey(ref: GroupRef, requestId: string): string {
        return [
            this.scopeKey(ref),
            this.idKey('group', ref.groupId),
            this.idKey('request', requestId),
        ].join(':');
    }

    generationKey(
        ref: GroupRef,
        target: GroupTopologyConfigGenerationTarget,
    ): string {
        return [
            this.scopeKey(ref),
            this.idKey('group', ref.groupId),
            this.idKey('target', target),
        ].join(':');
    }

    invariantGenerationKey(ref: GroupRef): string {
        return [
            this.scopeKey(ref),
            this.idKey('group', ref.groupId),
            this.idKey('invariant', 'effective-config'),
        ].join(':');
    }
}

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

function decodeStoredGroupTopologyConfig(
    value: unknown,
    expectedRef: GroupRef,
): StoredGroupTopologyConfig {
    if (hasExactKeys(value, LEGACY_CONFIG_KEYS)) {
        const normalized = { ...value, requestId: null };
        validateStoredGroupTopologyConfig(normalized, expectedRef);
        return normalized;
    }
    validateStoredGroupTopologyConfig(value, expectedRef);
    return value;
}

function decodeStoredGroupTopologyOverride(
    value: unknown,
    expectedRef: GroupRef,
): StoredGroupTopologyOverride {
    if (hasExactKeys(value, LEGACY_OVERRIDE_KEYS)) {
        const normalized = { ...value, requestId: null };
        validateStoredGroupTopologyOverride(normalized, expectedRef);
        return normalized;
    }
    validateStoredGroupTopologyOverride(value, expectedRef);
    return value;
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
