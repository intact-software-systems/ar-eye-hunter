import {
  DEFAULT_STATE_APPLICATION_ID,
  DEFAULT_STATE_WORKSPACE_ID,
  type StateScope,
} from '@shared/api/state-types.ts';
import { NonRetryableException } from '@shared/queuebox/DequeueResourceEntryController.ts';
import type { IssuedAuthSession } from '../repositories/AuthSessionRepository.ts';
import type {
  ClientStateService,
  RegisterAuthorisedWsClientInput,
} from './client-state-service.ts';
import { toClientMutationIssuedSessionAuthority } from './client-state-service.ts';
import type { AppInboxEnqueueInput } from './AppInboxService.ts';
import { AppInboxType } from './AppInboxService.ts';
import type {
  ClientAuthorisedWsSessionConnectAppInboxPayload,
  ClientAuthorisedWsSessionDisconnectAppInboxPayload,
} from './AppClientInboxService.ts';

export function toAuthorisedWsClientConnectEnqueue(
  authSession: IssuedAuthSession,
  generationId: string,
  input?: RegisterAuthorisedWsClientInput,
): AppInboxEnqueueInput<ClientAuthorisedWsSessionConnectAppInboxPayload> {
  const scope = toAuthorisedWsClientScope(input);
  const principalId = input?.principalId ?? authSession.clientId;
  const clientInstanceId = input?.clientInstanceId ?? authSession.clientId;
  return {
    type: AppInboxType.CLIENT_AUTHORISED_WS_CONNECT,
    resourceId: toAuthorisedWsClientConnectResourceId(
      scope,
      principalId,
      clientInstanceId,
      authSession.sessionId,
      generationId,
    ),
    contextId: toClientAppInboxContextId(scope, principalId),
    senderId: authSession.clientId,
    authority: toClientMutationIssuedSessionAuthority(
      authSession,
      scope,
      'connectAuthorisedWsSession',
    ),
    data: {
      authSession: {
        clientId: authSession.clientId,
        username: authSession.username,
        sessionId: authSession.sessionId,
        issuedAtEpochMs: authSession.issuedAtEpochMs,
        expiresAtEpochMs: authSession.expiresAtEpochMs,
      },
      generationId,
      input: input ?? {},
    },
  };
}

export async function toAuthorisedWsClientDisconnectEnqueue(
  clientStateService: ClientStateService,
  sessionId: string,
  generationId: string,
  reason?: string,
): Promise<AppInboxEnqueueInput<ClientAuthorisedWsSessionDisconnectAppInboxPayload>> {
  const [authSession, session] = await Promise.all([
    clientStateService.readIssuedAuthSession(sessionId),
    clientStateService.findSessionBySessionId(sessionId),
  ]);
  if (!authSession || !session) {
    throw new NonRetryableException(
      `Durable authorised WebSocket authority not found: ${sessionId}`,
    );
  }
  const scope = {
    applicationId: session.applicationId,
    workspaceId: session.workspaceId,
  };
  if (authSession.clientId !== session.principalId) {
    throw new NonRetryableException(
      'Durable authorised WebSocket principal differs from auth session.',
    );
  }
  return {
    type: AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT,
    resourceId: `authorised-ws-disconnect-${sessionId}-${generationId}`,
    contextId: sessionId,
    senderId: sessionId,
    authority: toClientMutationIssuedSessionAuthority(
      authSession,
      scope,
      'disconnectAuthorisedWsSession',
    ),
    data: {
      sessionId,
      generationId,
      reason: reason ?? 'websocket-closed',
    },
  };
}

export function toAuthorisedWsClientScope(
  input?: RegisterAuthorisedWsClientInput,
): StateScope {
  return {
    applicationId: input?.applicationId ?? DEFAULT_STATE_APPLICATION_ID,
    workspaceId: input?.workspaceId ?? DEFAULT_STATE_WORKSPACE_ID,
  };
}

function toAuthorisedWsClientConnectResourceId(
  scope: StateScope,
  principalId: string,
  clientInstanceId: string,
  sessionId: string,
  generationId: string,
): string {
  return [
    'authorised-ws-connect',
    scope.applicationId,
    scope.workspaceId,
    principalId,
    clientInstanceId,
    sessionId,
    generationId,
  ].map(encodeURIComponent).join(':');
}

function toClientAppInboxContextId(scope: StateScope, principalId: string): string {
  return [scope.applicationId, scope.workspaceId, principalId]
    .map(encodeURIComponent)
    .join(':');
}
