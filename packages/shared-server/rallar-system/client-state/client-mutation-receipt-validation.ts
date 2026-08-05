import {
  rejectClientMutation,
  requireEnum,
  requireExactKeys,
  requireNonEmptyString,
  requireNullableNonEmptyString,
  requirePlainRecord,
  requirePositiveSafeInteger,
  requireSha256,
  requireStringArray,
  requireTimestamp,
  validateClientPrincipalRef,
} from './client-state-validation-primitives.ts';
import type {
  ClientMutationIdempotencyRecord,
  ClientMutationReceipt,
} from './persistence/client-state-persistence-contracts.ts';

export function validateClientMutationReceipt(value: unknown, label: string): void {
  const receipt = requirePlainRecord(value, label);
  requireExactKeys(
    receipt,
    [
      'commandId',
      'requestId',
      'commandHash',
      'aggregateRef',
      'outcome',
      'attemptCount',
      'acceptedStorageRevision',
      'stateRevision',
      'snapshotVersion',
      'presenceVersion',
      'eventId',
      'outboxIds',
    ],
    label,
  );
  requireNonEmptyString(receipt.commandId, `${label}.commandId`);
  requireNullableNonEmptyString(receipt.requestId, `${label}.requestId`);
  requireSha256(receipt.commandHash, `${label}.commandHash`);
  validateClientPrincipalRef(receipt.aggregateRef, `${label}.aggregateRef`);
  requireEnum(receipt.outcome, new Set(['applied', 'no-op']), `${label}.outcome`);
  requirePositiveSafeInteger(receipt.attemptCount, `${label}.attemptCount`);
  validateClientMutationReceiptRevisions(receipt, label);
  validateClientMutationReceiptOutcome(receipt, label);
}

function validateClientMutationReceiptRevisions(
  receipt: Readonly<Record<string, unknown>>,
  label: string,
): void {
  if (receipt.acceptedStorageRevision === null) {
    rejectClientMutation(`${label}.acceptedStorageRevision is required`);
  }
  requireTimestamp(receipt.acceptedStorageRevision, `${label}.acceptedStorageRevision`);
  requirePositiveSafeInteger(receipt.stateRevision, `${label}.stateRevision`);
  requirePositiveSafeInteger(receipt.snapshotVersion, `${label}.snapshotVersion`);
  requirePositiveSafeInteger(receipt.presenceVersion, `${label}.presenceVersion`);
  if (receipt.stateRevision !== (receipt.acceptedStorageRevision as number) + 1) {
    rejectClientMutation(`${label}.stateRevision differs from acceptedStorageRevision`);
  }
}

function validateClientMutationReceiptOutcome(
  receipt: Readonly<Record<string, unknown>>,
  label: string,
): void {
  requireNullableNonEmptyString(receipt.eventId, `${label}.eventId`);
  requireStringArray(receipt.outboxIds, `${label}.outboxIds`);
  if ((receipt.outcome === 'applied') !== (receipt.eventId !== null)) {
    rejectClientMutation(`${label}.eventId differs from outcome`);
  }
  const expectedOutboxCount = receipt.outcome === 'applied' ? 2 : 0;
  if ((receipt.outboxIds as readonly string[]).length !== expectedOutboxCount) {
    rejectClientMutation(`${label}.outboxIds differs from outcome`);
  }
  const outboxIds = receipt.outboxIds as readonly string[];
  if (
    receipt.outcome === 'applied' &&
    (new Set(outboxIds).size !== outboxIds.length || outboxIds.some((outboxId) => !outboxId))
  ) {
    rejectClientMutation(`${label}.outboxIds are not unique durable identities`);
  }
}

export function validateClientMutationIdempotencyRecordValue(
  value: unknown,
  label: string,
): asserts value is ClientMutationIdempotencyRecord {
  const record = requirePlainRecord(value, label);
  requireExactKeys(record, ['requestId', 'commandHash', 'receipt'], label);
  requireNonEmptyString(record.requestId, `${label}.requestId`);
  requireSha256(record.commandHash, `${label}.commandHash`);
  validateClientMutationReceipt(record.receipt, `${label}.receipt`);
  const receipt = record.receipt as ClientMutationReceipt;
  if (
    receipt.commandHash !== record.commandHash ||
    receipt.requestId !== record.requestId ||
    receipt.commandId !== record.requestId
  ) {
    rejectClientMutation(`${label} receipt hash differs`);
  }
}
