import type { ClientSession } from '@shared/api/client-types.ts';

import type {
  ClientMutationCommand,
  ClientMutationComputed,
  ClientMutationRead,
} from '../client-mutation-contracts.ts';
import {
  computeClientMutationNoOp,
  computeClientMutationResult,
} from './compute-client-mutation-result.ts';
import { bumpClientPrincipal, toClientChildCandidate } from './compute-client-mutation-state.ts';

type ExpiryCommand = Extract<ClientMutationCommand, { operation: 'expireSession' }>;

export function computeClientSessionExpiry(
  input: Readonly<{ command: ExpiryCommand; read: ClientMutationRead }>,
): ClientMutationComputed {
  const { command, read } = input;
  const principal = read.principal?.value;
  const existing = read.session?.value;
  if (!principal || !existing || !isCurrentExpiredSession(command, existing)) {
    return computeClientMutationNoOp({ command, read, persistIdempotency: false });
  }
  const session: ClientSession = {
    ...existing,
    status: 'expired',
    disconnectedAtEpochMs: command.input.expiresAtEpochMs,
    disconnectReason: 'expired',
  };
  const nextPrincipal = bumpClientPrincipal({
    principal,
    mutationInput: command.input,
    facts: command.facts,
    requestId: command.requestId,
    domain: 'presence',
    lastSeenAtEpochMs: command.input.expiresAtEpochMs,
  });
  return computeClientMutationResult({
    command,
    read,
    principal: nextPrincipal,
    instance: { operation: 'none' },
    session: toClientChildCandidate(read.session, session),
    eventType: 'session-expired',
    clientInstanceId: command.clientInstanceId,
    sessionId: command.sessionId,
  });
}

function isCurrentExpiredSession(command: ExpiryCommand, existing: ClientSession): boolean {
  return (
    existing.generationId === command.input.generationId &&
    existing.generationVersion === command.input.generationVersion &&
    existing.expiresAtEpochMs === command.input.observedExpiresAtEpochMs &&
    existing.status === 'active' &&
    existing.disconnectedAtEpochMs === null &&
    existing.expiresAtEpochMs <= command.input.expiresAtEpochMs
  );
}
