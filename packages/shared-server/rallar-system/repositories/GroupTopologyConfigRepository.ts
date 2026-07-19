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

export type GroupTopologyConfigGenerationSource = Readonly<{
    groupRef: GroupRef;
    target: GroupTopologyConfigGenerationTarget;
    version: number;
}>;

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

    async findGenerationSource(
        ref: GroupRef,
        target: GroupTopologyConfigGenerationTarget,
    ): Promise<GroupTopologyConfigGenerationSource | undefined> {
        const namespace = target === 'config'
            ? GROUP_TOPOLOGY_CONFIG_NAMESPACE
            : GROUP_TOPOLOGY_OVERRIDE_NAMESPACE;
        const entry = await this.runtimeRepository.findEntry(
            namespace,
            target === 'config' ? this.configKey(ref) : this.overrideKey(ref),
        );
        if (!entry) return undefined;
        const value = target === 'config'
            ? decodeStoredGroupTopologyConfig(JSON.parse(entry.value), ref)
            : decodeStoredGroupTopologyOverride(JSON.parse(entry.value), ref);
        return { groupRef: value.groupRef, target, version: value.version };
    }

    async listGenerationSources(
        target: GroupTopologyConfigGenerationTarget,
    ): Promise<readonly GroupTopologyConfigGenerationSource[]> {
        const namespace = target === 'config'
            ? GROUP_TOPOLOGY_CONFIG_NAMESPACE
            : GROUP_TOPOLOGY_OVERRIDE_NAMESPACE;
        const entries = await this.runtimeRepository.findAllEntries(namespace);
        return entries.map((entry) => {
            const value = target === 'config'
                ? decodeStoredGroupTopologyConfig(JSON.parse(entry.value))
                : decodeStoredGroupTopologyOverride(JSON.parse(entry.value));
            const expectedKey = target === 'config'
                ? this.configKey(value.groupRef)
                : this.overrideKey(value.groupRef);
            if (entry.key !== expectedKey) {
                throw new TypeError('Stored topology config generation source has wrong key');
            }
            return { groupRef: value.groupRef, target, version: value.version };
        });
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
    expectedRef?: GroupRef,
): StoredGroupTopologyConfig {
    const normalized = hasExactKeys(value, LEGACY_CONFIG_KEYS)
        ? { ...value, requestId: null }
        : value;
    const validationRef = expectedRef ?? storedTopologyGroupRef(normalized);
    validateStoredGroupTopologyConfig(normalized, validationRef);
    return normalized;
}

function decodeStoredGroupTopologyOverride(
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

function storedTopologyGroupRef(value: unknown): GroupRef {
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
        typeof candidate.workspaceId !== 'string' ||
        candidate.workspaceId.trim().length === 0 ||
        typeof candidate.groupId !== 'string' ||
        candidate.groupId.trim().length === 0
    ) {
        throw new TypeError(
            'Stored topology config generation source groupRef is invalid',
        );
    }
    return {
        applicationId: candidate.applicationId,
        workspaceId: candidate.workspaceId,
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
