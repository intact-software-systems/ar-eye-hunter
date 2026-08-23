import { type ClientMutationIdempotencyRecord } from '@shared-server/rallar-system/client-state/persistence/client-state-persistence-contracts.ts';
import { type GroupMutationIdempotencyRecord } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import type { GroupTopologyConfigMutationReceipt } from '@shared/api/graph-topology-management-types.ts';
import type { GroupStateCausalRevision } from '@shared/api/group-types.ts';

type AggregateRef = Readonly<{
    applicationId: string;
    workspaceId: string;
    principalId?: string;
    groupId?: string;
}>;

export type AuthoritativeResultBinding = Readonly<{
    operationId: string;
    receiptId: string;
    requestId: string | null;
    commandHash: string;
    outcome: string;
    attemptCount: number;
    outboxIds: readonly string[];
    aggregateRef: AggregateRef;
    stateRevision: number | null;
    causalRevision: GroupStateCausalRevision | null;
    snapshotVersion: number | null;
    acceptedVersion: number | null;
    operation: string | null;
    target: 'config' | 'override' | null;
    acceptedStorageRevision: number | null;
    acceptedCreatedAtEpochMs: number | null;
    acceptedUpdatedAtEpochMs: number | null;
    acceptedExpiresAtEpochMs: number | null;
    acceptedConfig: unknown;
    acceptedCausalRevision: unknown;
    eventId: string | null;
}>;

export type ProductionReceiptEvidence = Readonly<{
    commandId: string;
    receiptIds: readonly string[];
    outboxIds: readonly string[];
    identityKind: 'logical-msg-id' | 'physical-resource-id';
    resultBindings: readonly AuthoritativeResultBinding[];
}>;

export function projectClientReceiptEvidence(
    commandId: string,
    records: readonly ClientMutationIdempotencyRecord[]
): ProductionReceiptEvidence {
    const resultBindings = records.map((record, index) => ({
        operationId: index === 0 ? 'profile' : 'instance',
        receiptId: record.receipt.commandId,
        requestId: record.receipt.requestId,
        commandHash: record.receipt.commandHash,
        outcome: record.receipt.outcome,
        attemptCount: record.receipt.attemptCount,
        outboxIds: record.receipt.outboxIds,
        aggregateRef: record.receipt.aggregateRef,
        stateRevision: record.receipt.stateRevision,
        causalRevision: null,
        snapshotVersion: record.receipt.snapshotVersion,
        acceptedVersion: null,
        operation: null,
        target: null,
        acceptedStorageRevision: null,
        acceptedCreatedAtEpochMs: null,
        acceptedUpdatedAtEpochMs: null,
        acceptedExpiresAtEpochMs: null,
        acceptedConfig: null,
        acceptedCausalRevision: null,
        eventId: record.receipt.eventId
    }));
    return {
        commandId,
        receiptIds: resultBindings.map((binding) => binding.receiptId),
        outboxIds: records.flatMap((record) => record.receipt.outboxIds),
        identityKind: 'physical-resource-id',
        resultBindings
    };
}

export function projectGroupReceiptEvidence(
    commandId: string,
    record: GroupMutationIdempotencyRecord
): ProductionReceiptEvidence {
    const receipt = record.receipt;
    return {
        commandId,
        receiptIds: [receipt.commandId],
        outboxIds: receipt.outboxIds,
        identityKind: 'physical-resource-id',
        resultBindings: [{
            operationId: 'command',
            receiptId: receipt.commandId,
            requestId: receipt.requestId,
            commandHash: receipt.commandHash,
            outcome: receipt.outcome,
            attemptCount: receipt.attemptCount,
            outboxIds: receipt.outboxIds,
            aggregateRef: receipt.aggregateRef,
            stateRevision: null,
            causalRevision: receipt.causalRevision,
            snapshotVersion: receipt.snapshotVersion,
            acceptedVersion: null,
            operation: null,
            target: null,
            acceptedStorageRevision: null,
            acceptedCreatedAtEpochMs: null,
            acceptedUpdatedAtEpochMs: null,
            acceptedExpiresAtEpochMs: null,
            acceptedConfig: null,
            acceptedCausalRevision: null,
            eventId: receipt.eventId
        }]
    };
}

export function projectTopologyReceiptEvidence(
    commandId: string,
    receipt: GroupTopologyConfigMutationReceipt
): ProductionReceiptEvidence {
    return {
        commandId,
        receiptIds: [receipt.commandId],
        outboxIds: receipt.outboxIds,
        identityKind: 'logical-msg-id',
        resultBindings: [{
            operationId: 'command',
            receiptId: receipt.commandId,
            requestId: receipt.requestId,
            commandHash: receipt.commandHash,
            outcome: receipt.outcome,
            attemptCount: receipt.attemptCount,
            outboxIds: receipt.outboxIds,
            aggregateRef: receipt.groupRef,
            stateRevision: null,
            causalRevision: null,
            snapshotVersion: receipt.acceptedCausalRevision?.snapshotVersion ?? null,
            acceptedVersion: receipt.acceptedVersion,
            operation: receipt.operation,
            target: receipt.target,
            acceptedStorageRevision: receipt.acceptedStorageRevision,
            acceptedCreatedAtEpochMs: receipt.acceptedCreatedAtEpochMs,
            acceptedUpdatedAtEpochMs: receipt.acceptedUpdatedAtEpochMs,
            acceptedExpiresAtEpochMs: receipt.acceptedExpiresAtEpochMs,
            acceptedConfig: receipt.acceptedConfig,
            acceptedCausalRevision: receipt.acceptedCausalRevision,
            eventId: receipt.eventId
        }]
    };
}
