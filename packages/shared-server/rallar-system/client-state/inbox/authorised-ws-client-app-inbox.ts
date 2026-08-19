import {
  DEFAULT_STATE_APPLICATION_ID,
  DEFAULT_STATE_WORKSPACE_ID,
  type StateScope,
} from '@shared/api/state-types.ts';
import type { IssuedAuthSession } from '../../repositories/AuthSessionRepository.ts';
import type { RegisterAuthorisedWsClientInput } from '../client-state-service-contracts.ts';
import { toClientMutationIssuedSessionAuthority } from '../mutation/client-mutation-authority.ts';
import type { AppInboxEnqueueInput } from '../../services/AppInboxService.ts';
import { AppInboxType } from '../../services/AppInboxService.ts';
import type {
  ClientAuthorisedWsSessionConnectAppInboxPayload,
  ClientAuthorisedWsSessionDisconnectAppInboxPayload,
} from './app-client-inbox-contracts.ts';

export interface ToAuthorisedWsClientConnectEnqueueInput {
  readonly authSession: IssuedAuthSession;
  readonly generationId: string;
  readonly input?: RegisterAuthorisedWsClientInput;
}

export interface ToAuthorisedWsClientDisconnectEnqueueInput {
  readonly connection: ClientAuthorisedWsSessionConnectAppInboxPayload;
  readonly disconnectedAtEpochMs: number;
  readonly reason: string;
}

export function toAuthorisedWsClientConnectEnqueue(
  input: ToAuthorisedWsClientConnectEnqueueInput,
): AppInboxEnqueueInput<ClientAuthorisedWsSessionConnectAppInboxPayload> {
  const connection = toAuthorisedWsClientConnection(input);
  return {
    type: AppInboxType.CLIENT_AUTHORISED_WS_CONNECT,
    resourceId: toAuthorisedWsClientConnectResourceId(connection),
    contextId: toClientAppInboxContextId(connection.scope, connection.principalId),
    senderId: connection.authSession.clientId,
    authority: toClientMutationIssuedSessionAuthority(
      input.authSession,
      connection.scope,
      'connectAuthorisedWsSession',
    ),
    data: connection,
  };
}

export function toAuthorisedWsClientDisconnectEnqueue(
  input: ToAuthorisedWsClientDisconnectEnqueueInput,
): AppInboxEnqueueInput<ClientAuthorisedWsSessionDisconnectAppInboxPayload> {
  const connection = input.connection;
  return {
    type: AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT,
    resourceId: `authorised-ws-disconnect-${encodeURIComponent(
      connection.authSession.sessionId,
    )}-${encodeURIComponent(connection.generationId)}`,
    contextId: connection.authSession.sessionId,
    senderId: connection.authSession.sessionId,
    authority: toClientMutationIssuedSessionAuthority(
      toIssuedAuthSession(connection.authSession),
      connection.scope,
      'disconnectAuthorisedWsSession',
    ),
    data: {
      connection,
      disconnectedAtEpochMs: input.disconnectedAtEpochMs,
      reason: input.reason,
    },
  };
}

export function toAuthorisedWsClientScope(
  input: RegisterAuthorisedWsClientInput | undefined,
): StateScope {
  return {
    applicationId: input?.applicationId ?? DEFAULT_STATE_APPLICATION_ID,
    workspaceId: input?.workspaceId ?? DEFAULT_STATE_WORKSPACE_ID,
  };
}

function toAuthorisedWsClientConnection(
  input: ToAuthorisedWsClientConnectEnqueueInput,
): ClientAuthorisedWsSessionConnectAppInboxPayload {
  const scope = toAuthorisedWsClientScope(input.input);
  const authSession = input.authSession;
  const principalId = input.input?.principalId ?? authSession.clientId;
  return {
    authSession: {
      clientId: authSession.clientId,
      username: authSession.username,
      sessionId: authSession.sessionId,
      issuedAtEpochMs: authSession.issuedAtEpochMs,
      expiresAtEpochMs: authSession.expiresAtEpochMs,
    },
    generationId: input.generationId,
    generationStartedAtEpochMs: input.input?.connectedAtEpochMs ?? authSession.issuedAtEpochMs,
    scope,
    principalId,
    clientInstanceId: input.input?.clientInstanceId ?? authSession.clientId,
    displayName: input.input?.displayName ?? authSession.username,
    userAgent: input.input?.userAgent ?? null,
    platform: input.input?.platform ?? 'web',
    capabilities: input.input?.capabilities ?? [],
    expiresAtEpochMs: input.input?.expiresAtEpochMs ?? authSession.expiresAtEpochMs,
  };
}

function toAuthorisedWsClientConnectResourceId(
  connection: ClientAuthorisedWsSessionConnectAppInboxPayload,
): string {
  return [
    'authorised-ws-connect',
    connection.scope.applicationId,
    connection.scope.workspaceId,
    connection.principalId,
    connection.clientInstanceId,
    connection.authSession.sessionId,
    connection.generationId,
  ]
    .map(encodeURIComponent)
    .join(':');
}

function toClientAppInboxContextId(scope: StateScope, principalId: string): string {
  return [scope.applicationId, scope.workspaceId, principalId].map(encodeURIComponent).join(':');
}

function toIssuedAuthSession(
  authSession: ClientAuthorisedWsSessionConnectAppInboxPayload['authSession'],
): IssuedAuthSession {
  return {
    ...authSession,
    accessToken: '',
  };
}
