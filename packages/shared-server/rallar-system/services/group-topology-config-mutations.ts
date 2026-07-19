import type {
    GroupTopologyConfigPatch,
    GroupTopologyConfigMutationOperation,
    GroupTopologyConfigMutationReceipt,
    StoredGroupTopologyConfig,
    StoredGroupTopologyOverride,
} from '@shared/api/graph-topology-management-types.ts';
export type {
    GroupTopologyConfigMutationOperation,
    GroupTopologyConfigMutationReceipt,
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/RuntimeStateJsonStore.ts';
import {
    canMutateActiveGroup,
    canUpdateGroupSnapshot,
    GroupPolicyDeniedError,
} from '../group-policy.ts';
import {
    type GroupTopologyServerOptions,
    resolveGroupTopologyConfig,
    resolveOverrideExpiresAtEpochMs,
    validateGroupTopologyConfigPatch,
} from './group-topology-config-service.ts';
import type {
    CreateStateMutationOutboxRecordInput,
} from '../repositories/StateMutationOutboxRepository.ts';
import {
    toStateMutationOutboxId,
} from '../repositories/StateMutationOutboxRepository.ts';

export type GroupTopologyConfigMutationCommand = Readonly<{
    operation: GroupTopologyConfigMutationOperation;
    aggregateRef: GroupRef;
    commandId: string;
    requestId: string | null;
    input: Readonly<{
        config: GroupTopologyConfigPatch | null;
        updatedByPrincipalId: string;
        ttlMs: number | null;
        expiresAtEpochMs: number | null;
    }>;
}>;

export type GroupTopologyConfigMutationRecord = Readonly<{
    groupRef: GroupRef;
    requestId: string;
    commandHash: string;
    receipt: GroupTopologyConfigMutationReceipt;
}>;

export type GroupTopologyConfigMutationAcceptedResult =
    | Readonly<{ kind: 'config'; config: StoredGroupTopologyConfig }>
    | Readonly<{ kind: 'override'; override: StoredGroupTopologyOverride }>
    | Readonly<{ kind: 'delete'; deleted: boolean }>;

export type GroupTopologyConfigGenerationTarget = 'config' | 'override';

export type GroupTopologyConfigGeneration = Readonly<{
    groupRef: GroupRef;
    target: GroupTopologyConfigGenerationTarget;
    version: number;
}>;

export type GroupTopologyConfigInvariantGeneration = Readonly<{
    groupRef: GroupRef;
    version: number;
}>;

export type GroupTopologyConfigMutationRead = Readonly<{
    config: RuntimeStateEntryValue<StoredGroupTopologyConfig> | null;
    override: RuntimeStateEntryValue<StoredGroupTopologyOverride> | null;
    configGeneration: RuntimeStateEntryValue<GroupTopologyConfigGeneration> | null;
    overrideGeneration: RuntimeStateEntryValue<GroupTopologyConfigGeneration> | null;
    invariantGeneration: RuntimeStateEntryValue<GroupTopologyConfigInvariantGeneration> | null;
    idempotency: RuntimeStateEntryValue<GroupTopologyConfigMutationRecord> | null;
    groupSnapshot: GroupSnapshot;
}>;

export type GroupTopologyConfigDeleteTarget = Readonly<{
    target: 'config' | 'override';
    storageRevision: number;
    version: number;
    updatedAtEpochMs: number;
    expiresAtEpochMs: number | null;
}>;

export type GroupTopologyConfigMutationStableFacts = Readonly<{
    requestedAtEpochMs: number;
    commandHash: string;
    isPlatformAdmin: boolean;
    resolvedOverrideExpiresAtEpochMs: number | null;
    deleteTarget: GroupTopologyConfigDeleteTarget | null;
}>;

export type GroupTopologyConfigMutationFacts =
    GroupTopologyConfigMutationStableFacts & Readonly<{
        policyNowEpochMs: number;
    }>;

export type GroupTopologyConfigOutboxInput = Extract<
    CreateStateMutationOutboxRecordInput,
    { kind: 'group' }
>;

type TopologyConfigWriteGuard =
    | Readonly<{
        target: 'config';
        operation: 'insert' | 'update';
        expectedRevision: number | null;
        value: StoredGroupTopologyConfig;
    }>
    | Readonly<{
        target: 'config';
        operation: 'delete';
        expectedRevision: number;
        value: null;
    }>
    | Readonly<{
        target: 'override';
        operation: 'insert' | 'update';
        expectedRevision: number | null;
        value: StoredGroupTopologyOverride;
    }>
    | Readonly<{
        target: 'override';
        operation: 'delete';
        expectedRevision: number;
        value: null;
    }>;

type TopologyConfigGenerationGuard = Readonly<{
    expectedRevision: number | null;
    value: GroupTopologyConfigGeneration;
}>;

type TopologyConfigInvariantGenerationGuard = Readonly<{
    expectedRevision: number | null;
    value: GroupTopologyConfigInvariantGeneration;
}>;

export type GroupTopologyConfigMutationComputed =
    | Readonly<{
        outcome: 'write';
        guard: TopologyConfigWriteGuard;
        invariantGenerationGuard: TopologyConfigInvariantGenerationGuard;
        generationGuard: TopologyConfigGenerationGuard;
        receipt: GroupTopologyConfigMutationReceipt;
        idempotency: GroupTopologyConfigMutationRecord | null;
        outbox: GroupTopologyConfigOutboxInput;
        result: GroupTopologyConfigMutationAcceptedResult;
    }>
    | Readonly<{
        outcome: 'claim';
        receipt: GroupTopologyConfigMutationReceipt;
        idempotency: GroupTopologyConfigMutationRecord;
        result: GroupTopologyConfigMutationAcceptedResult;
    }>
    | Readonly<{
        outcome: 'no-op';
        receipt: GroupTopologyConfigMutationReceipt;
        result: GroupTopologyConfigMutationAcceptedResult;
    }>
    | Readonly<{
        outcome: 'replay';
        receipt: GroupTopologyConfigMutationReceipt;
        result: GroupTopologyConfigMutationAcceptedResult;
    }>
    | Readonly<{
        outcome: 'idempotency-conflict';
        existingCommandHash: string;
        receivedCommandHash: string;
    }>;

export function computeTopologyConfigMutation(input: Readonly<{
    command: GroupTopologyConfigMutationCommand;
    read: GroupTopologyConfigMutationRead;
    facts: GroupTopologyConfigMutationFacts;
    serverDefaults: GroupTopologyServerOptions;
}>): GroupTopologyConfigMutationComputed {
    const { command, read, facts } = input;
    validateTopologyConfigCommand(command);
    validateTopologyConfigRead(read, command);
    validateTopologyConfigFacts(facts);
    validateTopologyConfigAuthority(read.groupSnapshot, command, facts);
    const idempotency = probeTopologyConfigMutationIdempotency(
        command,
        read,
        facts.commandHash,
    );
    if (idempotency.outcome !== 'miss') return idempotency;

    switch (command.operation) {
        case 'putConfig':
            return computePutConfig(input);
        case 'deleteConfig':
            return computeDelete(input, 'config');
        case 'putOverride':
            return computePutOverride(input);
        case 'deleteOverride':
            return computeDelete(input, 'override');
    }
}

export function validateTopologyConfigMutation(input: Readonly<{
    command: GroupTopologyConfigMutationCommand;
    read: GroupTopologyConfigMutationRead;
    facts: GroupTopologyConfigMutationFacts;
    serverDefaults: GroupTopologyServerOptions;
    computed: GroupTopologyConfigMutationComputed;
}>): void {
    validateTopologyConfigCommand(input.command);
    validateTopologyConfigRead(input.read, input.command);
    validateTopologyConfigFacts(input.facts);
    validateTopologyConfigAuthority(
        input.read.groupSnapshot,
        input.command,
        input.facts,
    );
    const canonical = computeTopologyConfigMutation(input);
    if (JSON.stringify(input.computed) !== JSON.stringify(canonical)) {
        throw new TypeError(
            `Topology config ${input.command.operation} mutation differs from its canonical deterministic projection`,
        );
    }
    if (
        input.computed.outcome === 'write' ||
        input.computed.outcome === 'claim'
    ) {
        if (input.computed.receipt.commandHash !== input.facts.commandHash) {
            throw new TypeError('Topology config receipt hash differs from facts');
        }
        if (input.computed.idempotency !== null) {
            validateGroupTopologyConfigMutationRecord(input.computed.idempotency, {
                groupRef: input.command.aggregateRef,
                requestId: input.command.requestId!,
            });
        }
    }
    if (input.computed.outcome === 'write') {
        if (input.computed.outbox.commandHash !== input.facts.commandHash) {
            throw new TypeError('Topology config outbox hash differs from facts');
        }
        if (
            input.computed.receipt.outboxId !==
                toStateMutationOutboxId(input.computed.outbox)
        ) {
            throw new TypeError('Topology config receipt outbox differs from intent');
        }
    }
}

export function probeTopologyConfigMutationIdempotency(
    command: GroupTopologyConfigMutationCommand,
    read: GroupTopologyConfigMutationRead,
    commandHash: string,
):
    | Readonly<{ outcome: 'miss' }>
    | Extract<GroupTopologyConfigMutationComputed, { outcome: 'replay' }>
    | Extract<GroupTopologyConfigMutationComputed, {
        outcome: 'idempotency-conflict';
    }> {
    if (!read.idempotency) return { outcome: 'miss' };
    const record = read.idempotency.value;
    validateGroupTopologyConfigMutationRecord(record, {
        groupRef: command.aggregateRef,
        requestId: command.requestId!,
    });
    if (record.commandHash !== commandHash) {
        return {
            outcome: 'idempotency-conflict',
            existingCommandHash: record.commandHash,
            receivedCommandHash: commandHash,
        };
    }
    if (record.receipt.operation !== command.operation) {
        throw new TypeError(
            'Topology config receipt operation differs from command',
        );
    }
    return {
        outcome: 'replay',
        receipt: record.receipt,
        result: resultFromTopologyConfigReceipt(command, record.receipt),
    };
}

export function validateTopologyConfigMutationIdempotency(
    command: GroupTopologyConfigMutationCommand,
    read: GroupTopologyConfigMutationRead,
    commandHash: string,
    authorityFacts: Readonly<{ isPlatformAdmin: boolean }>,
    computed: Exclude<
        GroupTopologyConfigMutationComputed,
        { outcome: 'write' | 'claim' | 'no-op' }
    >,
): void {
    validateTopologyConfigCommand(command);
    validateTopologyConfigRead(read, command);
    if (typeof authorityFacts.isPlatformAdmin !== 'boolean') {
        throw new TypeError('Topology config admin fact is invalid');
    }
    validateTopologyConfigAuthority(read.groupSnapshot, command, authorityFacts);
    const canonical = probeTopologyConfigMutationIdempotency(
        command,
        read,
        commandHash,
    );
    if (
        canonical.outcome === 'miss' ||
        JSON.stringify(canonical) !== JSON.stringify(computed)
    ) {
        throw new TypeError('Topology config idempotency result is not canonical');
    }
}

function computePutConfig(input: Readonly<{
    command: GroupTopologyConfigMutationCommand;
    read: GroupTopologyConfigMutationRead;
    facts: GroupTopologyConfigMutationFacts;
    serverDefaults: GroupTopologyServerOptions;
}>): GroupTopologyConfigMutationComputed {
    const { command, read, facts } = input;
    const current = read.config;
    const generation = read.configGeneration;
    const config: StoredGroupTopologyConfig = {
        groupRef: copyGroupRef(command.aggregateRef),
        config: normalizeGroupTopologyConfigPatch(command.input.config!),
        version: nextTopologyConfigVersion(current?.value.version, generation),
        createdAtEpochMs: current?.value.createdAtEpochMs ??
            facts.requestedAtEpochMs,
        updatedAtEpochMs: Math.max(
            facts.requestedAtEpochMs,
            current?.value.updatedAtEpochMs ?? facts.requestedAtEpochMs,
        ),
        updatedByPrincipalId: command.input.updatedByPrincipalId,
        requestId: command.requestId,
    };
    resolveGroupTopologyConfig({
        serverOptions: input.serverDefaults,
        durable: config,
    });
    if (read.override) {
        resolveGroupTopologyConfig({
            serverOptions: input.serverDefaults,
            durable: config,
            temporary: read.override.value,
        });
    }
    return writeResult(input, {
        target: 'config',
        operation: current ? 'update' : 'insert',
        expectedRevision: current?.entry.revision ?? null,
        value: config,
    }, generation, config.version, current ? current.entry.revision + 1 : 0);
}

function computePutOverride(input: Readonly<{
    command: GroupTopologyConfigMutationCommand;
    read: GroupTopologyConfigMutationRead;
    facts: GroupTopologyConfigMutationFacts;
    serverDefaults: GroupTopologyServerOptions;
}>): GroupTopologyConfigMutationComputed {
    const { command, read, facts } = input;
    const current = read.override;
    const generation = read.overrideGeneration;
    if (facts.resolvedOverrideExpiresAtEpochMs === null) {
        throw new TypeError('Topology override expiry fact is required');
    }
    const override: StoredGroupTopologyOverride = {
        groupRef: copyGroupRef(command.aggregateRef),
        config: normalizeGroupTopologyConfigPatch(command.input.config!),
        version: nextTopologyConfigVersion(current?.value.version, generation),
        createdAtEpochMs: current?.value.createdAtEpochMs ??
            facts.requestedAtEpochMs,
        updatedAtEpochMs: Math.max(
            facts.requestedAtEpochMs,
            current?.value.updatedAtEpochMs ?? facts.requestedAtEpochMs,
        ),
        updatedByPrincipalId: command.input.updatedByPrincipalId,
        requestId: command.requestId,
        expiresAtEpochMs: facts.resolvedOverrideExpiresAtEpochMs,
    };
    resolveGroupTopologyConfig({
        serverOptions: input.serverDefaults,
        durable: read.config?.value,
        temporary: override,
    });
    return writeResult(input, {
        target: 'override',
        operation: current ? 'update' : 'insert',
        expectedRevision: current?.entry.revision ?? null,
        value: override,
    }, generation, override.version, current ? current.entry.revision + 1 : 0);
}

function computeDelete(
    input: Readonly<{
        command: GroupTopologyConfigMutationCommand;
        read: GroupTopologyConfigMutationRead;
        facts: GroupTopologyConfigMutationFacts;
        serverDefaults: GroupTopologyServerOptions;
    }>,
    target: 'config' | 'override',
): GroupTopologyConfigMutationComputed {
    const current = target === 'config' ? input.read.config : input.read.override;
    const generation = target === 'config'
        ? input.read.configGeneration
        : input.read.overrideGeneration;
    const deleteTarget = input.facts.deleteTarget;
    const targetStillCurrent = Boolean(
        current &&
        deleteTarget &&
        deleteTarget.target === target &&
        current.entry.revision === deleteTarget.storageRevision &&
        current.value.version === deleteTarget.version &&
        current.value.updatedAtEpochMs === deleteTarget.updatedAtEpochMs &&
        (target === 'config' ||
            (current.value as StoredGroupTopologyOverride).expiresAtEpochMs ===
                deleteTarget.expiresAtEpochMs),
    );
    if (!targetStillCurrent) {
        const receipt = receiptFor(input.command, input.facts, {
            target,
            outcome: 'no-op',
            acceptedVersion: Math.max(
                current?.value.version ?? 0,
                deleteTarget?.version ?? 0,
                generation?.value.version ?? 0,
            ),
            acceptedStorageRevision: current?.entry.revision ?? null,
            acceptedCreatedAtEpochMs: null,
            acceptedUpdatedAtEpochMs: null,
            acceptedExpiresAtEpochMs: null,
            outboxId: null,
        });
        const result = { kind: 'delete', deleted: false } as const;
        if (input.command.requestId === null) {
            return { outcome: 'no-op', receipt, result };
        }
        return {
            outcome: 'claim',
            receipt,
            result,
            idempotency: recordFor(input.command, input.facts, receipt)!,
        };
    }
    resolveGroupTopologyConfig({
        serverOptions: input.serverDefaults,
        durable: target === 'config' ? undefined : input.read.config?.value,
        temporary: target === 'override' ? undefined : input.read.override?.value,
    });
    return writeResult(input, {
        target,
        operation: 'delete',
        expectedRevision: current!.entry.revision,
        value: null,
    } as TopologyConfigWriteGuard, generation, Math.max(
        current!.value.version,
        generation?.value.version ?? 0,
    ) + 1, current!.entry.revision);
}

function writeResult(
    input: Readonly<{
        command: GroupTopologyConfigMutationCommand;
        read: GroupTopologyConfigMutationRead;
        facts: GroupTopologyConfigMutationFacts;
    }>,
    guard: TopologyConfigWriteGuard,
    currentGeneration: RuntimeStateEntryValue<GroupTopologyConfigGeneration> | null,
    acceptedVersion: number,
    acceptedStorageRevision: number,
): Extract<GroupTopologyConfigMutationComputed, { outcome: 'write' }> {
    const accepted = input.read.groupSnapshot;
    const outbox: GroupTopologyConfigOutboxInput = {
        kind: 'group',
        aggregateRef: copyGroupRef(input.command.aggregateRef),
        commandId: input.command.commandId,
        commandHash: input.facts.commandHash,
        createdAtEpochMs: input.facts.requestedAtEpochMs,
        acceptedCausalRevision: {
            kind: 'group',
            stateRevision: accepted.stateRevision,
            snapshotVersion: accepted.group.snapshotVersion,
            metadataVersion: accepted.group.metadataVersion,
            rosterVersion: accepted.group.rosterVersion,
            presenceVersion: accepted.group.presenceVersion,
        },
        effects: ['rtc-topology-recompute'],
        event: { kind: 'none' },
    };
    const acceptedValue = guard.operation === 'delete' ? null : guard.value;
    const receipt = receiptFor(input.command, input.facts, {
        target: guard.target,
        outcome: 'applied',
        acceptedVersion,
        acceptedStorageRevision,
        acceptedCreatedAtEpochMs: acceptedValue?.createdAtEpochMs ?? null,
        acceptedUpdatedAtEpochMs: acceptedValue?.updatedAtEpochMs ?? null,
        acceptedExpiresAtEpochMs: guard.operation !== 'delete' &&
                guard.target === 'override'
            ? guard.value.expiresAtEpochMs
            : null,
        outboxId: toStateMutationOutboxId(outbox),
    });
    const result: GroupTopologyConfigMutationAcceptedResult =
        guard.operation === 'delete'
            ? { kind: 'delete', deleted: true }
            : guard.target === 'config'
            ? { kind: 'config', config: guard.value }
            : { kind: 'override', override: guard.value };
    return {
        outcome: 'write',
        guard,
        invariantGenerationGuard: {
            expectedRevision: input.read.invariantGeneration?.entry.revision ?? null,
            value: {
                groupRef: copyGroupRef(input.command.aggregateRef),
                version: (input.read.invariantGeneration?.value.version ?? 0) + 1,
            },
        },
        generationGuard: {
            expectedRevision: currentGeneration?.entry.revision ?? null,
            value: {
                groupRef: copyGroupRef(input.command.aggregateRef),
                target: guard.target,
                version: acceptedVersion,
            },
        },
        receipt,
        idempotency: recordFor(input.command, input.facts, receipt),
        outbox,
        result,
    };
}

function nextTopologyConfigVersion(
    currentVersion: number | undefined,
    generation: RuntimeStateEntryValue<GroupTopologyConfigGeneration> | null,
): number {
    return Math.max(currentVersion ?? 0, generation?.value.version ?? 0) + 1;
}

function receiptFor(
    command: GroupTopologyConfigMutationCommand,
    facts: GroupTopologyConfigMutationFacts,
    input: Pick<
        GroupTopologyConfigMutationReceipt,
        | 'target'
        | 'outcome'
        | 'acceptedVersion'
        | 'acceptedStorageRevision'
        | 'acceptedCreatedAtEpochMs'
        | 'acceptedUpdatedAtEpochMs'
        | 'acceptedExpiresAtEpochMs'
        | 'outboxId'
    >,
): GroupTopologyConfigMutationReceipt {
    return {
        commandId: command.commandId,
        commandHash: facts.commandHash,
        operation: command.operation,
        outcome: input.outcome,
        groupRef: copyGroupRef(command.aggregateRef),
        target: input.target,
        acceptedVersion: input.acceptedVersion,
        acceptedStorageRevision: input.acceptedStorageRevision,
        acceptedCreatedAtEpochMs: input.acceptedCreatedAtEpochMs,
        acceptedUpdatedAtEpochMs: input.acceptedUpdatedAtEpochMs,
        acceptedExpiresAtEpochMs: input.acceptedExpiresAtEpochMs,
        outboxId: input.outboxId,
    };
}

function recordFor(
    command: GroupTopologyConfigMutationCommand,
    facts: GroupTopologyConfigMutationFacts,
    receipt: GroupTopologyConfigMutationReceipt,
): GroupTopologyConfigMutationRecord | null {
    return command.requestId === null ? null : {
        groupRef: copyGroupRef(command.aggregateRef),
        requestId: command.requestId,
        commandHash: facts.commandHash,
        receipt,
    };
}

function resultFromTopologyConfigReceipt(
    command: GroupTopologyConfigMutationCommand,
    receipt: GroupTopologyConfigMutationReceipt,
): GroupTopologyConfigMutationAcceptedResult {
    if (receipt.operation === 'putConfig') {
        return {
            kind: 'config',
            config: {
                groupRef: copyGroupRef(command.aggregateRef),
                config: normalizeGroupTopologyConfigPatch(command.input.config!),
                version: receipt.acceptedVersion,
                createdAtEpochMs: receipt.acceptedCreatedAtEpochMs!,
                updatedAtEpochMs: receipt.acceptedUpdatedAtEpochMs!,
                updatedByPrincipalId: command.input.updatedByPrincipalId,
                requestId: command.requestId,
            },
        };
    }
    if (receipt.operation === 'putOverride') {
        return {
            kind: 'override',
            override: {
                groupRef: copyGroupRef(command.aggregateRef),
                config: normalizeGroupTopologyConfigPatch(command.input.config!),
                version: receipt.acceptedVersion,
                createdAtEpochMs: receipt.acceptedCreatedAtEpochMs!,
                updatedAtEpochMs: receipt.acceptedUpdatedAtEpochMs!,
                updatedByPrincipalId: command.input.updatedByPrincipalId,
                requestId: command.requestId,
                expiresAtEpochMs: receipt.acceptedExpiresAtEpochMs!,
            },
        };
    }
    return {
        kind: 'delete',
        deleted: receipt.outcome === 'applied',
    };
}

function validateTopologyConfigAuthority(
    snapshot: GroupSnapshot,
    command: GroupTopologyConfigMutationCommand,
    facts: Readonly<{ isPlatformAdmin: boolean; policyNowEpochMs?: number }>,
): void {
    const lifecyclePolicy = canMutateActiveGroup({
        group: snapshot.group,
        nowEpochMs: facts.policyNowEpochMs,
    });
    if (!lifecyclePolicy.allowed) throw new GroupPolicyDeniedError(lifecyclePolicy);
    if (facts.isPlatformAdmin) return;
    const policy = canUpdateGroupSnapshot({
        snapshot,
        actor: { principalId: command.input.updatedByPrincipalId },
        nowEpochMs: facts.policyNowEpochMs,
    });
    if (!policy.allowed) throw new GroupPolicyDeniedError(policy);
}

function validateTopologyConfigCommand(
    command: GroupTopologyConfigMutationCommand,
): void {
    if (!command || typeof command !== 'object' || 'commandHash' in command) {
        throw new TypeError('Topology config command is invalid');
    }
    if (!['putConfig', 'deleteConfig', 'putOverride', 'deleteOverride'].includes(
        command.operation,
    )) {
        throw new TypeError('Topology config operation is invalid');
    }
    validateGroupRef(command.aggregateRef, 'Topology config command groupRef');
    requireString(command.commandId, 'Topology config commandId');
    if (command.requestId !== null) {
        requireString(command.requestId, 'Topology config requestId');
    }
    requireString(
        command.input.updatedByPrincipalId,
        'Topology config updated principal',
    );
    const isPut = command.operation === 'putConfig' ||
        command.operation === 'putOverride';
    if (isPut) validateGroupTopologyConfigPatch(command.input.config!);
    if (isPut !== (command.input.config !== null)) {
        throw new TypeError('Topology config command patch does not match operation');
    }
}

function validateTopologyConfigRead(
    read: GroupTopologyConfigMutationRead,
    command: GroupTopologyConfigMutationCommand,
): void {
    if (!sameGroupRef(read.groupSnapshot.group, command.aggregateRef)) {
        throw new TypeError('Topology config group snapshot has the wrong scope');
    }
    if (read.config) {
        validateStoredGroupTopologyConfig(read.config.value, command.aggregateRef);
        validateStorageRevision(read.config.entry.revision, 'config');
    }
    if (read.override) {
        validateStoredGroupTopologyOverride(read.override.value, command.aggregateRef);
        validateStorageRevision(read.override.entry.revision, 'override');
    }
    if (read.configGeneration) {
        validateGroupTopologyConfigGeneration(
            read.configGeneration.value,
            command.aggregateRef,
            'config',
        );
        validateStorageRevision(read.configGeneration.entry.revision, 'config generation');
    }
    if (read.overrideGeneration) {
        validateGroupTopologyConfigGeneration(
            read.overrideGeneration.value,
            command.aggregateRef,
            'override',
        );
        validateStorageRevision(
            read.overrideGeneration.entry.revision,
            'override generation',
        );
    }
    if (read.invariantGeneration) {
        validateGroupTopologyConfigInvariantGeneration(
            read.invariantGeneration.value,
            command.aggregateRef,
        );
        validateStorageRevision(
            read.invariantGeneration.entry.revision,
            'topology config invariant generation',
        );
    }
    if (read.idempotency) {
        if (command.requestId === null) {
            throw new TypeError('Topology config command without requestId read a claim');
        }
        validateGroupTopologyConfigMutationRecord(read.idempotency.value, {
            groupRef: command.aggregateRef,
            requestId: command.requestId,
        });
        validateStorageRevision(read.idempotency.entry.revision, 'idempotency');
    }
}

export function validateGroupTopologyConfigGeneration(
    value: unknown,
    expectedRef: GroupRef,
    expectedTarget: GroupTopologyConfigGenerationTarget,
): asserts value is GroupTopologyConfigGeneration {
    if (!isRecord(value)) {
        throw new TypeError('Topology config generation is invalid');
    }
    validateExactKeys(
        value,
        ['groupRef', 'target', 'version'],
        'Topology config generation',
    );
    validateGroupRef(value.groupRef, 'Topology config generation groupRef');
    if (!sameGroupRef(value.groupRef as GroupRef, expectedRef)) {
        throw new TypeError('Topology config generation has the wrong groupRef');
    }
    if (value.target !== expectedTarget) {
        throw new TypeError('Topology config generation has the wrong target');
    }
    validatePositiveInteger(value.version, 'Topology config generation version');
}

export function validateGroupTopologyConfigInvariantGeneration(
    value: unknown,
    expectedRef: GroupRef,
): asserts value is GroupTopologyConfigInvariantGeneration {
    if (!isRecord(value)) {
        throw new TypeError('Topology config invariant generation is invalid');
    }
    validateExactKeys(
        value,
        ['groupRef', 'version'],
        'Topology config invariant generation',
    );
    validateGroupRef(
        value.groupRef,
        'Topology config invariant generation groupRef',
    );
    if (!sameGroupRef(value.groupRef as GroupRef, expectedRef)) {
        throw new TypeError(
            'Topology config invariant generation has the wrong groupRef',
        );
    }
    validatePositiveInteger(
        value.version,
        'Topology config invariant generation version',
    );
}

function validateTopologyConfigFacts(
    facts: GroupTopologyConfigMutationFacts,
): void {
    validateStorageRevision(facts.requestedAtEpochMs, 'request fact time');
    validateStorageRevision(facts.policyNowEpochMs, 'policy fact time');
    if (!/^sha256:[0-9a-f]{64}$/.test(facts.commandHash)) {
        throw new TypeError('Topology config command hash is invalid');
    }
    if (typeof facts.isPlatformAdmin !== 'boolean') {
        throw new TypeError('Topology config admin fact is invalid');
    }
    if (facts.resolvedOverrideExpiresAtEpochMs !== null) {
        validateStorageRevision(
            facts.resolvedOverrideExpiresAtEpochMs,
            'override expiry fact',
        );
        resolveOverrideExpiresAtEpochMs({
            nowEpochMs: facts.policyNowEpochMs,
            expiresAtEpochMs: facts.resolvedOverrideExpiresAtEpochMs,
        });
    }
}

export function validateStoredGroupTopologyConfig(
    value: unknown,
    expectedRef: GroupRef,
): asserts value is StoredGroupTopologyConfig {
    if (!isRecord(value)) throw new TypeError('Stored topology config is invalid');
    validateExactKeys(value, [
        'groupRef',
        'config',
        'version',
        'createdAtEpochMs',
        'updatedAtEpochMs',
        'updatedByPrincipalId',
        'requestId',
    ], 'Stored topology config');
    validateGroupRef(value.groupRef, 'Stored topology config groupRef');
    if (!sameGroupRef(value.groupRef as GroupRef, expectedRef)) {
        throw new TypeError('Stored topology config has the wrong groupRef');
    }
    validateGroupTopologyConfigPatch(value.config as GroupTopologyConfigPatch);
    validatePositiveInteger(value.version, 'Stored topology config version');
    validateStorageRevision(value.createdAtEpochMs, 'Stored topology config created time');
    validateStorageRevision(value.updatedAtEpochMs, 'Stored topology config updated time');
    if (Number(value.updatedAtEpochMs) < Number(value.createdAtEpochMs)) {
        throw new TypeError('Stored topology config updated before creation');
    }
    requireString(value.updatedByPrincipalId, 'Stored topology config principal');
    if (value.requestId !== null) {
        requireString(value.requestId, 'Stored topology config requestId');
    }
}

export function validateStoredGroupTopologyOverride(
    value: unknown,
    expectedRef: GroupRef,
): asserts value is StoredGroupTopologyOverride {
    if (!isRecord(value)) throw new TypeError('Stored topology override is invalid');
    const base = { ...value };
    delete base.expiresAtEpochMs;
    validateStoredGroupTopologyConfig(base, expectedRef);
    validateExactKeys(value, [
        'groupRef',
        'config',
        'version',
        'createdAtEpochMs',
        'updatedAtEpochMs',
        'updatedByPrincipalId',
        'requestId',
        'expiresAtEpochMs',
    ], 'Stored topology override');
    validateStorageRevision(
        value.expiresAtEpochMs,
        'Stored topology override expiry',
    );
    if (Number(value.expiresAtEpochMs) <= Number(value.updatedAtEpochMs)) {
        throw new TypeError('Stored topology override expiry must follow update');
    }
}

export function validateGroupTopologyConfigMutationRecord(
    value: unknown,
    expected: Readonly<{ groupRef: GroupRef; requestId: string }>,
): asserts value is GroupTopologyConfigMutationRecord {
    if (!isRecord(value)) throw new TypeError('Topology config mutation record is invalid');
    validateExactKeys(
        value,
        ['groupRef', 'requestId', 'commandHash', 'receipt'],
        'Topology config mutation record',
    );
    validateGroupRef(value.groupRef, 'Topology config mutation record groupRef');
    if (!sameGroupRef(value.groupRef as GroupRef, expected.groupRef)) {
        throw new TypeError('Topology config mutation record has the wrong groupRef');
    }
    requireString(value.requestId, 'Topology config mutation requestId');
    if (value.requestId !== expected.requestId) {
        throw new TypeError('Topology config mutation record has the wrong requestId');
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(String(value.commandHash))) {
        throw new TypeError('Topology config mutation record hash is invalid');
    }
    validateTopologyConfigReceipt(value.receipt, expected.groupRef);
    if (
        (value.receipt as GroupTopologyConfigMutationReceipt).commandHash !==
            value.commandHash
    ) {
        throw new TypeError('Topology config receipt hash differs from record');
    }
    if (
        (value.receipt as GroupTopologyConfigMutationReceipt).commandId !==
            value.requestId
    ) {
        throw new TypeError(
            'Topology config receipt commandId differs from requestId',
        );
    }
}

function validateTopologyConfigReceipt(value: unknown, expectedRef: GroupRef): void {
    if (!isRecord(value)) throw new TypeError('Topology config receipt is invalid');
    validateExactKeys(value, [
        'commandId',
        'commandHash',
        'operation',
        'outcome',
        'groupRef',
        'target',
        'acceptedVersion',
        'acceptedStorageRevision',
        'acceptedCreatedAtEpochMs',
        'acceptedUpdatedAtEpochMs',
        'acceptedExpiresAtEpochMs',
        'outboxId',
    ], 'Topology config receipt');
    requireString(value.commandId, 'Topology config receipt commandId');
    if (!/^sha256:[0-9a-f]{64}$/.test(String(value.commandHash))) {
        throw new TypeError('Topology config receipt hash is invalid');
    }
    if (!['putConfig', 'deleteConfig', 'putOverride', 'deleteOverride'].includes(
        String(value.operation),
    )) throw new TypeError('Topology config receipt operation is invalid');
    if (value.outcome !== 'applied' && value.outcome !== 'no-op') {
        throw new TypeError('Topology config receipt outcome is invalid');
    }
    validateGroupRef(value.groupRef, 'Topology config receipt groupRef');
    if (!sameGroupRef(value.groupRef as GroupRef, expectedRef)) {
        throw new TypeError('Topology config receipt has the wrong groupRef');
    }
    if (value.target !== 'config' && value.target !== 'override') {
        throw new TypeError('Topology config receipt target is invalid');
    }
    const expectsConfig = value.operation === 'putConfig' ||
        value.operation === 'deleteConfig';
    if ((expectsConfig ? 'config' : 'override') !== value.target) {
        throw new TypeError('Topology config receipt operation target is invalid');
    }
    const isPut = value.operation === 'putConfig' ||
        value.operation === 'putOverride';
    if (isPut && value.outcome !== 'applied') {
        throw new TypeError('Topology config PUT receipt must be applied');
    }
    validateStorageRevision(value.acceptedVersion, 'Topology config accepted version');
    if (value.acceptedStorageRevision !== null) {
        validateStorageRevision(
            value.acceptedStorageRevision,
            'Topology config accepted storage revision',
        );
    }
    for (const [field, label] of [
        ['acceptedCreatedAtEpochMs', 'Topology config accepted creation time'],
        ['acceptedUpdatedAtEpochMs', 'Topology config accepted update time'],
        ['acceptedExpiresAtEpochMs', 'Topology config accepted expiry'],
    ] as const) {
        if (value[field] !== null) validateStorageRevision(value[field], label);
    }
    if (value.outboxId !== null) requireString(value.outboxId, 'Topology config outboxId');
    if ((value.outcome === 'applied') !== (value.outboxId !== null)) {
        throw new TypeError('Topology config receipt effect does not match outboxId');
    }
    if (
        value.outcome === 'applied' &&
        (
            Number(value.acceptedVersion) <= 0 ||
            value.acceptedStorageRevision === null ||
            value.outboxId === null
        )
    ) {
        throw new TypeError('Topology config applied receipt is incomplete');
    }
    if (
        value.outcome === 'no-op' &&
        Number(value.acceptedVersion) === 0 &&
        value.acceptedStorageRevision !== null
    ) {
        throw new TypeError('Topology config absent no-op receipt is invalid');
    }
    if (
        isPut !==
            (value.acceptedCreatedAtEpochMs !== null &&
                value.acceptedUpdatedAtEpochMs !== null)
    ) {
        throw new TypeError('Topology config receipt timestamps do not match operation');
    }
    if (
        value.acceptedCreatedAtEpochMs !== null &&
        Number(value.acceptedUpdatedAtEpochMs) < Number(value.acceptedCreatedAtEpochMs)
    ) {
        throw new TypeError('Topology config receipt update precedes creation');
    }
    if (
        (value.operation === 'putOverride') !==
            (value.acceptedExpiresAtEpochMs !== null)
    ) {
        throw new TypeError('Topology config receipt expiry does not match operation');
    }
    if (
        value.acceptedExpiresAtEpochMs !== null &&
        Number(value.acceptedExpiresAtEpochMs) <= Number(value.acceptedUpdatedAtEpochMs)
    ) {
        throw new TypeError('Topology config receipt expiry does not follow update');
    }
}

export function normalizeGroupTopologyConfigPatch(
    patch: GroupTopologyConfigPatch,
): GroupTopologyConfigPatch {
    return {
        ...(patch.topologyKind === undefined ? {} : { topologyKind: patch.topologyKind }),
        ...(patch.degreeLimit === undefined ? {} : { degreeLimit: patch.degreeLimit }),
        ...(patch.treeMinSize === undefined ? {} : { treeMinSize: patch.treeMinSize }),
        ...(patch.meshMinSize === undefined ? {} : { meshMinSize: patch.meshMinSize }),
        ...(patch.meshParamK === undefined ? {} : { meshParamK: patch.meshParamK }),
    };
}

function copyGroupRef(ref: GroupRef): GroupRef {
    return {
        applicationId: ref.applicationId,
        ...(ref.workspaceId === undefined ? {} : { workspaceId: ref.workspaceId }),
        groupId: ref.groupId,
    };
}

function validateGroupRef(value: unknown, label: string): void {
    if (!isRecord(value)) throw new TypeError(`${label} is invalid`);
    requireString(value.applicationId, `${label} applicationId`);
    if (value.workspaceId !== undefined) {
        requireString(value.workspaceId, `${label} workspaceId`);
    }
    requireString(value.groupId, `${label} groupId`);
}

function sameGroupRef(left: GroupRef, right: GroupRef): boolean {
    return left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId &&
        left.groupId === right.groupId;
}

function validateExactKeys(
    value: Readonly<Record<string, unknown>>,
    keys: readonly string[],
    label: string,
): void {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new TypeError(`${label} fields are invalid`);
    }
}

function validatePositiveInteger(value: unknown, label: string): void {
    if (!Number.isSafeInteger(value) || Number(value) <= 0) {
        throw new TypeError(`${label} is invalid`);
    }
}

function validateStorageRevision(value: unknown, label: string): void {
    if (!Number.isSafeInteger(value) || Number(value) < 0 || Object.is(value, -0)) {
        throw new TypeError(`${label} is invalid`);
    }
}

function requireString(value: unknown, label: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new TypeError(`${label} is invalid`);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
