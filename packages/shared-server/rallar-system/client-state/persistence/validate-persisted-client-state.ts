import type {
  ClientEvent,
  ClientInstance,
  ClientInstanceRef,
  ClientPrincipal,
  ClientPrincipalRef,
  ClientSession,
  ClientSessionRef,
} from '@shared/api/client-types.ts';

import {
  validateClientEvent,
  validateClientInstance,
  validateClientPrincipal,
  validateClientSession,
} from '../client-state-contract-validation.ts';
// prettier-ignore
import {
  validateClientMutationIdempotencyRecordValue,
} from '../client-mutation-receipt-validation.ts';
import { rejectClientMutation } from '../client-state-validation-primitives.ts';
import { sameClientPrincipalRef } from '../client-state-semantic-equality.ts';
import type { ClientMutationIdempotencyRecord } from './client-state-persistence-contracts.ts';

export function validatePersistedClientPrincipal(
  value: unknown,
  expected?: ClientPrincipalRef,
): asserts value is ClientPrincipal {
  validateClientPrincipal(value, 'Stored client principal');
  if (expected && !sameClientPrincipalRef(value, expected)) {
    rejectClientMutation('Stored client principal identity differs from its canonical slot');
  }
}

export function validatePersistedClientInstance(
  value: unknown,
  expected?: ClientInstanceRef,
): asserts value is ClientInstance {
  validateClientInstance(value, 'Stored client instance');
  if (
    expected &&
    (!sameClientPrincipalRef(value, expected) ||
      value.clientInstanceId !== expected.clientInstanceId)
  ) {
    rejectClientMutation('Stored client instance identity differs from its canonical slot');
  }
}

export function validatePersistedClientSession(
  value: unknown,
  expected?: ClientSessionRef,
): asserts value is ClientSession {
  validateClientSession(value, 'Stored client session');
  if (
    expected &&
    (!sameClientPrincipalRef(value, expected) ||
      value.clientInstanceId !== expected.clientInstanceId ||
      value.sessionId !== expected.sessionId)
  ) {
    rejectClientMutation('Stored client session identity differs from its canonical slot');
  }
}

export function validatePersistedClientEvent(
  value: unknown,
  expected?: ClientPrincipalRef,
): asserts value is ClientEvent {
  validateClientEvent(value, 'Stored client event');
  if (expected && !sameClientPrincipalRef(value, expected)) {
    rejectClientMutation('Stored client event identity differs from its requested aggregate');
  }
}

export function validateClientMutationIdempotencyRecord(
  value: unknown,
): asserts value is ClientMutationIdempotencyRecord {
  validateClientMutationIdempotencyRecordValue(value, 'Stored client idempotency value');
}
