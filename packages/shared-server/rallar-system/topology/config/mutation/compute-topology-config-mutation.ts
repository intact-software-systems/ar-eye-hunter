import type {
    EffectiveGroupTopologyConfig,
    GroupTopologyConfigPatch,
    StoredGroupTopologyConfig,
    StoredGroupTopologyOverride
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RuntimeStateEntryValue } from '../../../../runtime-state/runtime-state-json-store.ts';
import { readDefaultGroupTopologyConfig, resolveGroupTopologyConfig } from '../group-topology-config.ts';
import type {
    GroupTopologyConfigGeneration,
    GroupTopologyConfigMutationComputed,
    TopologyConfigMutationInput,
    TopologyConfigWriteGuard
} from './group-topology-config-mutation-contracts.ts';
import { probeTopologyConfigMutationIdempotency } from './topology-config-mutation-idempotency.ts';
import {
    createTopologyConfigMutationRecord,
    createTopologyConfigNoOpReceipt,
    createTopologyConfigWriteResult
} from './topology-config-mutation-receipt.ts';
import {
    requireTopologyConfigPatch,
    validateTopologyConfigMutationInput
} from './validate-topology-config-mutation-input.ts';

export function computeTopologyConfigMutation(
    topologyMutation: TopologyConfigMutationInput
): GroupTopologyConfigMutationComputed {
    validateTopologyConfigMutationInput(topologyMutation);
    const idempotency = probeTopologyConfigMutationIdempotency(
        topologyMutation.command,
        topologyMutation.read,
        topologyMutation.facts.commandHash
    );
    if (idempotency.outcome !== 'miss') {
        return idempotency;
    }

    switch (topologyMutation.command.operation) {
        case 'putConfig':
            return computePutConfig(topologyMutation);
        case 'deleteConfig':
            return computeDelete(topologyMutation, 'config');
        case 'putOverride':
            return computePutOverride(topologyMutation);
        case 'deleteOverride':
            return computeDelete(topologyMutation, 'override');
    }
}

function computePutConfig(
    topologyMutation: TopologyConfigMutationInput
): GroupTopologyConfigMutationComputed {
    const { command, read, facts } = topologyMutation;
    const current = read.config;
    const generation = read.configGeneration;
    const config: StoredGroupTopologyConfig = {
        groupRef: copyGroupRef(command.aggregateRef),
        config: applyGroupTopologyConfigPatch({
            fallback: readDefaultGroupTopologyConfig(topologyMutation.serverDefaults),
            current: current?.value.config,
            patch: requireTopologyConfigPatch(command)
        }),
        version: nextTopologyConfigVersion(current?.value.version, generation),
        createdAtEpochMs: current?.value.createdAtEpochMs ?? facts.requestedAtEpochMs,
        updatedAtEpochMs: Math.max(
            facts.requestedAtEpochMs,
            current?.value.updatedAtEpochMs ?? facts.requestedAtEpochMs
        ),
        updatedByPrincipalId: command.input.updatedByPrincipalId,
        requestId: command.requestId
    };
    resolveGroupTopologyConfig({ serverOptions: topologyMutation.serverDefaults, durable: config });
    if (read.override) {
        resolveGroupTopologyConfig({
            serverOptions: topologyMutation.serverDefaults,
            durable: config,
            temporary: read.override.value
        });
    }
    return createTopologyConfigWriteResult({
        command,
        read,
        facts,
        guard: {
            target: 'config',
            operation: current ? 'update' : 'insert',
            expectedRevision: current?.entry.revision ?? null,
            value: config
        },
        currentGeneration: generation,
        acceptedVersion: config.version,
        acceptedStorageRevision: current ? current.entry.revision + 1 : 0
    });
}

function computePutOverride(
    topologyMutation: TopologyConfigMutationInput
): GroupTopologyConfigMutationComputed {
    const { command, read, facts } = topologyMutation;
    const current = read.override;
    const generation = read.overrideGeneration;
    if (facts.resolvedOverrideExpiresAtEpochMs === null) {
        throw new TypeError('Topology override expiry fact is required');
    }
    const override: StoredGroupTopologyOverride = {
        groupRef: copyGroupRef(command.aggregateRef),
        config: applyGroupTopologyConfigPatch({
            fallback: read.config?.value.config ??
                readDefaultGroupTopologyConfig(topologyMutation.serverDefaults),
            current: current?.value.config,
            patch: requireTopologyConfigPatch(command)
        }),
        version: nextTopologyConfigVersion(current?.value.version, generation),
        createdAtEpochMs: current?.value.createdAtEpochMs ?? facts.requestedAtEpochMs,
        updatedAtEpochMs: Math.max(
            facts.requestedAtEpochMs,
            current?.value.updatedAtEpochMs ?? facts.requestedAtEpochMs
        ),
        updatedByPrincipalId: command.input.updatedByPrincipalId,
        requestId: command.requestId,
        expiresAtEpochMs: facts.resolvedOverrideExpiresAtEpochMs
    };
    resolveGroupTopologyConfig({
        serverOptions: topologyMutation.serverDefaults,
        durable: read.config?.value,
        temporary: override
    });
    return createTopologyConfigWriteResult({
        command,
        read,
        facts,
        guard: {
            target: 'override',
            operation: current ? 'update' : 'insert',
            expectedRevision: current?.entry.revision ?? null,
            value: override
        },
        currentGeneration: generation,
        acceptedVersion: override.version,
        acceptedStorageRevision: current ? current.entry.revision + 1 : 0
    });
}

function computeDelete(
    topologyMutation: TopologyConfigMutationInput,
    target: 'config' | 'override'
): GroupTopologyConfigMutationComputed {
    const current = target === 'config' ? topologyMutation.read.config : topologyMutation.read.override;
    const generation = target === 'config'
        ? topologyMutation.read.configGeneration
        : topologyMutation.read.overrideGeneration;
    if (!current) {
        return computeAbsentDelete(topologyMutation, target, generation);
    }

    resolveGroupTopologyConfig({
        serverOptions: topologyMutation.serverDefaults,
        durable: target === 'config' ? undefined : topologyMutation.read.config?.value,
        temporary: target === 'override' ? undefined : topologyMutation.read.override?.value
    });
    const guard: TopologyConfigWriteGuard = target === 'config'
        ? {
            target: 'config',
            operation: 'delete',
            expectedRevision: current.entry.revision,
            value: null
        }
        : {
            target: 'override',
            operation: 'delete',
            expectedRevision: current.entry.revision,
            value: null
        };
    return createTopologyConfigWriteResult({
        ...topologyMutation,
        guard,
        currentGeneration: generation,
        acceptedVersion: Math.max(current.value.version, generation?.value.version ?? 0) + 1,
        acceptedStorageRevision: current.entry.revision
    });
}

function computeAbsentDelete(
    topologyMutation: TopologyConfigMutationInput,
    target: 'config' | 'override',
    generation: RuntimeStateEntryValue<GroupTopologyConfigGeneration> | null
): GroupTopologyConfigMutationComputed {
    const receipt = createTopologyConfigNoOpReceipt({
        command: topologyMutation.command,
        facts: topologyMutation.facts,
        target,
        acceptedVersion: generation?.value.version ?? 0
    });
    const result = { kind: 'delete', deleted: false } as const;
    if (topologyMutation.command.requestId === null) {
        return { outcome: 'no-op', receipt, result };
    }
    const idempotency = createTopologyConfigMutationRecord(
        topologyMutation.command,
        topologyMutation.facts,
        receipt
    );
    if (idempotency === null) {
        throw new TypeError('Topology config claim idempotency is required');
    }
    return {
        outcome: 'claim',
        groupAuthorityGuard: topologyMutation.read.groupAuthorityGuard,
        receipt,
        result,
        idempotency
    };
}

function nextTopologyConfigVersion(
    currentVersion: number | undefined,
    generation: RuntimeStateEntryValue<GroupTopologyConfigGeneration> | null
): number {
    return Math.max(currentVersion ?? 0, generation?.value.version ?? 0) + 1;
}

function applyGroupTopologyConfigPatch(input: {
    readonly fallback: EffectiveGroupTopologyConfig;
    readonly current: EffectiveGroupTopologyConfig | undefined;
    readonly patch: GroupTopologyConfigPatch;
}): EffectiveGroupTopologyConfig {
    const current = input.current ?? input.fallback;
    return {
        topologyKind: applyTopologyConfigField(
            input.patch.topologyKind,
            current.topologyKind,
            input.fallback.topologyKind
        ),
        degreeLimit: applyTopologyConfigField(
            input.patch.degreeLimit,
            current.degreeLimit,
            input.fallback.degreeLimit
        ),
        treeMinSize: applyTopologyConfigField(
            input.patch.treeMinSize,
            current.treeMinSize,
            input.fallback.treeMinSize
        ),
        meshMinSize: applyTopologyConfigField(
            input.patch.meshMinSize,
            current.meshMinSize,
            input.fallback.meshMinSize
        ),
        meshParamK: applyTopologyConfigField(
            input.patch.meshParamK,
            current.meshParamK,
            input.fallback.meshParamK
        )
    };
}

function applyTopologyConfigField<T>(patch: T | null | undefined, current: T, fallback: T): T {
    if (patch === undefined) {
        return current;
    }
    if (patch === null) {
        return fallback;
    }
    return patch;
}

function copyGroupRef(ref: GroupRef): GroupRef {
    return {
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        groupId: ref.groupId
    };
}
