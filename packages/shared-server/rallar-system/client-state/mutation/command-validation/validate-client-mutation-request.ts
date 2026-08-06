import type {
  ConnectClientSessionRequest,
  DisconnectClientSessionRequest,
  HeartbeatClientSessionRequest,
  UpsertClientInstanceRequest,
  UpsertClientPrincipalRequest,
} from '@shared/api/state-types.ts';

import {
  rejectClientMutation,
  requireAllowedKeys,
  requireJsonRecord,
  requireNonEmptyString,
  requireOptionalEnum,
  requireOptionalNonEmptyString,
  requireOptionalString,
  requireOptionalTimestamp,
  requirePlainRecord,
  requireStringArray,
} from '../../client-state-validation-primitives.ts';
import type { ClientValidationRecord } from '../../client-state-validation-primitives.ts';
import {
  CLIENT_INSTANCE_STATUSES,
  CLIENT_PLATFORMS,
  CLIENT_PRESENCE_STATES,
  CLIENT_PRINCIPAL_STATUSES,
  CLIENT_TRANSPORTS,
} from '../client-mutation-contracts.ts';

export function validateClientMutationRequest(
  operation: 'upsertPrincipal',
  request: unknown,
): asserts request is UpsertClientPrincipalRequest;
export function validateClientMutationRequest(
  operation: 'upsertInstance',
  request: unknown,
): asserts request is UpsertClientInstanceRequest;
export function validateClientMutationRequest(
  operation: 'connectSession',
  request: unknown,
): asserts request is ConnectClientSessionRequest;
export function validateClientMutationRequest(
  operation: 'heartbeatSession',
  request: unknown,
): asserts request is HeartbeatClientSessionRequest;
export function validateClientMutationRequest(
  operation: 'disconnectSession',
  request: unknown,
): asserts request is DisconnectClientSessionRequest;
export function validateClientMutationRequest(
  operation:
    | 'upsertPrincipal'
    | 'upsertInstance'
    | 'connectSession'
    | 'heartbeatSession'
    | 'disconnectSession',
  request: unknown,
): void {
  const value = requirePlainRecord(request, `Client ${operation} request`);
  validateOptionalActorInput(value);
  validateRequestOperation(operation, value);
}

function validateRequestOperation(
  operation:
    | 'upsertPrincipal'
    | 'upsertInstance'
    | 'connectSession'
    | 'heartbeatSession'
    | 'disconnectSession',
  value: ClientValidationRecord,
): void {
  switch (operation) {
    case 'upsertPrincipal':
      return validatePrincipalRequest(value);
    case 'upsertInstance':
      return validateInstanceRequest(value);
    case 'connectSession':
      return validateConnectRequest(value);
    case 'heartbeatSession':
      return validateHeartbeatRequest(value);
    case 'disconnectSession':
      return validateDisconnectRequest(value);
  }
}

function validatePrincipalRequest(value: ClientValidationRecord): void {
  requireAllowedKeys({
    value,
    required: ['username'],
    allowed: principalRequestKeys,
    label: 'Client upsertPrincipal request',
  });
  requireNonEmptyString(value.username, 'Client principal username');
  requireOptionalString(value.displayName, 'Client principal displayName');
  requireOptionalString(value.avatarUrl, 'Client principal avatarUrl');
  requireOptionalEnum(value.status, CLIENT_PRINCIPAL_STATUSES, 'Client principal status');
  requireOptionalString(value.authProvider, 'Client principal authProvider');
  requireOptionalString(value.externalSubjectId, 'Client principal externalSubjectId');
  if (value.roles !== undefined) requireStringArray(value.roles, 'Client principal roles');
  if (value.metadata !== undefined) requireJsonRecord(value.metadata, 'Client principal metadata');
  requireOptionalTimestamp(value.lastSeenAtEpochMs, 'Client principal lastSeenAtEpochMs');
}

function validateInstanceRequest(value: ClientValidationRecord): void {
  requireAllowedKeys({
    value,
    required: [],
    allowed: instanceRequestKeys,
    label: 'Client upsertInstance request',
  });
  requireOptionalEnum(value.status, CLIENT_INSTANCE_STATUSES, 'Client instance status');
  requireOptionalEnum(value.platform, CLIENT_PLATFORMS, 'Client instance platform');
  for (const field of ['deviceLabel', 'appVersion', 'userAgent'] as const) {
    requireOptionalString(value[field], `Client instance ${field}`);
  }
  if (value.capabilities !== undefined) {
    requireStringArray(value.capabilities, 'Client instance capabilities');
  }
}

function validateConnectRequest(value: ClientValidationRecord): void {
  requireAllowedKeys({
    value,
    required: ['generationId'],
    allowed: connectRequestKeys,
    label: 'Client connectSession request',
  });
  validateGenerationId(value.generationId);
  requireOptionalEnum(value.presenceState, CLIENT_PRESENCE_STATES, 'Client connect presenceState');
  requireOptionalEnum(value.transport, CLIENT_TRANSPORTS, 'Client connect transport');
  requireOptionalNonEmptyString(value.connectionId, 'Client connect connectionId');
  for (const field of connectTimestampFields) {
    requireOptionalTimestamp(value[field], `Client connect ${field}`);
  }
  validateConnectTimestampOrder(value);
}

function validateHeartbeatRequest(value: ClientValidationRecord): void {
  requireAllowedKeys({
    value,
    required: ['generationId'],
    allowed: heartbeatRequestKeys,
    label: 'Client heartbeatSession request',
  });
  validateGenerationId(value.generationId);
  requireOptionalEnum(
    value.presenceState,
    CLIENT_PRESENCE_STATES,
    'Client heartbeat presenceState',
  );
  requireOptionalTimestamp(value.lastHeartbeatAtEpochMs, 'Client heartbeat lastHeartbeatAtEpochMs');
  requireOptionalTimestamp(value.expiresAtEpochMs, 'Client heartbeat expiresAtEpochMs');
  validateHeartbeatTimestampOrder(value);
}

function validateDisconnectRequest(value: ClientValidationRecord): void {
  requireAllowedKeys({
    value,
    required: ['generationId'],
    allowed: disconnectRequestKeys,
    label: 'Client disconnectSession request',
  });
  validateGenerationId(value.generationId);
  for (const field of disconnectTimestampFields) {
    requireOptionalTimestamp(value[field], `Client disconnect ${field}`);
  }
  validateDisconnectTimestampOrder(value);
}

function validateOptionalActorInput(input: ClientValidationRecord): void {
  requireOptionalNonEmptyString(input.actorPrincipalId, 'Client request actorPrincipalId');
  requireOptionalNonEmptyString(input.actorSessionId, 'Client request actorSessionId');
  requireOptionalString(input.reason, 'Client request reason');
  requireOptionalString(input.traceId, 'Client request traceId');
  requireOptionalNonEmptyString(input.requestId, 'Client request requestId');
}

function validateGenerationId(value: unknown): void {
  requireNonEmptyString(value, 'Client session generationId');
}

function validateConnectTimestampOrder(input: ClientValidationRecord): void {
  const authenticatedAt = timestampValue(input.authenticatedAtEpochMs);
  const connectedAt = timestampValue(input.connectedAtEpochMs);
  const heartbeatAt = timestampValue(input.lastHeartbeatAtEpochMs);
  const expiresAt = timestampValue(input.expiresAtEpochMs);
  if (authenticatedAt !== undefined && connectedAt !== undefined && authenticatedAt > connectedAt) {
    rejectClientMutation(
      'Client connect authenticatedAtEpochMs must not follow connectedAtEpochMs',
    );
  }
  if (connectedAt !== undefined && heartbeatAt !== undefined && connectedAt > heartbeatAt) {
    rejectClientMutation(
      'Client connect lastHeartbeatAtEpochMs must not predate connectedAtEpochMs',
    );
  }
  if (heartbeatAt !== undefined && expiresAt !== undefined && heartbeatAt > expiresAt) {
    rejectClientMutation('Client connect expiresAtEpochMs must not predate lastHeartbeatAtEpochMs');
  }
}

function validateHeartbeatTimestampOrder(input: ClientValidationRecord): void {
  const heartbeatAt = timestampValue(input.lastHeartbeatAtEpochMs);
  const expiresAt = timestampValue(input.expiresAtEpochMs);
  if (heartbeatAt !== undefined && expiresAt !== undefined && expiresAt < heartbeatAt) {
    rejectClientMutation(
      'Client heartbeat expiresAtEpochMs must not predate lastHeartbeatAtEpochMs',
    );
  }
}

function validateDisconnectTimestampOrder(input: ClientValidationRecord): void {
  const disconnectedAt = timestampValue(input.disconnectedAtEpochMs);
  const heartbeatAt = timestampValue(input.lastHeartbeatAtEpochMs);
  const expiresAt = timestampValue(input.expiresAtEpochMs);
  if (disconnectedAt !== undefined && heartbeatAt !== undefined && disconnectedAt < heartbeatAt) {
    rejectClientMutation(
      'Client disconnect disconnectedAtEpochMs must not predate lastHeartbeatAtEpochMs',
    );
  }
  if (expiresAt !== undefined && heartbeatAt !== undefined && expiresAt < heartbeatAt) {
    rejectClientMutation(
      'Client disconnect expiresAtEpochMs must not predate lastHeartbeatAtEpochMs',
    );
  }
}

function timestampValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

const actorKeys = ['actorPrincipalId', 'actorSessionId', 'reason', 'traceId', 'requestId'] as const;
const principalRequestKeys = [
  'username',
  'displayName',
  'avatarUrl',
  'status',
  'authProvider',
  'externalSubjectId',
  'roles',
  'metadata',
  'lastSeenAtEpochMs',
  ...actorKeys,
] as const;
const instanceRequestKeys = [
  'status',
  'platform',
  'deviceLabel',
  'appVersion',
  'userAgent',
  'capabilities',
  ...actorKeys,
] as const;
const connectTimestampFields = [
  'authenticatedAtEpochMs',
  'connectedAtEpochMs',
  'lastHeartbeatAtEpochMs',
  'expiresAtEpochMs',
] as const;
const connectRequestKeys = [
  'generationId',
  'presenceState',
  'transport',
  'connectionId',
  ...connectTimestampFields,
  ...actorKeys,
] as const;
const heartbeatRequestKeys = [
  'generationId',
  'presenceState',
  'lastHeartbeatAtEpochMs',
  'expiresAtEpochMs',
  ...actorKeys,
] as const;
const disconnectTimestampFields = [
  'disconnectedAtEpochMs',
  'lastHeartbeatAtEpochMs',
  'expiresAtEpochMs',
] as const;
const disconnectRequestKeys = ['generationId', ...disconnectTimestampFields, ...actorKeys] as const;
