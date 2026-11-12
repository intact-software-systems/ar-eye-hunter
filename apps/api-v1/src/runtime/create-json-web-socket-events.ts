import { ConnectionContext, type JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';
import type { WSContext, WSEvents } from 'hono/ws';

export interface JsonWebSocketConnectionIdentity {
    readonly id: string;
    readonly generationId: string;
    readonly generationStartedAtEpochMs: number;
}

/**
 * The Bun WebSocket bridge: one upgraded socket's `hono/bun` events dispatched into the shared JSON server. The
 * events belong to one upgrade, so a replaced socket's close dispatches its own context and never evicts the
 * replacement (the server deletes a connection only while its map still points at that context).
 */
export function createJsonWebSocketEvents(
    socketServer: JsonWebSocketServer,
    identity: JsonWebSocketConnectionIdentity
): WSEvents<ConnectionContext.Socket> {
    let connection: ConnectionContext | undefined;
    const toConnection = (ws: WSContext<ConnectionContext.Socket>): ConnectionContext =>
        new ConnectionContext({ ...identity, socket: toServerSocket(ws) });
    return {
        onOpen: (_event, ws) => {
            connection = toConnection(ws);
            socketServer.registerConnection(connection);
            socketServer.dispatchConnectionOpen(connection);
        },
        onMessage: (event) => {
            if (connection !== undefined) {
                void socketServer.dispatchConnectionMessage(connection, event.data);
            }
        },
        onClose: (event, ws) => {
            socketServer.dispatchConnectionClose(connection ?? toConnection(ws), event.code, event.reason);
        }
    };
}

/** `WSContext.send` discards Bun's send status, so the server writes through the raw `ServerWebSocket`. */
function toServerSocket(ws: WSContext<ConnectionContext.Socket>): ConnectionContext.Socket {
    if (ws.raw === undefined) {
        throw new Error('hono/bun hands every WebSocket event its ServerWebSocket');
    }
    return ws.raw;
}
