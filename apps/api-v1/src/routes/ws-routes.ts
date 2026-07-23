import { Hono } from 'jsr:@hono/hono@4.11.9';
import { getMiddleware } from '../middleware.ts';
import { requireWsAuthSession, toAuthErrorResponse } from '../services/request-auth-service.ts';
import { ConnectionContext } from '@shared/websocket/JsonWebSocketServer.ts';
import type { RegisterAuthorisedWsClientInput } from '@shared-server/rallar-system/services/client-state-service.ts';
import {
  toAuthorisedWsClientConnectEnqueue,
  type ToAuthorisedWsClientDisconnectEnqueueInput,
} from '@shared-server/rallar-system/services/authorised-ws-client-app-inbox.ts';
import type { ClientAuthorisedWsSessionConnectAppInboxPayload } from '@shared-server/rallar-system/services/AppClientInboxService.ts';
import type { RallarWsLifecycleCloseInput } from '@shared-server/rallar-system/services/ws-lifecycle-service.ts';
import type { GroupPresenceSessionCleanupAppInboxPayload } from '@shared-server/rallar-system/services/app-group-ws-session-lifecycle.ts';

const AUTHORISED_CONNECTIONS = new Map<
  string,
  ClientAuthorisedWsSessionConnectAppInboxPayload
>();

export function init(app: Hono): void {
  app.get(
    '/api/ws/:sessionId',
    async (c) => {
      if (!isWebSocketUpgradeHeader(c.req.header('upgrade'))) {
        return c.text('Expected Upgrade: websocket', 426);
      }

      let upgraded: ReturnType<typeof Deno.upgradeWebSocket> | undefined;

      try {
        const sessionId = c.req.param('sessionId');
        const requestUrl = new URL(c.req.url);
        const ticket = requestUrl.searchParams.get('ticket') ?? undefined;
        const userAgent = c.req.header('user-agent');

        const authSession = await requireWsAuthSession({
          sessionId,
          ticket,
        });

        upgraded = Deno.upgradeWebSocket(c.req.raw);

        const socketServer = getMiddleware().wsQBoxServerService.socket;
        const connection = socketServer.createConnectionContext(
          authSession.sessionId,
          upgraded.socket,
        );
        const connectInput = {
          authSession,
          generationId: connection.generationId,
          input: toAuthorisedWsClientInput(
            requestUrl,
            userAgent,
            connection.generationStartedAtEpochMs,
          ),
        };
        rememberAuthorisedWsConnection(
          connection.id,
          connection.generationId,
          toAuthorisedWsClientConnectEnqueue(connectInput).data,
        );
        socketServer.addConnection(connection);

        await getMiddleware().appClientInboxService
          .enqueueAuthorisedWsClientConnect(connectInput);

        console.log(`Upgrading connection for ID: ${sessionId}`);

        return upgraded.response;
      } catch (err) {
        console.error(err);
        if (upgraded) {
          try {
            upgraded.socket.close(1011, 'WebSocket setup failed');
          } catch (closeError) {
            console.error(closeError);
          }
          return upgraded.response;
        }

        return toAuthErrorResponse(c, err);
      }
    },
  );
}

export function createAuthorisedWsConnectionContext(
  sessionId: string,
  socket: WebSocket,
  generationId: string = crypto.randomUUID(),
): ConnectionContext {
  return new ConnectionContext(sessionId, socket, generationId);
}

export function toAuthorisedWsClientInput(
  url: URL,
  userAgent?: string,
  connectedAtEpochMs?: number,
): RegisterAuthorisedWsClientInput {
  const applicationId = readNonEmptySearchParam(url, 'applicationId');
  const workspaceId = readNonEmptySearchParam(url, 'workspaceId');

  return {
    ...(applicationId ? { applicationId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...(connectedAtEpochMs === undefined ? {} : { connectedAtEpochMs }),
  };
}

export function toAuthorisedWsClientDisconnectInput(
  input: RallarWsLifecycleCloseInput,
): ToAuthorisedWsClientDisconnectEnqueueInput {
  return {
    connection: readAuthorisedWsConnection(input),
    disconnectedAtEpochMs: input.disconnectedAtEpochMs,
    reason: input.reason,
  };
}

export function toGroupPresenceSessionCleanupInput(
  input: RallarWsLifecycleCloseInput,
): GroupPresenceSessionCleanupAppInboxPayload {
  return {
    connection: readAuthorisedWsConnection(input),
    disconnectedAtEpochMs: input.disconnectedAtEpochMs,
    reason: input.reason,
  };
}

export function releaseAuthorisedWsCloseFacts(
  input: RallarWsLifecycleCloseInput,
): void {
  const key = toAuthorisedConnectionKey(input.sessionId, input.generationId);
  const connection = AUTHORISED_CONNECTIONS.get(key);
  if (
    connection &&
    connection.generationStartedAtEpochMs === input.generationStartedAtEpochMs
  ) {
    AUTHORISED_CONNECTIONS.delete(key);
  }
}

function rememberAuthorisedWsConnection(
  sessionId: string,
  generationId: string,
  connection: ClientAuthorisedWsSessionConnectAppInboxPayload,
): void {
  AUTHORISED_CONNECTIONS.set(
    toAuthorisedConnectionKey(sessionId, generationId),
    connection,
  );
}

function readAuthorisedWsConnection(
  input: RallarWsLifecycleCloseInput,
): ClientAuthorisedWsSessionConnectAppInboxPayload {
  const key = toAuthorisedConnectionKey(input.sessionId, input.generationId);
  const connection = AUTHORISED_CONNECTIONS.get(key);
  if (
    !connection ||
    connection.generationStartedAtEpochMs !== input.generationStartedAtEpochMs
  ) {
    throw new Error('Trusted authorised WebSocket connection facts are unavailable');
  }
  return connection;
}

function toAuthorisedConnectionKey(sessionId: string, generationId: string): string {
  return [sessionId, generationId].map(encodeURIComponent).join(':');
}

function isWebSocketUpgradeHeader(upgrade?: string): boolean {
  return upgrade?.trim().toLowerCase() === 'websocket';
}

function readNonEmptySearchParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim();
  return value ? value : undefined;
}
