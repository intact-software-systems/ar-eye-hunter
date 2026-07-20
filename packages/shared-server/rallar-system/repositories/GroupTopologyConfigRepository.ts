import type { GroupRef } from '@shared/api/group-types.ts';
import { DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import type {
    StoredGroupTopologyConfig,
    StoredGroupTopologyOverride,
} from '@shared/api/graph-topology-management-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/RuntimeStateJsonStore.ts';
import { RuntimeStateJsonStore } from '../../runtime-state/RuntimeStateJsonStore.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateEntryPageOptions,
    RuntimeStateRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import {
    decodeGroupStateGroupStorageKey,
    decodeGroupStateIdempotencyStorageKey,
    groupStateGroupStorageKey,
    groupStateIdempotencyStorageKey,
} from '../group-state-storage-keys.ts';
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

export type GroupTopologyConfigGenerationSourceEntry = Readonly<{
    entry: RuntimeStateEntry;
    source: GroupTopologyConfigGenerationSource;
    value: StoredGroupTopologyConfig | StoredGroupTopologyOverride;
}>;

export type GroupTopologyConfigLegacyKeyMigrationSource =
    GroupTopologyConfigGenerationSourceEntry & Readonly<{
        canonicalKey: string;
    }>;

export type GroupTopologyConfigLegacyKeyMigrationPage = Readonly<{
    sources: readonly GroupTopologyConfigLegacyKeyMigrationSource[];
    afterKey?: string;
    hasMore: boolean;
}>;

export class GroupTopologyConfigRepositoryInvariantCorruptionError extends Error {
    readonly code = 'group-topology-config-repository-invariant-corruption';

    constructor(readonly storageKey: string, message: string) {
        super(`${message}: ${storageKey}`);
        this.name = 'GroupTopologyConfigRepositoryInvariantCorruptionError';
    }
}

export class GroupTopologyConfigRepository extends RuntimeStateJsonStore {
    constructor(
        readonly runtimeRepository:
            RuntimeStateRepositoryLike,
    ) {
        super(runtimeRepository);
    }

    protected override async toLiveEntryValue<T>(
        namespace: string,
        entry: RuntimeStateEntry,
    ): Promise<RuntimeStateEntryValue<T> | undefined> {
        try {
            return await super.toLiveEntryValue<T>(namespace, entry);
        } catch (error) {
            if (error instanceof SyntaxError) {
                throw topologyConfigCorruption(
                    entry.key,
                    `Stored topology config JSON is invalid: ${error.message}`,
                );
            }
            throw error;
        }
    }

    async findConfigEntry(
        ref: GroupRef,
    ): Promise<RuntimeStateEntryValue<StoredGroupTopologyConfig> | undefined> {
        const key = this.configKey(ref);
        const raw = await this.runtimeRepository.findEntry(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            key,
        );
        if (!raw) return undefined;
        assertCanonicalTopologySourceEntry(raw, 'config', ref);
        const stored = await this.toLiveEntryValue<StoredGroupTopologyConfig>(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            raw,
        );
        if (!stored) return undefined;
        return toValidatedLiveTopologySourceEntry(stored, 'config', ref);
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
        const key = this.overrideKey(ref);
        const raw = await this.runtimeRepository.findEntry(
            GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
            key,
        );
        if (!raw) return undefined;
        assertCanonicalTopologySourceEntry(raw, 'override', ref);
        const stored = await this.toLiveEntryValue<StoredGroupTopologyOverride>(
            GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
            raw,
        );
        if (!stored) return undefined;
        return toValidatedLiveTopologySourceEntry(stored, 'override', ref);
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
        const raw = await this.runtimeRepository.findEntry(
            GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
            this.mutationKey(ref, requestId),
        );
        if (!raw) return undefined;
        decodeTopologyMutationEntry(raw, ref, requestId);
        assertRetainedTopologyEntry(raw, 'mutation record');
        const stored = await this.toLiveEntryValue<GroupTopologyConfigMutationRecord>(
            GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
            raw,
        );
        if (stored) {
            decodeTopologyMutationValue(
                stored.entry,
                stored.value,
                ref,
                requestId,
            );
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
        if (!raw) return undefined;
        decodeTopologyGenerationEntry(raw, ref, target);
        assertRetainedTopologyEntry(raw, 'target generation');
        const stored = await this.toLiveEntryValue<GroupTopologyConfigGeneration>(
            GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
            raw,
        );
        if (stored) {
            decodeTopologyGenerationValue(
                stored.entry,
                stored.value,
                ref,
                target,
            );
        }
        return stored;
    }

    async findGenerationSourceEntry(
        ref: GroupRef,
        target: GroupTopologyConfigGenerationTarget,
    ): Promise<GroupTopologyConfigGenerationSourceEntry | undefined> {
        const namespace = topologySourceNamespace(target);
        const entry = await this.runtimeRepository.findEntry(
            namespace,
            this.sourceKey(ref, target),
        );
        if (!entry) return undefined;
        return decodeCanonicalGenerationSourceEntry(entry, target, ref);
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
            topologySourceNamespace(target),
        );
        return entries.map((entry) =>
            decodeCanonicalGenerationSourceEntry(entry, target).source
        );
    }

    async listGenerationSourcesPage(
        target: GroupTopologyConfigGenerationTarget,
        options: RuntimeStateEntryPageOptions,
    ): Promise<readonly GroupTopologyConfigGenerationSourceEntry[]> {
        const entries = await this.listEntriesPage(
            topologySourceNamespace(target),
            '',
            options,
        );
        return entries.map((entry) =>
            decodeCanonicalGenerationSourceEntry(entry, target)
        );
    }

    async findLegacyKeyMigrationSource(
        ref: GroupRef,
        target: GroupTopologyConfigGenerationTarget,
    ): Promise<GroupTopologyConfigLegacyKeyMigrationSource | undefined> {
        const canonicalKey = this.sourceKey(ref, target);
        const legacyKey = legacyTopologySourceKey(ref);
        if (canonicalKey === legacyKey) return undefined;
        const entry = await this.runtimeRepository.findEntry(
            topologySourceNamespace(target),
            legacyKey,
        );
        if (!entry) return undefined;
        const migration = decodeLegacyKeyMigrationEntry(entry, target);
        if (!migration) return undefined;
        return sameTopologyGroupRef(migration.source.groupRef, ref)
            ? migration
            : undefined;
    }

    async listLegacyKeyMigrationSourcesPage(
        target: GroupTopologyConfigGenerationTarget,
        options: RuntimeStateEntryPageOptions,
    ): Promise<GroupTopologyConfigLegacyKeyMigrationPage> {
        const entries = await this.listEntriesPage(
            topologySourceNamespace(target),
            '',
            options,
        );
        return {
            sources: entries.map((entry) =>
                decodeLegacyKeyMigrationEntry(entry, target)
            ).filter((entry): entry is GroupTopologyConfigLegacyKeyMigrationSource =>
                entry !== undefined
            ),
            ...(entries.length === 0
                ? {}
                : { afterKey: entries[entries.length - 1]!.key }),
            hasMore: entries.length >= Math.max(1, Math.floor(options.limit)),
        };
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
        const raw = await this.runtimeRepository.findEntry(
            GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
            this.invariantGenerationKey(ref),
        );
        if (!raw) return undefined;
        decodeTopologyInvariantEntry(raw, ref);
        assertRetainedTopologyEntry(raw, 'invariant generation');
        const stored = await this.toLiveEntryValue<
            GroupTopologyConfigInvariantGeneration
        >(
            GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
            raw,
        );
        if (stored) {
            decodeTopologyInvariantValue(stored.entry, stored.value, ref);
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
        return groupStateGroupStorageKey(ref);
    }

    overrideKey(ref: GroupRef): string {
        return groupStateGroupStorageKey(ref);
    }

    mutationKey(ref: GroupRef, requestId: string): string {
        return groupStateIdempotencyStorageKey(ref, requestId);
    }

    generationKey(
        ref: GroupRef,
        target: GroupTopologyConfigGenerationTarget,
    ): string {
        return topologyChildKey(ref, 'target', target);
    }

    invariantGenerationKey(ref: GroupRef): string {
        return topologyChildKey(ref, 'invariant', 'effective-config');
    }

    private sourceKey(
        ref: GroupRef,
        target: GroupTopologyConfigGenerationTarget,
    ): string {
        return target === 'config' ? this.configKey(ref) : this.overrideKey(ref);
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

function topologySourceNamespace(
    target: GroupTopologyConfigGenerationTarget,
): string {
    return target === 'config'
        ? GROUP_TOPOLOGY_CONFIG_NAMESPACE
        : GROUP_TOPOLOGY_OVERRIDE_NAMESPACE;
}

function topologyChildKey(
    ref: GroupRef,
    name: string,
    value: string,
): string {
    return `${groupStateGroupStorageKey(ref)}:${name}=${encodeURIComponent(value)}`;
}

function legacyTopologySourceKey(ref: GroupRef): string {
    return [
        `app=${encodeURIComponent(ref.applicationId)}`,
        `ws=${encodeURIComponent(ref.workspaceId ?? '_')}`,
        `group=${encodeURIComponent(ref.groupId)}`,
    ].join(':');
}

function decodeTopologyGroupKey(storageKey: string): GroupRef {
    try {
        return decodeGroupStateGroupStorageKey(storageKey);
    } catch (error) {
        throw topologyConfigCorruption(
            storageKey,
            error instanceof Error
                ? error.message
                : 'Stored topology config group key is invalid',
        );
    }
}

function decodeTopologyMutationKey(
    storageKey: string,
): GroupRef & Readonly<{ requestId: string }> {
    try {
        return decodeGroupStateIdempotencyStorageKey(storageKey);
    } catch (error) {
        throw topologyConfigCorruption(
            storageKey,
            error instanceof Error
                ? error.message
                : 'Stored topology config mutation key is invalid',
        );
    }
}

function decodeTopologyGenerationKey(
    storageKey: string,
): GroupRef & Readonly<{ target: GroupTopologyConfigGenerationTarget }> {
    const decoded = decodeTopologyChildKey(storageKey, 'target');
    if (decoded.value !== 'config' && decoded.value !== 'override') {
        throw topologyConfigCorruption(
            storageKey,
            'Stored topology config generation target is invalid',
        );
    }
    return { ...decoded.groupRef, target: decoded.value };
}

function decodeTopologyInvariantGenerationKey(storageKey: string): GroupRef {
    const decoded = decodeTopologyChildKey(storageKey, 'invariant');
    if (decoded.value !== 'effective-config') {
        throw topologyConfigCorruption(
            storageKey,
            'Stored topology config invariant slot is invalid',
        );
    }
    return decoded.groupRef;
}

function assertTopologyMutationSlot(
    storageKey: string,
    trustedRef: GroupRef,
    trustedRequestId: string,
): GroupRef & Readonly<{ requestId: string }> {
    const decoded = decodeTopologyMutationKey(storageKey);
    assertTopologyGroupRef(
        decoded,
        trustedRef,
        storageKey,
        'requested mutation slot',
    );
    if (decoded.requestId !== trustedRequestId) {
        throw topologyConfigCorruption(
            storageKey,
            'Stored topology config request differs from the requested slot',
        );
    }
    return decoded;
}

function assertTopologyGenerationSlot(
    storageKey: string,
    trustedRef: GroupRef,
    trustedTarget: GroupTopologyConfigGenerationTarget,
): GroupRef & Readonly<{ target: GroupTopologyConfigGenerationTarget }> {
    const decoded = decodeTopologyGenerationKey(storageKey);
    assertTopologyGroupRef(
        decoded,
        trustedRef,
        storageKey,
        'requested generation slot',
    );
    if (decoded.target !== trustedTarget) {
        throw topologyConfigCorruption(
            storageKey,
            'Stored topology config generation target differs from the requested slot',
        );
    }
    return decoded;
}

function assertTopologyInvariantSlot(
    storageKey: string,
    trustedRef: GroupRef,
): GroupRef {
    const decoded = decodeTopologyInvariantGenerationKey(storageKey);
    assertTopologyGroupRef(
        decoded,
        trustedRef,
        storageKey,
        'requested invariant-generation slot',
    );
    return decoded;
}

function decodeTopologyMutationEntry(
    entry: RuntimeStateEntry,
    trustedRef: GroupRef,
    trustedRequestId: string,
): GroupTopologyConfigMutationRecord {
    return decodeTopologyMutationValue(
        entry,
        parseTopologyEntryValue(entry),
        trustedRef,
        trustedRequestId,
    );
}

function decodeTopologyMutationValue(
    entry: RuntimeStateEntry,
    value: unknown,
    trustedRef: GroupRef,
    trustedRequestId: string,
): GroupTopologyConfigMutationRecord {
    const decoded = assertTopologyMutationSlot(
        entry.key,
        trustedRef,
        trustedRequestId,
    );
    validateTopologyBoundary(entry.key, () => {
        validateGroupTopologyConfigMutationRecord(value, {
            groupRef: decoded,
            requestId: decoded.requestId,
        });
    });
    const record = value as GroupTopologyConfigMutationRecord;
    assertTopologyGroupRef(
        record.groupRef,
        decoded,
        entry.key,
        'mutation value',
    );
    return record;
}

function decodeTopologyGenerationEntry(
    entry: RuntimeStateEntry,
    trustedRef: GroupRef,
    trustedTarget: GroupTopologyConfigGenerationTarget,
): GroupTopologyConfigGeneration {
    return decodeTopologyGenerationValue(
        entry,
        parseTopologyEntryValue(entry),
        trustedRef,
        trustedTarget,
    );
}

function decodeTopologyGenerationValue(
    entry: RuntimeStateEntry,
    value: unknown,
    trustedRef: GroupRef,
    trustedTarget: GroupTopologyConfigGenerationTarget,
): GroupTopologyConfigGeneration {
    const decoded = assertTopologyGenerationSlot(
        entry.key,
        trustedRef,
        trustedTarget,
    );
    validateTopologyBoundary(entry.key, () => {
        validateGroupTopologyConfigGeneration(value, decoded, decoded.target);
    });
    const generation = value as GroupTopologyConfigGeneration;
    assertTopologyGroupRef(
        generation.groupRef,
        decoded,
        entry.key,
        'generation value',
    );
    return generation;
}

function decodeTopologyInvariantEntry(
    entry: RuntimeStateEntry,
    trustedRef: GroupRef,
): GroupTopologyConfigInvariantGeneration {
    return decodeTopologyInvariantValue(
        entry,
        parseTopologyEntryValue(entry),
        trustedRef,
    );
}

function decodeTopologyInvariantValue(
    entry: RuntimeStateEntry,
    value: unknown,
    trustedRef: GroupRef,
): GroupTopologyConfigInvariantGeneration {
    const decoded = assertTopologyInvariantSlot(entry.key, trustedRef);
    validateTopologyBoundary(entry.key, () => {
        validateGroupTopologyConfigInvariantGeneration(value, decoded);
    });
    const generation = value as GroupTopologyConfigInvariantGeneration;
    assertTopologyGroupRef(
        generation.groupRef,
        decoded,
        entry.key,
        'invariant-generation value',
    );
    return generation;
}

function parseTopologyEntryValue(entry: RuntimeStateEntry): unknown {
    return validateTopologyBoundary(entry.key, () => JSON.parse(entry.value));
}

function assertRetainedTopologyEntry(
    entry: RuntimeStateEntry,
    label: string,
): void {
    if (entry.expireAtTimestamp !== NEVER_EXPIRE_AT_TIMESTAMP) {
        throw topologyConfigCorruption(
            entry.key,
            `Stored topology config ${label} must not expire`,
        );
    }
}

function decodeTopologyChildKey(
    storageKey: string,
    name: string,
): Readonly<{ groupRef: GroupRef; value: string }> {
    const parts = storageKey.split(':');
    if (parts.length !== 4) {
        throw topologyConfigCorruption(
            storageKey,
            `Stored topology config ${name} key has invalid arity`,
        );
    }
    const groupRef = decodeTopologyGroupKey(parts.slice(0, 3).join(':'));
    const prefix = `${name}=`;
    if (!parts[3]?.startsWith(prefix)) {
        throw topologyConfigCorruption(
            storageKey,
            `Stored topology config key is missing ${name}`,
        );
    }
    let value: string;
    try {
        value = decodeURIComponent(parts[3].slice(prefix.length));
    } catch {
        throw topologyConfigCorruption(
            storageKey,
            `Stored topology config key has invalid ${name} encoding`,
        );
    }
    if (topologyChildKey(groupRef, name, value) !== storageKey) {
        throw topologyConfigCorruption(
            storageKey,
            `Stored topology config ${name} key is not canonical`,
        );
    }
    return { groupRef, value };
}

function decodeCanonicalGenerationSourceEntry(
    entry: RuntimeStateEntry,
    target: GroupTopologyConfigGenerationTarget,
    trustedRef?: GroupRef,
): GroupTopologyConfigGenerationSourceEntry {
    const decoded = decodeTopologyGroupKey(entry.key);
    if (trustedRef) {
        assertTopologyGroupRef(
            decoded,
            trustedRef,
            entry.key,
            'requested generation-source slot',
        );
    }
    const value = decodeTopologySourceValue(entry, target, decoded);
    assertTopologyGroupRef(
        value.groupRef,
        decoded,
        entry.key,
        'generation-source value',
    );
    return {
        entry,
        source: { groupRef: decoded, target, version: value.version },
        value,
    };
}

function assertCanonicalTopologySourceEntry(
    entry: RuntimeStateEntry,
    target: GroupTopologyConfigGenerationTarget,
    trustedRef: GroupRef,
): void {
    decodeCanonicalGenerationSourceEntry(entry, target, trustedRef);
}

function toValidatedLiveTopologySourceEntry(
    stored: RuntimeStateEntryValue<StoredGroupTopologyConfig>,
    target: 'config',
    trustedRef: GroupRef,
): RuntimeStateEntryValue<StoredGroupTopologyConfig>;
function toValidatedLiveTopologySourceEntry(
    stored: RuntimeStateEntryValue<StoredGroupTopologyOverride>,
    target: 'override',
    trustedRef: GroupRef,
): RuntimeStateEntryValue<StoredGroupTopologyOverride>;
function toValidatedLiveTopologySourceEntry(
    stored: RuntimeStateEntryValue<
        StoredGroupTopologyConfig | StoredGroupTopologyOverride
    >,
    target: GroupTopologyConfigGenerationTarget,
    trustedRef: GroupRef,
): RuntimeStateEntryValue<StoredGroupTopologyConfig | StoredGroupTopologyOverride> {
    const entry = {
        ...stored.entry,
        value: JSON.stringify(stored.value),
    };
    const validated = decodeCanonicalGenerationSourceEntry(
        entry,
        target,
        trustedRef,
    );
    return { entry: stored.entry, value: validated.value };
}

function decodeLegacyKeyMigrationEntry(
    entry: RuntimeStateEntry,
    target: GroupTopologyConfigGenerationTarget,
): GroupTopologyConfigLegacyKeyMigrationSource | undefined {
    const value = decodeTopologySourceValue(entry, target);
    const canonicalKey = groupStateGroupStorageKey(value.groupRef);
    if (entry.key === canonicalKey) {
        const decoded = decodeTopologyGroupKey(entry.key);
        assertTopologyGroupRef(
            value.groupRef,
            decoded,
            entry.key,
            'generation-source value',
        );
        return undefined;
    }
    if (entry.key !== legacyTopologySourceKey(value.groupRef)) {
        throw topologyConfigCorruption(
            entry.key,
            'Stored topology config legacy key differs from its value',
        );
    }
    return {
        entry,
        canonicalKey,
        source: {
            groupRef: value.groupRef,
            target,
            version: value.version,
        },
        value,
    };
}

function decodeTopologySourceValue(
    entry: RuntimeStateEntry,
    target: GroupTopologyConfigGenerationTarget,
    expectedRef?: GroupRef,
): StoredGroupTopologyConfig | StoredGroupTopologyOverride {
    let parsed: unknown;
    try {
        parsed = JSON.parse(entry.value);
    } catch (error) {
        throw topologyConfigCorruption(
            entry.key,
            `Stored topology config JSON is invalid: ${
                error instanceof Error ? error.message : 'invalid JSON'
            }`,
        );
    }
    const value = validateTopologyBoundary(entry.key, () => {
        const storedRef = storedTopologyGroupRef(parsed);
        if (expectedRef) {
            assertTopologyGroupRef(
                storedRef,
                expectedRef,
                entry.key,
                'generation-source value',
            );
        }
        return target === 'config'
            ? decodeStoredGroupTopologyConfig(parsed, storedRef)
            : decodeStoredGroupTopologyOverride(parsed, storedRef);
    });
    const expectedExpiry = target === 'config'
        ? NEVER_EXPIRE_AT_TIMESTAMP
        : (value as StoredGroupTopologyOverride).expiresAtEpochMs;
    if (entry.expireAtTimestamp !== expectedExpiry) {
        throw topologyConfigCorruption(
            entry.key,
            `Stored topology ${target} physical expiry differs from its value contract`,
        );
    }
    return value;
}

function validateTopologyBoundary<T>(
    storageKey: string,
    validate: () => T,
): T {
    try {
        return validate();
    } catch (error) {
        if (error instanceof GroupTopologyConfigRepositoryInvariantCorruptionError) {
            throw error;
        }
        throw topologyConfigCorruption(
            storageKey,
            error instanceof Error
                ? error.message
                : 'Stored topology config value is invalid',
        );
    }
}

function assertTopologyGroupRef(
    actual: GroupRef,
    expected: GroupRef,
    storageKey: string,
    slot: string,
): void {
    if (!sameTopologyGroupRef(actual, expected)) {
        throw topologyConfigCorruption(
            storageKey,
            `Stored topology config identity differs from the ${slot}`,
        );
    }
}

function sameTopologyGroupRef(left: GroupRef, right: GroupRef): boolean {
    return left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId &&
        left.groupId === right.groupId;
}

function topologyConfigCorruption(
    storageKey: string,
    message: string,
): GroupTopologyConfigRepositoryInvariantCorruptionError {
    return new GroupTopologyConfigRepositoryInvariantCorruptionError(
        storageKey,
        message,
    );
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
