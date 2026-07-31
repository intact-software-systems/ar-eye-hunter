import { toGroupSnapshotStateRevision } from '@shared/api/group-client-views.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import {
  assertExactKeys,
  assertRequiredKeys,
  nullableNonEmptyString,
  requireNonEmptyString,
  requireNonNegativeSafeInteger,
  requireOneOf,
  requirePositiveSafeInteger,
  requireRecord,
  validateGroupRef,
} from '../group-state-validation-primitives.ts';
import {
  validateCausalRevision,
  validateScopedValue,
} from '../persistence/validate-persisted-group.ts';
import type {
  GroupMutationIdempotencyRecord,
  GroupMutationReceipt,
} from './group-mutation-contracts.ts';

const MUTATION_RECEIPT_KEYS = [
  'commandId',
  'requestId',
  'commandHash',
  'aggregateRef',
  'outcome',
  'attemptCount',
  'acceptedStorageRevision',
  'stateRevision',
  'snapshotVersion',
  'causalRevision',
  'eventId',
  'outboxIds',
  'joinCode',
  'joinCodeExpiresAtEpochMs',
  'rejection',
] as const;

export function validateGroupMutationIdempotencyRecord(
  record: unknown,
  ref: GroupRef,
): asserts record is GroupMutationIdempotencyRecord {
  const value = requireRecord(record, 'Stored group idempotency value');
  assertExactKeys(
    value,
    ['aggregateRef', 'requestId', 'commandHash', 'receipt'],
    'Stored group idempotency value',
  );
  assertRequiredKeys(
    value,
    ['aggregateRef', 'requestId', 'commandHash', 'receipt'],
    'Stored group idempotency value',
  );
  validateGroupRef(value.aggregateRef);
  validateScopedValue(value.aggregateRef as GroupRef, ref, 'Stored group idempotency aggregateRef');
  requireNonEmptyString(value.requestId, 'Stored group idempotency requestId');
  validateCommandHash(value.commandHash, 'Stored group idempotency commandHash');
  validateMutationReceipt(value.receipt, ref, 'Stored group idempotency receipt');
  const receipt = value.receipt as GroupMutationReceipt;
  if (receipt.commandHash !== value.commandHash) {
    throw new TypeError('Stored group idempotency hashes differ');
  }
  if (receipt.commandId !== value.requestId) {
    throw new TypeError('Stored group idempotency receipt command differs from request identity');
  }
  if (
    receipt.requestId !== value.requestId ||
    receipt.aggregateRef.applicationId !== ref.applicationId ||
    receipt.aggregateRef.workspaceId !== ref.workspaceId ||
    receipt.aggregateRef.groupId !== ref.groupId
  ) {
    throw new TypeError('Stored group idempotency receipt differs from request identity');
  }
}

export function validateMutationReceipt(value: unknown, ref: GroupRef, label: string): void {
  const receipt = requireRecord(value, label);
  assertExactKeys(receipt, MUTATION_RECEIPT_KEYS, label);
  assertRequiredKeys(receipt, MUTATION_RECEIPT_KEYS, label);
  validateMutationReceiptIdentity(receipt, ref, label);
  validateMutationReceiptRevisions(receipt, label);
  validateMutationReceiptDetails(receipt, label);
  validateMutationReceiptOutcome(receipt, label);
}

function validateMutationReceiptIdentity(
  receipt: Record<string, unknown>,
  ref: GroupRef,
  label: string,
): void {
  requireNonEmptyString(receipt.commandId, `${label} commandId`);
  nullableNonEmptyString(receipt.requestId, `${label} requestId`);
  validateCommandHash(receipt.commandHash, `${label} commandHash`);
  const aggregateRef = receipt.aggregateRef;
  validateGroupRef(aggregateRef);
  validateScopedValue(aggregateRef, ref, `${label} aggregateRef`);
  requireOneOf(receipt.outcome, ['applied', 'no-op', 'rejected'], `${label} outcome`);
  requirePositiveSafeInteger(receipt.attemptCount, `${label} attemptCount`);
}

function validateMutationReceiptRevisions(receipt: Record<string, unknown>, label: string): void {
  if (receipt.acceptedStorageRevision !== null) {
    requireNonNegativeSafeInteger(
      receipt.acceptedStorageRevision,
      `${label} acceptedStorageRevision`,
    );
  }
  requireNonNegativeSafeInteger(receipt.stateRevision, `${label} stateRevision`);
  requireNonNegativeSafeInteger(receipt.snapshotVersion, `${label} snapshotVersion`);
  const causalRevision = receipt.causalRevision;
  validateCausalRevision(causalRevision, label);
  if (receipt.snapshotVersion !== causalRevision.groupRevision) {
    throw new TypeError(`${label} snapshotVersion differs from causalRevision`);
  }
  if (
    receipt.stateRevision !==
    toGroupSnapshotStateRevision(causalRevision.groupRevision, causalRevision.presenceRevision)
  ) {
    throw new TypeError(`${label} stateRevision differs from causalRevision`);
  }
}

function validateMutationReceiptDetails(receipt: Record<string, unknown>, label: string): void {
  nullableNonEmptyString(receipt.eventId, `${label} eventId`);
  if (!Array.isArray(receipt.outboxIds)) {
    throw new TypeError(`${label} outboxIds is invalid`);
  }
  for (const outboxId of receipt.outboxIds) {
    requireNonEmptyString(outboxId, `${label} outboxId`);
  }
  if ((receipt.outcome === 'applied') !== (receipt.eventId !== null)) {
    throw new TypeError(`${label} event differs from outcome`);
  }
  if (receipt.joinCode !== null) {
    requireNonEmptyString(receipt.joinCode, `${label} joinCode`);
  }
  if (receipt.joinCodeExpiresAtEpochMs !== null) {
    requirePositiveSafeInteger(
      receipt.joinCodeExpiresAtEpochMs,
      `${label} joinCodeExpiresAtEpochMs`,
    );
  }
  if ((receipt.joinCode === null) !== (receipt.joinCodeExpiresAtEpochMs === null)) {
    throw new TypeError(`${label} join-code fields must have matching presence`);
  }
  if (receipt.rejection !== null) {
    requireNonEmptyString(receipt.rejection, `${label} rejection`);
  }
  if ((receipt.outcome === 'rejected') !== (receipt.rejection !== null)) {
    throw new TypeError(`${label} rejection differs from outcome`);
  }
}

export function validateCommandHash(value: unknown, label: string): void {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

function validateMutationReceiptOutcome(receipt: Record<string, unknown>, label: string): void {
  const causalRevision = receipt.causalRevision as {
    readonly groupRevision: number;
    readonly presenceRevision: number;
  };
  const outboxIds = receipt.outboxIds as readonly string[];
  if (receipt.outcome === 'applied') {
    validateAppliedReceipt({ receipt, causalRevision, outboxIds, label });
    return;
  }
  if (outboxIds.length !== 0) {
    throw new TypeError(`${label} outboxIds differs from non-applied outcome`);
  }
  if (receipt.joinCode !== null || receipt.joinCodeExpiresAtEpochMs !== null) {
    throw new TypeError(`${label} join-code fields require an applied outcome`);
  }
  if (receipt.outcome === 'no-op') {
    validateNoOpReceipt(receipt, causalRevision, label);
    return;
  }
  validateRejectedReceipt(receipt, causalRevision, label);
}

interface ValidateAppliedReceiptInput {
  readonly receipt: Record<string, unknown>;
  readonly causalRevision: { readonly groupRevision: number };
  readonly outboxIds: readonly string[];
  readonly label: string;
}

function validateAppliedReceipt({
  receipt,
  causalRevision,
  outboxIds,
  label,
}: ValidateAppliedReceiptInput): void {
  if (receipt.acceptedStorageRevision === null) {
    throw new TypeError(`${label} acceptedStorageRevision is required when applied`);
  }
  requirePositiveSafeInteger(receipt.snapshotVersion, `${label} applied snapshotVersion`);
  requirePositiveSafeInteger(causalRevision.groupRevision, `${label} applied groupRevision`);
  if (outboxIds.length !== 1) {
    throw new TypeError(`${label} outboxIds differs from applied outcome`);
  }
}

function validateNoOpReceipt(
  receipt: Record<string, unknown>,
  causalRevision: { readonly groupRevision: number },
  label: string,
): void {
  requirePositiveSafeInteger(receipt.snapshotVersion, `${label} no-op snapshotVersion`);
  if (
    receipt.acceptedStorageRevision === null ||
    causalRevision.groupRevision !== (receipt.acceptedStorageRevision as number) + 1
  ) {
    throw new TypeError(`${label} no-op revision differs from its predecessor`);
  }
}

function validateRejectedReceipt(
  receipt: Record<string, unknown>,
  causalRevision: { readonly groupRevision: number; readonly presenceRevision: number },
  label: string,
): void {
  if (receipt.acceptedStorageRevision === null) {
    if (
      causalRevision.groupRevision !== 0 ||
      causalRevision.presenceRevision !== 0 ||
      receipt.snapshotVersion !== 0
    ) {
      throw new TypeError(`${label} absent-group rejection has authority`);
    }
    return;
  }
  requirePositiveSafeInteger(receipt.snapshotVersion, `${label} rejected snapshotVersion`);
  if (causalRevision.groupRevision !== (receipt.acceptedStorageRevision as number) + 1) {
    throw new TypeError(`${label} rejected revision differs from its predecessor`);
  }
}
