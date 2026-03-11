import { Hono } from 'jsr:@hono/hono';
import { getMiddleware } from '../middleware.ts';
import { requireWsAuthSession, toAuthErrorResponse } from '../services/request-auth-service.ts';
import { ConnectionContext } from '@shared/websocket/JsonWebSocketServer.ts';
import { getClientStateService } from '../services/client-state-service.ts';

export function init(app: Hono): void {
    app.get(
        '/api/ws/:sessionId',
        async (c) => {
            if (c.req.header('upgrade') !== 'websocket') {
                return c.text('Expected Upgrade: websocket', 426);
            }

            try {
                const sessionId = c.req.param('sessionId');
                const ticket = new URL(c.req.url).searchParams.get('ticket') ?? undefined;

                const authSession = await requireWsAuthSession({
                    sessionId,
                    ticket,
                });

                const { socket, response } = Deno.upgradeWebSocket(c.req.raw);

                getMiddleware().wsQBoxServerService.socket.addConnection(
                    new ConnectionContext(authSession.sessionId, socket),
                );

                await getClientStateService().registerAuthorisedWsClientSession(
                    authSession,
                    {
                        userAgent: c.req.header('user-agent'),
                    },
                );

                console.log(`Upgrading connection for ID: ${sessionId}`);

                return response;
            } catch (err) {
                console.error(err);
                return toAuthErrorResponse(c, err);
            }
        },
    );
}
