import type {
    EffectiveGroupTopologyConfig,
    GroupTopologyConfigMutationReceipt
} from '@shared/api/graph-topology-management-types.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RuntimeStateEntryValue } from '../../../../runtime-state/runtime-state-json-store.ts';
import {
    computeRtcTopologyOutboxInsert,
    toRtcTopologyEntryResourceId,
    type ComputedRtcTopologyOutbox
} from '../../mutation/rtc-topology-outbox-entry.ts';
import type {
    GroupTopologyConfigGeneration,
    GroupTopologyConfigMutationAcceptedResult,
    GroupTopologyConfigMutationCommand,
    GroupTopologyConfigMutationFacts,
    GroupTopologyConfigMutationRead,
    GroupTopologyConfigMutationRecord,
    GroupTopologyConfigMutationWriteComputed,
    TopologyConfigWriteGuard
} from './group-topology-config-mutation-contracts.ts';

export interface CreateTopologyConfigWriteResultInput {
    readonly command: GroupTopologyConfigMutationCommand;
    readonly read: GroupTopologyConfigMutationRead;
    readonly facts: GroupTopologyConfigMutationFacts;
    readonly guard: TopologyConfigWriteGuard;
    readonly currentGeneration: RuntimeStateEntryValue<GroupTopologyConfigGeneration> | null;
    readonly acceptedVersion: number;
    readonly acceptedStorageRevision: number;
}

interface CreateTopologyConfigReceiptInput {
    readonly command: GroupTopologyConfigMutationCommand;
    readonly facts: GroupTopologyConfigMutationFacts;
    readonly target: 'config' | 'override';
    readonly outcome: 'applied' | 'no-op';
    readonly acceptedVersion: number;
    readonly acceptedStorageRevision: number | null;
    readonly acceptedCreatedAtEpochMs: number | null;
    readonly acceptedUpdatedAtEpochMs: number | null;
    readonly acceptedExpiresAtEpochMs: number | null;
    readonly acceptedConfig: EffectiveGroupTopologyConfig | null;
    readonly acceptedCausalRevision: GroupTopologyConfigMutationReceipt['acceptedCausalRevision'];
    readonly outboxIds: readonly string[];
}

export interface CreateTopologyConfigNoOpReceiptInput {
    readonly command: GroupTopologyConfigMutationCommand;
    readonly facts: GroupTopologyConfigMutationFacts;
    readonly target: 'config' | 'override';
    readonly acceptedVersion: number;
}

export function createTopologyConfigWriteResult(
    topologyWrite: CreateTopologyConfigWriteResultInput
): GroupTopologyConfigMutationWriteComputed {
    const accepted = topologyWrite.read.groupSnapshot;
    const acceptedCausalRevision = {
        causalRevision: accepted.causalRevision,
        snapshotVersion: accepted.group.snapshotVersion,
        metadataVersion: accepted.group.metadataVersion,
        rosterVersion: accepted.group.rosterVersion,
        presenceVersion: accepted.group.presenceVersion
    };
    const outbox = createTopologyConfigOutbox(topologyWrite, acceptedCausalRevision);
    const receipt = createAppliedTopologyConfigReceipt(topologyWrite, acceptedCausalRevision, outbox);
    return {
        outcome: 'write',
        groupAuthorityGuard: topologyWrite.read.groupAuthorityGuard,
        guard: topologyWrite.guard,
        invariantGenerationGuard: {
            expectedRevision: topologyWrite.read.invariantGeneration?.entry.revision ?? null,
            value: {
                groupRef: copyGroupRef(topologyWrite.command.aggregateRef),
                version: (topologyWrite.read.invariantGeneration?.value.version ?? 0) + 1
            }
        },
        generationGuard: {
            expectedRevision: topologyWrite.currentGeneration?.entry.revision ?? null,
            value: {
                groupRef: copyGroupRef(topologyWrite.command.aggregateRef),
                target: topologyWrite.guard.target,
                version: topologyWrite.acceptedVersion
            }
        },
        receipt,
        idempotency: createTopologyConfigMutationRecord(
            topologyWrite.command,
            receipt
        ),
        outboxWrite: computeRtcTopologyOutboxInsert(outbox),
        result: resultFromTopologyConfigGuard(topologyWrite.guard)
    };
}

export function createTopologyConfigNoOpReceipt(
    noOp: CreateTopologyConfigNoOpReceiptInput
): GroupTopologyConfigMutationReceipt {
    return createTopologyConfigReceipt({
        command: noOp.command,
        facts: noOp.facts,
        target: noOp.target,
        outcome: 'no-op',
        acceptedVersion: noOp.acceptedVersion,
        acceptedStorageRevision: null,
        acceptedCreatedAtEpochMs: null,
        acceptedUpdatedAtEpochMs: null,
        acceptedExpiresAtEpochMs: null,
        acceptedConfig: null,
        acceptedCausalRevision: null,
        outboxIds: []
    });
}

export function createTopologyConfigMutationRecord(
    command: GroupTopologyConfigMutationCommand,
    receipt: GroupTopologyConfigMutationReceipt
): GroupTopologyConfigMutationRecord | null {
    return command.requestId === null
        ? null
        : {
            groupRef: copyGroupRef(command.aggregateRef),
            requestId: command.requestId,
            commandHash: command.commandHash,
            receipt
        };
}

export function resultFromTopologyConfigReceipt(
    command: GroupTopologyConfigMutationCommand,
    receipt: GroupTopologyConfigMutationReceipt
): GroupTopologyConfigMutationAcceptedResult {
    switch (receipt.operation) {
        case 'putConfig':
            return {
                kind: 'config',
                config: {
                    groupRef: copyGroupRef(command.aggregateRef),
                    config: requireAcceptedConfig(receipt),
                    version: receipt.acceptedVersion,
                    createdAtEpochMs: requireAcceptedTimestamp(receipt.acceptedCreatedAtEpochMs, 'created'),
                    updatedAtEpochMs: requireAcceptedTimestamp(receipt.acceptedUpdatedAtEpochMs, 'updated'),
                    updatedByPrincipalId: command.input.updatedByPrincipalId,
                    requestId: command.requestId
                }
            };
        case 'putOverride':
            return {
                kind: 'override',
                override: {
                    groupRef: copyGroupRef(command.aggregateRef),
                    config: requireAcceptedConfig(receipt),
                    version: receipt.acceptedVersion,
                    createdAtEpochMs: requireAcceptedTimestamp(receipt.acceptedCreatedAtEpochMs, 'created'),
                    updatedAtEpochMs: requireAcceptedTimestamp(receipt.acceptedUpdatedAtEpochMs, 'updated'),
                    updatedByPrincipalId: command.input.updatedByPrincipalId,
                    requestId: command.requestId,
                    expiresAtEpochMs: requireAcceptedTimestamp(receipt.acceptedExpiresAtEpochMs, 'expiry')
                }
            };
        case 'deleteConfig':
        case 'deleteOverride':
            return { kind: 'delete', deleted: receipt.outcome === 'applied' };
    }
}

function createTopologyConfigOutbox(
    topologyWrite: CreateTopologyConfigWriteResultInput,
    acceptedCausalRevision: NonNullable<GroupTopologyConfigMutationReceipt['acceptedCausalRevision']>
): ComputedRtcTopologyOutbox {
    const causalRevision = acceptedCausalRevision.causalRevision;
    const outboxResourceId = [
        topologyWrite.command.commandId,
        'rtc-topology-recompute',
        'group-revision',
        `group=${causalRevision.groupRevision};presence=${causalRevision.presenceRevision}`
    ].join(':');
    return {
        aggregateRef: copyGroupRef(topologyWrite.command.aggregateRef),
        commandId: topologyWrite.command.commandId,
        createdAtEpochMs: topologyWrite.command.capturedAtEpochMs,
        acceptedCausalRevision: acceptedCausalRevision.causalRevision,
        groupSnapshot: topologyWrite.read.groupSnapshot,
        effectKind: 'rtc-topology-recompute',
        payloadKind: 'group-revision',
        expireAtEpochMs: 253_402_300_799_999,
        senderId: topologyWrite.command.input.updatedByPrincipalId,
        resourceId: outboxResourceId,
        requestOptions: toCanonicalGroupTopologyConfigPatch({}),
        publish: true
    };
}

function createAppliedTopologyConfigReceipt(
    topologyWrite: CreateTopologyConfigWriteResultInput,
    acceptedCausalRevision: NonNullable<GroupTopologyConfigMutationReceipt['acceptedCausalRevision']>,
    outbox: ComputedRtcTopologyOutbox
): GroupTopologyConfigMutationReceipt {
    const acceptedValue = topologyWrite.guard.operation === 'delete' ? null : topologyWrite.guard.value;
    return createTopologyConfigReceipt({
        command: topologyWrite.command,
        facts: topologyWrite.facts,
        target: topologyWrite.guard.target,
        outcome: 'applied',
        acceptedVersion: topologyWrite.acceptedVersion,
        acceptedStorageRevision: topologyWrite.acceptedStorageRevision,
        acceptedCreatedAtEpochMs: acceptedValue?.createdAtEpochMs ?? null,
        acceptedUpdatedAtEpochMs: acceptedValue?.updatedAtEpochMs ?? null,
        acceptedExpiresAtEpochMs:
            topologyWrite.guard.operation !== 'delete' && topologyWrite.guard.target === 'override'
                ? topologyWrite.guard.value.expiresAtEpochMs
                : null,
        acceptedConfig: acceptedValue === null ? null : { ...acceptedValue.config },
        acceptedCausalRevision,
        outboxIds: [toRtcTopologyEntryResourceId(outbox)]
    });
}

function createTopologyConfigReceipt(
    receiptFields: CreateTopologyConfigReceiptInput
): GroupTopologyConfigMutationReceipt {
    return {
        commandId: receiptFields.command.commandId,
        requestId: receiptFields.command.requestId,
        commandHash: receiptFields.command.commandHash,
        operation: receiptFields.command.operation,
        outcome: receiptFields.outcome,
        attemptCount: receiptFields.facts.attemptCount,
        groupRef: copyGroupRef(receiptFields.command.aggregateRef),
        target: receiptFields.target,
        acceptedVersion: receiptFields.acceptedVersion,
        acceptedStorageRevision: receiptFields.acceptedStorageRevision,
        acceptedCreatedAtEpochMs: receiptFields.acceptedCreatedAtEpochMs,
        acceptedUpdatedAtEpochMs: receiptFields.acceptedUpdatedAtEpochMs,
        acceptedExpiresAtEpochMs: receiptFields.acceptedExpiresAtEpochMs,
        acceptedConfig: receiptFields.acceptedConfig,
        acceptedCausalRevision: receiptFields.acceptedCausalRevision,
        eventId: null,
        outboxIds: receiptFields.outboxIds
    };
}

function resultFromTopologyConfigGuard(
    guard: TopologyConfigWriteGuard
): GroupTopologyConfigMutationAcceptedResult {
    if (guard.operation === 'delete') {
        return { kind: 'delete', deleted: true };
    }
    return guard.target === 'config'
        ? { kind: 'config', config: guard.value }
        : { kind: 'override', override: guard.value };
}

function requireAcceptedConfig(
    receipt: GroupTopologyConfigMutationReceipt
): EffectiveGroupTopologyConfig {
    if (receipt.acceptedConfig === null) {
        throw new TypeError('Topology config accepted config is required');
    }
    return { ...receipt.acceptedConfig };
}

function requireAcceptedTimestamp(value: number | null, label: string): number {
    if (value === null) {
        throw new TypeError(`Topology config accepted ${label} time is required`);
    }
    return value;
}

function copyGroupRef(ref: GroupRef): GroupRef {
    return {
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        groupId: ref.groupId
    };
}
