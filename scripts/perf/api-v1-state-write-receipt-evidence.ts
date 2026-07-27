import type {
  GroupTopologyConfigMutationRecord,
} from '@shared-server/rallar-system/services/group-topology-config-mutations.ts';
import type {
  ClientMutationIdempotencyRecord,
} from '@shared-server/rallar-system/services/client-state-mutations.ts';
import type {
  GroupMutationIdempotencyRecord,
} from '@shared-server/rallar-system/services/group-state-mutations.ts';

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
  aggregateRef: AggregateRef;
  stateRevision: number | null;
  snapshotVersion: number | null;
  acceptedVersion: number | null;
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
  records: readonly ClientMutationIdempotencyRecord[],
): ProductionReceiptEvidence {
  const resultBindings = records.map((record, index) => ({
    operationId: index === 0 ? 'profile' : 'instance',
    receiptId: record.receipt.commandId,
    requestId: record.receipt.requestId,
    commandHash: record.receipt.commandHash,
    aggregateRef: record.receipt.aggregateRef,
    stateRevision: record.receipt.stateRevision,
    snapshotVersion: record.receipt.snapshotVersion,
    acceptedVersion: null,
    eventId: record.receipt.eventId,
  }));
  return {
    commandId,
    receiptIds: resultBindings.map((binding) => binding.receiptId),
    outboxIds: records.flatMap((record) => record.receipt.outboxIds),
    identityKind: 'physical-resource-id',
    resultBindings,
  };
}

export function projectGroupReceiptEvidence(
  commandId: string,
  record: GroupMutationIdempotencyRecord,
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
      aggregateRef: receipt.aggregateRef,
      stateRevision: receipt.stateRevision,
      snapshotVersion: receipt.snapshotVersion,
      acceptedVersion: null,
      eventId: receipt.eventId,
    }],
  };
}

export function projectTopologyReceiptEvidence(
  commandId: string,
  record: GroupTopologyConfigMutationRecord,
): ProductionReceiptEvidence {
  const receipt = record.receipt;
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
      aggregateRef: receipt.groupRef,
      stateRevision: receipt.acceptedCausalRevision?.stateRevision ?? null,
      snapshotVersion: receipt.acceptedCausalRevision?.snapshotVersion ?? null,
      acceptedVersion: receipt.acceptedVersion,
      eventId: receipt.eventId,
    }],
  };
}
