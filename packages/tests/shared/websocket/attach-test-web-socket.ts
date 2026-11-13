import type { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

/** A fake socket that announces its lifecycle as DOM events, the way the test fakes in this tree do. */
type EventDrivenTestSocket = ConnectionContext.Socket & Pick<EventTarget, 'addEventListener'>;

/**
 * Registers a fake socket and forwards its events into the same `registerConnection` and `dispatchConnection*`
 * entry points the production Bun WebSocket bridge calls, so tests exercise the production dispatch.
 */
export function attachTestWebSocket(server: JsonWebSocketServer, connection: ConnectionContext): void {
    const socket = readEventDrivenSocket(connection.socket);
    server.registerConnection(connection);
    socket.addEventListener('open', () => server.dispatchConnectionOpen(connection));
    // Fakes that await their listeners settle the dispatch before the next frame, as the old listener path did.
    socket.addEventListener('message', (event) => server.dispatchConnectionMessage(connection, (event as MessageEvent).data));
    socket.addEventListener('close', (event) => {
        const close = event as CloseEvent;
        server.dispatchConnectionClose(connection, close.code, close.reason);
    });
}

function readEventDrivenSocket(socket: ConnectionContext.Socket): EventDrivenTestSocket {
    if (!('addEventListener' in socket) || typeof socket.addEventListener !== 'function') {
        throw new TypeError('attachTestWebSocket needs a fake socket that dispatches DOM events');
    }
    return socket as EventDrivenTestSocket;
}
