import { Hono } from 'jsr:@hono/hono@4.11.9';
import { getMiddleware } from '../middleware.ts';
import { requireWsAuthSession, toAuthErrorResponse } from '../services/request-auth-service.ts';
import { ConnectionContext } from '@shared/websocket/JsonWebSocketServer.ts';
import type { RegisterAuthorisedWsClientInput } from '@shared-server/rallar-system/services/client-state-service.ts';

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

        getMiddleware().wsQBoxServerService.socket.addConnection(
          new ConnectionContext(authSession.sessionId, upgraded.socket),
        );

        const clientStateWritten = await getMiddleware().appClientInboxService
          .processAuthorisedWsClientConnect(
            authSession,
            toAuthorisedWsClientInput(requestUrl, userAgent),
          );
        clientStateWritten.fold(
          (error) => {
            throw new Error(error);
          },
          () => undefined,
        );

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

export function toAuthorisedWsClientInput(
  url: URL,
  userAgent?: string,
): RegisterAuthorisedWsClientInput {
  const applicationId = readNonEmptySearchParam(url, 'applicationId');
  const workspaceId = readNonEmptySearchParam(url, 'workspaceId');

  return {
    ...(applicationId ? { applicationId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
}

function isWebSocketUpgradeHeader(upgrade?: string): boolean {
  return upgrade?.trim().toLowerCase() === 'websocket';
}

function readNonEmptySearchParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim();
  return value ? value : undefined;
}
