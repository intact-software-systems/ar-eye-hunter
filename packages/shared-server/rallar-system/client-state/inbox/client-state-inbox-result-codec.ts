import {
  validateAuthoritativeClientEvent,
  validateAuthoritativeClientSnapshot,
} from '@shared/api/authoritative-state-validation.ts';
import { Either } from '@shared/resilience/Either.ts';

import { requireExactKeys, requireString } from '../../services/exact-object-codec.ts';
import type { JsonWireObject, JsonWireValue } from '../../services/mutation-command-identity.ts';
import type { ClientStateWritten } from '../client-state-service-contracts.ts';

export interface InactiveAuthorisedWsSessionResult {
  readonly status: 'inactive';
  readonly sessionId: string;
  readonly generationId: string;
}

export type AuthorisedWsClientMutationResult =
  ClientStateWritten | InactiveAuthorisedWsSessionResult;

export function decodeClientStateWritten(value: JsonWireValue): ClientStateWritten {
  const written = requireJsonWireRecord(value, 'Client state result');
  requireExactKeys(written, ['status', 'result'], 'Client state result');
  if (written.status !== 'ok') {
    throw new TypeError('Client state result status is invalid');
  }
  return { status: 'ok', result: decodeClientMutationEither(written.result) };
}

export function decodeAuthorisedWsClientMutationResult(
  value: JsonWireValue,
): AuthorisedWsClientMutationResult {
  const result = requireJsonWireRecord(value, 'Authorised websocket client result');
  if (result.status !== 'inactive') {
    return decodeClientStateWritten(value);
  }
  requireExactKeys(
    result,
    ['status', 'sessionId', 'generationId'],
    'Authorised websocket client result',
  );
  requireString(result.sessionId, 'Authorised websocket client result sessionId');
  requireString(result.generationId, 'Authorised websocket client result generationId');
  return {
    status: 'inactive',
    sessionId: result.sessionId,
    generationId: result.generationId,
  };
}

export function decodeExpiredClientSessionsResult(
  value: JsonWireValue,
): readonly ClientStateWritten[] {
  if (!Array.isArray(value)) {
    throw new TypeError('Expired client sessions result must be an array');
  }
  return value.map(decodeClientStateWritten);
}

function decodeClientMutationEither(value: JsonWireValue): ClientStateWritten['result'] {
  const result = requireJsonWireRecord(value, 'Client state mutation result');
  if (Object.hasOwn(result, 'left')) {
    requireExactKeys(result, ['left'], 'Client state mutation result');
    requireString(result.left, 'Client state mutation result left');
    return Either.ofLeft(result.left);
  }
  requireExactKeys(result, ['right'], 'Client state mutation result');
  const written = requireJsonWireRecord(result.right, 'Client state mutation result right');
  requireExactKeys(written, ['snapshot', 'event'], 'Client state mutation result right');
  validateAuthoritativeClientSnapshot(written.snapshot);
  if (written.event !== null) {
    validateAuthoritativeClientEvent(written.event, {
      applicationId: written.snapshot.principal.applicationId,
      workspaceId: written.snapshot.principal.workspaceId,
      principalId: written.snapshot.principal.principalId,
    });
  }
  return Either.ofRight({ snapshot: written.snapshot, event: written.event });
}

function requireJsonWireRecord(value: JsonWireValue, label: string): JsonWireObject {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be an exact object`);
  }
  return Object.fromEntries(Object.entries(value));
}
