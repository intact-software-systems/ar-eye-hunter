import { validateAuthoritativeClientSnapshot } from '@shared/api/authoritative-state-validation.ts';

import {
  validateClientEvent,
  validateClientInstance,
  validateClientPrincipal,
  validateClientSession,
} from '../../client-state-contract-validation.ts';
import {
  validateClientMutationIdempotencyRecordValue,
  validateClientMutationReceipt,
} from '../../client-mutation-receipt-validation.ts';
import {
  rejectClientMutation,
  requireBoolean,
  requireExactKeys,
  requirePlainRecord,
  requireSha256,
  validateClientPrincipalRef,
} from '../../client-state-validation-primitives.ts';
import type { ClientMutationComputed, ConditionalCandidate } from '../client-mutation-contracts.ts';

export function validateClientMutationResult(
  computed: unknown,
): asserts computed is ClientMutationComputed {
  const value = requirePlainRecord(computed, 'Client mutation computed');
  switch (value.outcome) {
    case 'replay':
      validateReplayResult(value);
      return;
    case 'no-op':
      validateNoOpResult(value);
      return;
    case 'idempotency-conflict':
      validateIdempotencyConflictResult(value);
      return;
    case 'write':
      validateAppliedWriteResult(value);
      return;
    default:
      rejectClientMutation('Client mutation computed outcome is invalid');
  }
}

function validateReplayResult(value: Readonly<Record<string, unknown>>): void {
  requireExactKeys(value, ['outcome', 'receipt', 'snapshot', 'event'], 'Client mutation computed');
  validateClientMutationReceipt(value.receipt, 'Client mutation computed.receipt');
  validateAuthoritativeClientSnapshot(value.snapshot as never);
  if (value.event !== null) validateClientEvent(value.event, 'Client mutation computed.event');
}

function validateNoOpResult(value: Readonly<Record<string, unknown>>): void {
  requireBoolean(value.persistIdempotency, 'Client mutation computed.persistIdempotency');
  requireExactKeys(
    value,
    value.persistIdempotency
      ? [
          'outcome',
          'persistIdempotency',
          'aggregateRef',
          'idempotency',
          'receipt',
          'snapshot',
          'event',
        ]
      : ['outcome', 'persistIdempotency', 'receipt', 'snapshot', 'event'],
    'Client mutation computed',
  );
  validateClientMutationReceipt(value.receipt, 'Client mutation computed.receipt');
  validateAuthoritativeClientSnapshot(value.snapshot as never);
  if (value.event !== null) {
    rejectClientMutation('Client mutation computed no-op event must be null');
  }
  if (value.persistIdempotency) {
    validateClientPrincipalRef(value.aggregateRef, 'Client mutation computed.aggregateRef');
    validateClientMutationIdempotencyRecordValue(
      value.idempotency,
      'Client mutation computed.idempotency',
    );
  }
}

function validateIdempotencyConflictResult(value: Readonly<Record<string, unknown>>): void {
  requireExactKeys(
    value,
    ['outcome', 'existingCommandHash', 'receivedCommandHash'],
    'Client mutation computed',
  );
  requireSha256(value.existingCommandHash, 'Client mutation computed.existingCommandHash');
  requireSha256(value.receivedCommandHash, 'Client mutation computed.receivedCommandHash');
}

function validateAppliedWriteResult(value: Readonly<Record<string, unknown>>): void {
  requireExactKeys(
    value,
    [
      'outcome',
      'principal',
      'instance',
      'session',
      'event',
      'receipt',
      'snapshot',
      'idempotency',
      'stateSync',
      'outboxEntries',
    ],
    'Client mutation computed',
  );
  validateConditionalCandidate(
    value.principal,
    'Client mutation computed.principal',
    validateClientPrincipal,
  );
  if ((value.principal as { operation?: unknown }).operation === 'none') {
    rejectClientMutation('Client mutation computed principal guard is required');
  }
  validateConditionalCandidate(
    value.instance,
    'Client mutation computed.instance',
    validateClientInstance,
  );
  validateConditionalCandidate(
    value.session,
    'Client mutation computed.session',
    validateClientSession,
  );
  validateClientEvent(value.event, 'Client mutation computed.event');
  validateAuthoritativeClientSnapshot(value.snapshot as never);
  validateClientMutationReceipt(value.receipt, 'Client mutation computed.receipt');
  if (value.idempotency !== null) {
    validateClientMutationIdempotencyRecordValue(
      value.idempotency,
      'Client mutation computed.idempotency',
    );
  }
  if (!Array.isArray(value.stateSync) || value.stateSync.length !== 2) {
    rejectClientMutation('Client mutation computed stateSync must contain snapshot and event');
  }
  if (!Array.isArray(value.outboxEntries) || value.outboxEntries.length !== 2) {
    rejectClientMutation('Client mutation computed outboxEntries must contain snapshot and event');
  }
}

function validateConditionalCandidate<T>(
  value: unknown,
  label: string,
  validateValue: (value: unknown, label: string) => void,
): asserts value is ConditionalCandidate<T> {
  const candidate = requirePlainRecord(value, label);
  switch (candidate.operation) {
    case 'none':
      requireExactKeys(candidate, ['operation'], label);
      return;
    case 'insert':
      requireExactKeys(candidate, ['operation', 'value'], label);
      validateValue(candidate.value, `${label}.value`);
      return;
    case 'update':
      requireExactKeys(candidate, ['operation', 'value', 'expectedRevision'], label);
      validateValue(candidate.value, `${label}.value`);
      if (
        !Number.isSafeInteger(candidate.expectedRevision) ||
        (candidate.expectedRevision as number) < 0 ||
        Object.is(candidate.expectedRevision, -0)
      ) {
        rejectClientMutation(`${label}.expectedRevision must be a finite safe nonnegative integer`);
      }
      return;
    default:
      rejectClientMutation(`${label}.operation is invalid`);
  }
}
