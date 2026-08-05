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
import {
  bumpClientPrincipal,
  requireClientPrincipal,
  requireClientSession,
  toClientChildCandidate,
} from './compute-client-mutation-state.ts';

type DisconnectCommand = Extract<
  ClientMutationCommand,
  { operation: 'disconnectSession' | 'disconnectAuthorisedWsSession' }
>;

export function computeClientSessionDisconnect(
  input: Readonly<{ command: DisconnectCommand; read: ClientMutationRead }>,
): ClientMutationComputed {
  const { command, read } = input;
  const principal = requireClientPrincipal(read, command);
  const existing = requireClientSession(read, command);
  if (
    existing.generationId !== command.input.generationId ||
    existing.status !== 'active' ||
    existing.disconnectedAtEpochMs !== null
  ) {
    return computeClientMutationNoOp({ command, read, persistIdempotency: false });
  }
  const heartbeatAt = Math.max(
    existing.lastHeartbeatAtEpochMs,
    command.input.lastHeartbeatAtEpochMs ?? existing.lastHeartbeatAtEpochMs,
  );
  const disconnectedAt = Math.max(
    command.input.disconnectedAtEpochMs ?? command.facts.nowEpochMs,
    heartbeatAt,
  );
  const session: ClientSession = {
    ...existing,
    status: 'disconnected',
    lastHeartbeatAtEpochMs: heartbeatAt,
    expiresAtEpochMs: Math.max(
      existing.expiresAtEpochMs,
      command.input.expiresAtEpochMs ?? existing.expiresAtEpochMs,
      heartbeatAt,
    ),
    disconnectedAtEpochMs: disconnectedAt,
    disconnectReason: command.input.reason ?? 'closed',
  };
  const nextPrincipal = bumpClientPrincipal({
    principal,
    mutationInput: command.input,
    facts: command.facts,
    requestId: command.requestId,
    domain: 'presence',
    lastSeenAtEpochMs: disconnectedAt,
  });
  return computeClientMutationResult({
    command,
    read,
    principal: nextPrincipal,
    instance: { operation: 'none' },
    session: toClientChildCandidate(read.session, session),
    eventType: 'session-disconnected',
    clientInstanceId: command.clientInstanceId,
    sessionId: command.sessionId,
  });
}
