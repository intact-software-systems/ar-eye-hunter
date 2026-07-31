import type { GroupPresenceSession } from '@shared/api/group-types.ts';
import type {
  ConnectGroupPresenceSessionRequest,
  DisconnectGroupPresenceSessionRequest,
  HeartbeatGroupPresenceSessionRequest,
  StateScope,
} from '@shared/api/state-types.ts';
import { NonRetryableException } from '@shared/queuebox/DequeueResourceEntryController.ts';

import type { GroupMutationCommand } from '../services/group-state-mutations.ts';
import { canonicalJson } from '../services/group-state-crypto.ts';
import { toGroupMutationActorInput, toGroupMutationIdentity } from './group-mutation-command.ts';
import type { GroupMutationDescriptor } from './group-state-service-contracts.ts';

export function toPresenceMutationCommand(
  descriptor: GroupMutationDescriptor,
  randomId: () => string,
): GroupMutationCommand {
  const sessionId = requireSessionId(descriptor);
  switch (descriptor.operation) {
    case 'connectPresence':
      return toConnectPresenceCommand(
        descriptor.scope,
        descriptor.groupId,
        sessionId,
        descriptor.request as ConnectGroupPresenceSessionRequest,
        randomId,
      );
    case 'heartbeatPresence':
      return toHeartbeatPresenceCommand(
        descriptor.scope,
        descriptor.groupId,
        sessionId,
        descriptor.request as HeartbeatGroupPresenceSessionRequest,
        randomId,
      );
    case 'disconnectPresence':
      return toDisconnectPresenceCommand(
        descriptor.scope,
        descriptor.groupId,
        sessionId,
        descriptor.request as DisconnectGroupPresenceSessionRequest,
        randomId,
      );
    default:
      throw new TypeError(`Unsupported presence group mutation: ${descriptor.operation}`);
  }
}

function requireSessionId(descriptor: GroupMutationDescriptor): string {
  if (!descriptor.sessionId) {
    throw new NonRetryableException('Group mutation session is required');
  }
  return descriptor.sessionId;
}

function toConnectPresenceCommand(
  scope: StateScope,
  groupId: string,
  sessionId: string,
  request: ConnectGroupPresenceSessionRequest,
  randomId: () => string,
): GroupMutationCommand {
  requireGenerationId(request.generationId);
  return {
    operation: 'connectPresence',
    aggregateRef: { ...scope, groupId },
    sessionId,
    ...toGroupMutationIdentity(request.requestId, randomId),
    input: {
      principalId: request.principalId,
      generationId: request.generationId,
      connectedAtEpochMs: request.connectedAtEpochMs ?? null,
      lastHeartbeatAtEpochMs: request.lastHeartbeatAtEpochMs ?? null,
      expiresAtEpochMs: request.expiresAtEpochMs ?? null,
      ...toGroupMutationActorInput(request),
      actorPrincipalId: request.actorPrincipalId ?? request.principalId,
    },
  };
}

function toHeartbeatPresenceCommand(
  scope: StateScope,
  groupId: string,
  sessionId: string,
  request: HeartbeatGroupPresenceSessionRequest,
  randomId: () => string,
): GroupMutationCommand {
  requireGenerationId(request.generationId);
  return {
    operation: 'heartbeatPresence',
    aggregateRef: { ...scope, groupId },
    sessionId,
    ...toGroupMutationIdentity(request.requestId, randomId),
    input: {
      principalId: request.principalId ?? null,
      generationId: request.generationId,
      lastHeartbeatAtEpochMs: request.lastHeartbeatAtEpochMs ?? null,
      expiresAtEpochMs: request.expiresAtEpochMs ?? null,
      ...toGroupMutationActorInput(request),
    },
  };
}

function toDisconnectPresenceCommand(
  scope: StateScope,
  groupId: string,
  sessionId: string,
  request: DisconnectGroupPresenceSessionRequest,
  randomId: () => string,
): GroupMutationCommand {
  requireGenerationId(request.generationId);
  return {
    operation: 'disconnectPresence',
    aggregateRef: { ...scope, groupId },
    sessionId,
    ...toGroupMutationIdentity(request.requestId, randomId),
    input: {
      principalId: request.principalId ?? null,
      generationId: request.generationId,
      generationVersion: null,
      observedExpiresAtEpochMs: null,
      disconnectedAtEpochMs: request.disconnectedAtEpochMs ?? null,
      lastHeartbeatAtEpochMs: request.lastHeartbeatAtEpochMs ?? null,
      expiresAtEpochMs: request.expiresAtEpochMs ?? null,
      ...toGroupMutationActorInput(request),
    },
  };
}

export function toExpiryCommand(
  session: GroupPresenceSession,
  atEpochMs: number,
): GroupMutationCommand {
  const semanticCommand = {
    operation: 'disconnectPresence',
    aggregateRef: {
      applicationId: session.applicationId,
      workspaceId: session.workspaceId,
      groupId: session.groupId,
    },
    sessionId: session.sessionId,
    input: {
      principalId: session.principalId,
      generationId: session.generationId,
      generationVersion: session.generationVersion,
      observedExpiresAtEpochMs: session.expiresAtEpochMs,
      disconnectedAtEpochMs: atEpochMs,
      lastHeartbeatAtEpochMs: session.lastHeartbeatAtEpochMs,
      expiresAtEpochMs: session.expiresAtEpochMs,
      actorPrincipalId: null,
      actorSessionId: null,
      reason: 'expired',
      traceId: null,
    },
  } as const;
  const commandId = groupStateMaintenanceRequestId('expiry', semanticCommand);
  return { ...semanticCommand, commandId, requestId: commandId };
}

export function toSessionCleanupCommand(
  session: GroupPresenceSession,
  disconnectedAtEpochMs: number,
): GroupMutationCommand {
  const semanticCommand = {
    operation: 'disconnectPresence',
    aggregateRef: {
      applicationId: session.applicationId,
      workspaceId: session.workspaceId,
      groupId: session.groupId,
    },
    sessionId: session.sessionId,
    input: {
      principalId: session.principalId,
      generationId: session.generationId,
      generationVersion: session.generationVersion,
      observedExpiresAtEpochMs: session.expiresAtEpochMs,
      disconnectedAtEpochMs,
      lastHeartbeatAtEpochMs: null,
      expiresAtEpochMs: null,
      actorPrincipalId: null,
      actorSessionId: null,
      reason: null,
      traceId: null,
    },
  } as const;
  const commandId = groupStateMaintenanceRequestId('session-cleanup', semanticCommand);
  return { ...semanticCommand, commandId, requestId: commandId };
}

export type GroupMaintenanceSemanticCommand = Pick<
  Extract<GroupMutationCommand, { operation: 'disconnectPresence' }>,
  'operation' | 'aggregateRef' | 'sessionId' | 'input'
>;

export function groupStateMaintenanceRequestId(
  authority: 'expiry' | 'session-cleanup',
  semanticCommand: GroupMaintenanceSemanticCommand,
): string {
  const domain =
    authority === 'expiry' ? 'expire-group-presence' : 'cleanup-group-presence-session';
  return `${domain}:v1:${canonicalJson(semanticCommand)}`;
}

function requireGenerationId(value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new NonRetryableException('Group presence generation id is required');
  }
}
