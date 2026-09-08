import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from './test-web-socket.ts';

describe('JsonWebSocketServer', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it('dispatches lifecycle, parse errors, and decoded messages', async () => {
        vi.stubGlobal('WebSocket', TestWebSocket);

        const server = new JsonWebSocketServer();
        const lifecycle: string[] = [];
        const parseErrors: string[] = [];
        const messages: string[] = [];

        server.onWebsocketCallbacksDo('callbacks', {
            onConnection: (connection) => lifecycle.push(`open:${connection.id}`),
            onClose: (connection) => {
                lifecycle.push(`close:${connection.id}`);
            },
            onParseError: (_connection, rawText) => parseErrors.push(rawText)
        });
        server.onMessageDo('messages', {
            onMessage: async (_connection, data) => {
                messages.push(JSON.stringify(data));
            }
        });

        const socket = new TestWebSocket('server');
        const connection = new ConnectionContext({ id: 'c1', socket });
        server.addConnection(connection);

        socket.open();
        socket.receive(JSON.stringify({ ok: 1 }));
        socket.receive('not-json');

        expect(server.connections.has('c1')).toBe(true);

        socket.disconnect(1000, 'bye');

        expect(lifecycle).toEqual(['open:c1', 'close:c1']);
        expect(parseErrors).toEqual(['not-json']);
        expect(messages).toEqual(['{"ok":1}', '"not-json"']);
        expect(server.connections.has('c1')).toBe(false);
    });

    it('sends directly and broadcasts only to open filtered connections', () => {
        vi.stubGlobal('WebSocket', TestWebSocket);

        const server = new JsonWebSocketServer();
        const first = new TestWebSocket('first');
        const second = new TestWebSocket('second');
        const closed = new TestWebSocket('closed');

        first.readyState = TestWebSocket.OPEN;
        second.readyState = TestWebSocket.OPEN;
        closed.readyState = TestWebSocket.CLOSED;

        server.addConnection(new ConnectionContext({ id: 'one', socket: first }));
        server.addConnection(new ConnectionContext({ id: 'two', socket: second }));
        server.addConnection(new ConnectionContext({ id: 'three', socket: closed }));

        server.send('one', { hello: true });

        expect(first.sent).toEqual([JSON.stringify({ hello: true })]);
        expect(() => server.send('three', { hello: true })).toThrow(
            'JsonWebSocketServer: cannot send; connection not open: three'
        );

        const sent = server.broadcast({ ping: true }, (connection) => connection.id !== 'two');

        expect(sent).toBe(1);
        expect(first.sent).toEqual([JSON.stringify({ hello: true }), JSON.stringify({ ping: true })]);
        expect(second.sent).toEqual([]);
        expect(closed.sent).toEqual([]);
    });

    it('reuses a pre-encoded payload for direct sends', () => {
        vi.stubGlobal('WebSocket', TestWebSocket);

        const server = new JsonWebSocketServer();
        const first = new TestWebSocket('first');
        const second = new TestWebSocket('second');

        first.readyState = TestWebSocket.OPEN;
        second.readyState = TestWebSocket.OPEN;

        server.addConnection(new ConnectionContext({ id: 'one', socket: first }));
        server.addConnection(new ConnectionContext({ id: 'two', socket: second }));

        const encoded = server.encode({ fanout: true });
        server.sendEncoded('one', encoded);
        server.sendEncoded('two', encoded);

        expect(first.sent).toEqual(['{"fanout":true}']);
        expect(second.sent).toEqual(['{"fanout":true}']);
    });

    it('sends an encoded payload only to the captured connection generation', () => {
        vi.stubGlobal('WebSocket', TestWebSocket);

        const server = new JsonWebSocketServer();
        const first = new TestWebSocket('first');
        const replacement = new TestWebSocket('replacement');
        first.readyState = TestWebSocket.OPEN;
        replacement.readyState = TestWebSocket.OPEN;
        const captured = new ConnectionContext({ id: 'session-1', socket: first, generationId: 'generation-1' });
        const current = new ConnectionContext({ id: 'session-1', socket: replacement, generationId: 'generation-2' });
        server.addConnection(captured);
        const encoded = server.encode({ topology: true });

        server.addConnection(current);

        expect(server.trySendEncodedToContext(captured, encoded)).toBe(false);
        expect(server.trySendEncodedToContext(current, encoded)).toBe(true);
        expect(first.sent).toEqual([]);
        expect(replacement.sent).toEqual([encoded.text]);
    });

    it('replaces duplicate connection ids without letting stale close remove the current socket', async () => {
        vi.stubGlobal('WebSocket', TestWebSocket);

        const server = new JsonWebSocketServer();
        const lifecycle: string[] = [];
        const first = new TestWebSocket('first');
        const second = new TestWebSocket('second');

        first.readyState = TestWebSocket.OPEN;
        second.readyState = TestWebSocket.OPEN;
        const firstContext = new ConnectionContext({ id: 'session-1', socket: first });
        const secondContext = new ConnectionContext({ id: 'session-1', socket: second });
        server.onWebsocketCallbacksDo('lifecycle', {
            onClose: (connection) => {
                lifecycle.push(`close:${connection.id}:${connection.socket === secondContext.socket}`);
            }
        });

        server.addConnection(firstContext);
        server.addConnection(secondContext);

        expect(first.closedWith).toEqual({
            code: 1000,
            reason: 'connection-replaced'
        });
        expect(server.connections.get('session-1')?.socket).toBe(second);

        first.disconnect(1000, 'connection-replaced');

        expect(server.connections.get('session-1')?.socket).toBe(second);
        expect(lifecycle).toEqual(['close:session-1:false']);

        second.disconnect(1000, 'done');

        expect(server.connections.has('session-1')).toBe(false);
        expect(lifecycle).toEqual(['close:session-1:false', 'close:session-1:true']);
    });

    it('can close a live connection by id for auth logout', () => {
        vi.stubGlobal('WebSocket', TestWebSocket);

        const server = new JsonWebSocketServer();
        const socket = new TestWebSocket('session');
        socket.readyState = TestWebSocket.OPEN;
        server.addConnection(new ConnectionContext({ id: 'session-1', socket }));

        expect(server.closeConnection('missing-session')).toBe(false);
        expect(server.closeConnection('session-1', 1000, 'auth-logout')).toBe(true);
        expect(socket.closedWith).toEqual({
            code: 1000,
            reason: 'auth-logout'
        });
        expect(socket.readyState).toBe(TestWebSocket.CLOSED);
    });
});
