import type { ClientInstance, ClientPrincipal, ClientSession } from '@shared/api/client-types.ts';

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
  toClientAudit,
  toClientChildCandidate,
  toDefaultClientPrincipal,
} from './compute-client-mutation-state.ts';
import { rejectClientMutation } from '../../client-state-validation-primitives.ts';
import { isPresenceTimestampWithinSkew } from '../../../presence/presence-lease.ts';

type ConnectCommand = Extract<
  ClientMutationCommand,
  { operation: 'connectSession' | 'connectAuthorisedWsSession' }
>;

export function computeClientSessionConnect(
  input: Readonly<{ command: ConnectCommand; read: ClientMutationRead }>,
): ClientMutationComputed {
  const { command, read } = input;
  const existing = read.session?.value;
  if (existing?.generationId === command.input.generationId) {
    return computeClientMutationNoOp({ command, read });
  }
  if (existing && !canReplaceClientSessionGeneration(command, existing)) {
    return computeClientMutationNoOp({ command, read, persistIdempotency: false });
  }
  const principal = read.principal?.value ?? toDefaultClientPrincipal(command);
  const instance = read.instance?.value ?? toDefaultClientInstance(command, principal);
  const session = toActiveClientSession(command, principal, existing);
  const nextPrincipal = read.principal
    ? bumpClientPrincipal({
        principal,
        mutationInput: command.input,
        facts: command.facts,
        requestId: command.requestId,
        domain: 'presence',
        lastSeenAtEpochMs: session.lastHeartbeatAtEpochMs,
      })
    : principal;
  return computeClientMutationResult({
    command,
    read,
    principal: nextPrincipal,
    instance: read.instance ? { operation: 'none' } : { operation: 'insert', value: instance },
    session: toClientChildCandidate(read.session, session, read.expiredSessionEntry),
    eventType: 'session-connected',
    clientInstanceId: command.clientInstanceId,
    sessionId: command.sessionId,
  });
}

function canReplaceClientSessionGeneration(
  command: ConnectCommand,
  existing: ClientSession,
): boolean {
  // A REST compatibility connect without an ordered generation-start fact may
  // create an absent session, but it cannot replace a distinct generation.
  if (command.input.connectedAtEpochMs === null) return false;
  return (
    compareGenerationTuple({
      leftStartedAtEpochMs: command.input.connectedAtEpochMs,
      leftGenerationId: command.input.generationId,
      rightStartedAtEpochMs: existing.connectedAtEpochMs,
      rightGenerationId: existing.generationId,
    }) > 0
  );
}

function compareGenerationTuple(
  input: Readonly<{
    leftStartedAtEpochMs: number;
    leftGenerationId: string;
    rightStartedAtEpochMs: number;
    rightGenerationId: string;
  }>,
): number {
  // Starts are process-monotonic. Across servers, wall-clock time is the
  // primary order and the opaque generation id deterministically breaks ties.
  if (input.leftStartedAtEpochMs !== input.rightStartedAtEpochMs) {
    return input.leftStartedAtEpochMs < input.rightStartedAtEpochMs ? -1 : 1;
  }
  if (input.leftGenerationId === input.rightGenerationId) return 0;
  return input.leftGenerationId < input.rightGenerationId ? -1 : 1;
}

function toDefaultClientInstance(
  command: ConnectCommand,
  principal: ClientPrincipal,
): ClientInstance {
  const audit = toClientAudit(command);
  return {
    applicationId: principal.applicationId,
    workspaceId: principal.workspaceId,
    principalId: principal.principalId,
    clientInstanceId: command.clientInstanceId,
    status: 'active',
    platform:
      command.input.instancePlatform ??
      (command.operation === 'connectAuthorisedWsSession' ? 'web' : 'unknown'),
    deviceLabel: null,
    appVersion: null,
    userAgent: command.input.instanceUserAgent,
    capabilities:
      command.input.instanceCapabilities ??
      (command.input.transport ? [command.input.transport] : []),
    registered: audit,
    updated: audit,
    revoked: null,
  };
}

function toActiveClientSession(
  command: ConnectCommand,
  principal: ClientPrincipal,
  existing: ClientSession | undefined,
): ClientSession {
  const nowEpochMs = command.facts.nowEpochMs;
  const connectedAt = command.input.connectedAtEpochMs ?? nowEpochMs;
  if (!isPresenceTimestampWithinSkew(connectedAt, nowEpochMs)) {
    rejectClientMutation('Client session connectedAtEpochMs is too far in the future.');
  }
  const heartbeatAt = command.input.lastHeartbeatAtEpochMs ?? connectedAt;
  if (!isPresenceTimestampWithinSkew(heartbeatAt, nowEpochMs)) {
    rejectClientMutation('Client session lastHeartbeatAtEpochMs is too far in the future.');
  }
  return {
    applicationId: principal.applicationId,
    workspaceId: principal.workspaceId,
    principalId: principal.principalId,
    clientInstanceId: command.clientInstanceId,
    sessionId: command.sessionId,
    generationId: command.input.generationId,
    generationVersion: (existing?.generationVersion ?? 0) + 1,
    status: 'active',
    presenceState: command.input.presenceState ?? 'online',
    transport: command.input.transport ?? 'unknown',
    connectionId: command.input.connectionId,
    authenticatedAtEpochMs: command.input.authenticatedAtEpochMs ?? connectedAt,
    connectedAtEpochMs: connectedAt,
    lastHeartbeatAtEpochMs: heartbeatAt,
    expiresAtEpochMs: command.input.expiresAtEpochMs ?? heartbeatAt + 24 * 60 * 60 * 1000,
    disconnectedAtEpochMs: null,
    disconnectReason: null,
  };
}
