import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import {
    ConnectionContext,
    JsonWebSocketDroppedFrameError,
    JsonWebSocketServer
} from '@shared/websocket/json-web-socket-server.ts';

import { attachTestWebSocket } from './attach-test-web-socket.ts';
import { TestWebSocket } from './test-web-socket.ts';

const FAR_FUTURE_MS = Date.parse('9999-12-31T23:59:59.999Z');

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
        attachTestWebSocket(server, connection);

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

        attachTestWebSocket(server, new ConnectionContext({ id: 'one', socket: first }));
        attachTestWebSocket(server, new ConnectionContext({ id: 'two', socket: second }));
        attachTestWebSocket(server, new ConnectionContext({ id: 'three', socket: closed }));

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

        attachTestWebSocket(server, new ConnectionContext({ id: 'one', socket: first }));
        attachTestWebSocket(server, new ConnectionContext({ id: 'two', socket: second }));

        const encoded = server.encode({ fanout: true });
        server.sendEncoded('one', encoded);
        server.sendEncoded('two', encoded);

        expect(first.sent).toEqual(['{"fanout":true}']);
        expect(second.sent).toEqual(['{"fanout":true}']);
    });

    it('captures actual native invocation and return without changing send failures', () => {
        vi.stubGlobal('WebSocket', TestWebSocket);
        const server = new JsonWebSocketServer();
        const socket = new TestWebSocket('native');
        const evidence: { nativeCall: 'not-called' | 'invoked' | 'returned'; } = { nativeCall: 'not-called' };
        attachTestWebSocket(server, new ConnectionContext({ id: 'one', socket }));
        const encoded = server.encode({ receipt: true });
        expect(() => server.sendEncoded('one', encoded, evidence)).toThrow('connection not open');
        expect(evidence.nativeCall).toBe('not-called');
        socket.readyState = TestWebSocket.OPEN;
        const original = new Error('native send failure');
        const send = vi.spyOn(socket, 'send').mockImplementation(() => {
            throw original;
        });
        try {
            server.sendEncoded('one', encoded, evidence);
            expect.fail('native throw required');
        }
        catch (error) {
            expect(error).toBe(original);
        }
        expect(evidence.nativeCall).toBe('invoked');
        send.mockRestore();
        server.sendEncoded('one', encoded, evidence);
        expect(evidence.nativeCall).toBe('returned');
        expect(socket.sent).toEqual([encoded.text]);
        const later = new Error('later owner failure');
        expect(() => {
            server.sendEncoded('one', encoded, evidence);
            throw later;
        }).toThrow(later);
        expect(evidence.nativeCall).toBe('returned');
        expect(socket.sent).toEqual([encoded.text, encoded.text]);
    });

    it('does not claim native invocation when the encoded argument throws', () => {
        vi.stubGlobal('WebSocket', TestWebSocket);
        const server = new JsonWebSocketServer();
        const socket = new TestWebSocket('native');
        socket.readyState = TestWebSocket.OPEN;
        attachTestWebSocket(server, new ConnectionContext({ id: 'one', socket }));
        const evidence: JsonWebSocketServer.SendEvidence = { nativeCall: 'not-called' };
        const original = new Error('encoded argument failure');
        const order: string[] = [];
        const nativeSend = socket.send;
        Object.defineProperty(socket, 'send', {
            get() {
                order.push('method');
                return nativeSend;
            }
        });
        const encoded = {
            get text(): string {
                order.push('argument');
                throw original;
            }
        };
        try {
            server.sendEncoded('one', encoded, evidence);
            expect.fail('encoded getter must throw');
        }
        catch (error) {
            expect(error).toBe(original);
        }
        expect(socket.sent).toEqual([]);
        expect(order).toEqual(['method', 'argument']);
        expect(evidence.nativeCall).toBe('not-called');
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
        attachTestWebSocket(server, captured);
        const encoded = server.encode({ topology: true });

        attachTestWebSocket(server, current);

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

        attachTestWebSocket(server, firstContext);
        attachTestWebSocket(server, secondContext);

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

    it('runs the sends held for an expected generation when its socket opens, in order', () => {
        vi.stubGlobal('WebSocket', TestWebSocket);

        const server = new JsonWebSocketServer();
        const generation = server.mintConnectionGeneration();
        const sent: string[] = [];
        const holds = server.expectedConnections;
        holds.expect({ id: 'session-1', generationId: generation.generationId, expiresAtEpochMs: FAR_FUTURE_MS });

        expect(holds.hold('session-1', { expiresAtEpochMs: FAR_FUTURE_MS, send: () => sent.push('first') })).toBe('held');
        expect(holds.hold('session-1', { expiresAtEpochMs: FAR_FUTURE_MS, send: () => sent.push('second') })).toBe('held');
        const socket = new TestWebSocket('session-1');
        attachTestWebSocket(server, new ConnectionContext({ id: 'session-1', socket, ...generation }));
        expect(sent).toEqual([]);
        expect(holds.isAwaiting('session-1')).toBe(true);

        socket.open();

        expect(sent).toEqual(['first', 'second']);
        expect(holds.isAwaiting('session-1')).toBe(false);
    });

    it('settles an expected generation whose socket closes before it opens', () => {
        vi.stubGlobal('WebSocket', TestWebSocket);

        const server = new JsonWebSocketServer();
        const generation = server.mintConnectionGeneration();
        const settled: string[] = [];
        server.expectedConnections.expect({ id: 'session-1', generationId: generation.generationId, expiresAtEpochMs: FAR_FUTURE_MS });
        server.expectedConnections.hold('session-1', { expiresAtEpochMs: FAR_FUTURE_MS, send: () => settled.push('held') });
        const socket = new TestWebSocket('session-1');
        attachTestWebSocket(server, new ConnectionContext({ id: 'session-1', socket, ...generation }));

        socket.disconnect(1006, 'client-gone');

        expect(settled).toEqual(['held']);
        expect(server.expectedConnections.isAwaiting('session-1')).toBe(false);
    });

    it('mints a strictly monotonic generation start before any socket exists', () => {
        const server = new JsonWebSocketServer();
        const first = server.mintConnectionGeneration({ observedAtEpochMs: 100 });
        const second = server.mintConnectionGeneration({ observedAtEpochMs: 99 });

        expect(first.generationStartedAtEpochMs).toBe(100);
        expect(second.generationStartedAtEpochMs).toBe(101);
        expect(first.generationId).not.toBe(second.generationId);
    });

    it('can close a live connection by id for auth logout', () => {
        vi.stubGlobal('WebSocket', TestWebSocket);

        const server = new JsonWebSocketServer();
        const socket = new TestWebSocket('session');
        socket.readyState = TestWebSocket.OPEN;
        attachTestWebSocket(server, new ConnectionContext({ id: 'session-1', socket }));

        expect(server.closeConnection('missing-session')).toBe(false);
        expect(server.closeConnection('session-1', 1000, 'auth-logout')).toBe(true);
        expect(socket.closedWith).toEqual({
            code: 1000,
            reason: 'auth-logout'
        });
        expect(socket.readyState).toBe(TestWebSocket.CLOSED);
    });

    it('closes every connection once shutdown begins and refuses a socket that upgrades after it', () => {
        vi.stubGlobal('WebSocket', TestWebSocket);
        const server = new JsonWebSocketServer();
        const live = new TestWebSocket('live');
        live.readyState = TestWebSocket.OPEN;
        server.registerConnection(new ConnectionContext({ id: 'live', socket: live }));

        server.stopAcceptingConnections(1001, 'server-shutting-down');
        const late = new TestWebSocket('late');
        late.readyState = TestWebSocket.OPEN;
        const registered = server.registerConnection(new ConnectionContext({ id: 'late', socket: late }));

        expect({
            accepting: server.isAcceptingConnections,
            registered,
            liveClosed: live.closedWith,
            lateClosed: late.closedWith,
            lateTracked: server.connections.has('late')
        }).toEqual({
            accepting: false,
            registered: false,
            liveClosed: { code: 1001, reason: 'server-shutting-down' },
            lateClosed: { code: 1001, reason: 'server-shutting-down' },
            lateTracked: false
        });
    });

    describe('Bun send outcomes', () => {
        it('fails a send whose frame the socket dropped and keeps the native call unreturned', () => {
            const server = new JsonWebSocketServer();
            const socket = new SendOutcomeSocket(DROPPED);
            server.registerConnection(new ConnectionContext({ id: 'slow', socket }));
            const evidence: JsonWebSocketServer.SendEvidence = { nativeCall: 'not-called' };

            expect(() => server.sendEncoded('slow', server.encode({ frame: 1 }), evidence)).toThrow(
                JsonWebSocketDroppedFrameError
            );
            expect({ sent: socket.sent, nativeCall: evidence.nativeCall }).toEqual({
                sent: ['{"frame":1}'],
                nativeCall: 'invoked'
            });
        });

        it('treats a frame queued behind backpressure as sent', () => {
            const server = new JsonWebSocketServer();
            const socket = new SendOutcomeSocket(BACKPRESSURED);
            server.registerConnection(new ConnectionContext({ id: 'busy', socket }));
            const evidence: JsonWebSocketServer.SendEvidence = { nativeCall: 'not-called' };

            server.sendEncoded('busy', server.encode({ frame: 1 }), evidence);

            expect(evidence.nativeCall).toBe('returned');
        });

        it('reports a dropped frame as unsent from every best-effort send', () => {
            vi.spyOn(console, 'error').mockImplementation(() => undefined);
            const server = new JsonWebSocketServer();
            const dropped = new ConnectionContext({ id: 'dropped', socket: new SendOutcomeSocket(DROPPED) });
            const queued = new ConnectionContext({ id: 'queued', socket: new SendOutcomeSocket(BACKPRESSURED) });
            server.registerConnection(dropped);
            server.registerConnection(queued);
            const encoded = server.encode({ frame: 2 });

            expect({
                tryDropped: server.trySendEncoded('dropped', encoded),
                tryQueued: server.trySendEncoded('queued', encoded),
                contextDropped: server.trySendEncodedToContext(dropped, encoded),
                contextQueued: server.trySendEncodedToContext(queued, encoded),
                broadcastCount: server.broadcast({ frame: 3 })
            }).toEqual({
                tryDropped: false,
                tryQueued: true,
                contextDropped: false,
                contextQueued: true,
                broadcastCount: 1
            });
        });
    });
});

/** Bun's `ServerWebSocket.send` statuses. */
const DROPPED = 0;
const BACKPRESSURED = -1;

class SendOutcomeSocket implements ConnectionContext.Socket {
    readonly readyState = 1;
    readonly sent: string[] = [];
    readonly #outcome: number;

    constructor(outcome: number) {
        this.#outcome = outcome;
    }

    send(text: string): number {
        this.sent.push(text);
        return this.#outcome;
    }

    close(): void {}
}
