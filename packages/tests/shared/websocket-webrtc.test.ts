import { newALEventRoute, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/ALOutboundMessageRuntime.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import {
    DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS,
    WsQueueBoxClientService,
    type WsQueueBoxClientReconnectOptions,
    type WsQueueBoxClientServiceOptions
} from '@shared/services/WsQueueBoxClientService.ts';
import { QRtcSignalingChannel, QRtcSignalingMsgType, QRtcSignalingType, type QRtcSignalingMessage } from '@shared/webrtc/QRtcSignalingContracts.ts';
import { WsRtcSignalingTransport } from '@shared/webrtc/WsRtcSignalingTransport.ts';
import { WsRtcSignalingTransportUsingWsQBox } from '@shared/webrtc/WsRtcSignalingTransportUsingWsQBox.ts';
import { JsonWebSocketClient } from '@shared/websocket/JsonWebSocketClient.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('JsonWebSocketClient', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        FakeWebSocket.instances.length = 0;
    });

    it('reuses a single pending connection and dispatches parsed messages', async () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);

        const client = new JsonWebSocketClient('ws://test');
        const lifecycle: string[] = [];
        const messages: unknown[] = [];

        client.onWebsocketCallbacksDo('lifecycle', {
            onOpen: () => lifecycle.push('open')
        });
        client.onWebSocketMessageDo('messages', {
            onMessage: async (data) => {
                messages.push(data);
            }
        });

        const first = client.connect();
        const second = client.connect();
        await Promise.resolve();

        expect(FakeWebSocket.instances).toHaveLength(1);

        const socket = FakeWebSocket.instances[0];
        socket.readyState = FakeWebSocket.OPEN;
        await socket.emit('open', { type: 'open' });

        await Promise.all([first, second]);

        await socket.emit('message', {
            type: 'message',
            data: JSON.stringify({ ok: 1 })
        });

        client.send({ ping: true });
        client.sendAsJsonString('{"pong":true}');

        expect(lifecycle).toEqual(['open']);
        expect(messages).toEqual([{ ok: 1 }]);
        expect(socket.sent).toEqual([JSON.stringify({ ping: true }), '{"pong":true}']);
    });

    it('rejects the initial connection on close before open and supports callback removal', async () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);

        const client = new JsonWebSocketClient('ws://test');
        const onClose = vi.fn();
        const onMessage = vi.fn();

        client.onWebsocketCallbacksDo('close', {
            onClose
        });
        client.onWebSocketMessageDo('message', {
            onMessage
        });

        expect(client.removeWebsocketCallbackById('close')).toBe(true);
        expect(client.removeOnMessageCallbackById('message')).toBe(true);

        const connectPromise = client.connect();
        await Promise.resolve();
        const socket = FakeWebSocket.instances[0];

        socket.readyState = FakeWebSocket.CLOSED;
        await socket.emit('close', {
            type: 'close',
            code: 1006,
            reason: 'boom'
        });

        await expect(connectPromise).rejects.toThrow('WebSocket is closed. Code: 1006 Reason boom');
        expect(client.ws).toBeUndefined();
        expect(onClose).not.toHaveBeenCalled();

        await socket.emit('message', {
            type: 'message',
            data: JSON.stringify({ ignored: true })
        });
        expect(onMessage).not.toHaveBeenCalled();
        expect(() => client.send({ nope: true })).toThrow(
            'WebSocketClient: cannot send; socket is not open.'
        );
    });

    it('rejects the initial connection on error before open and can reconnect', async () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);

        const client = new JsonWebSocketClient('ws://test');
        const onError = vi.fn();

        client.onWebsocketCallbacksDo('error', {
            onError
        });

        const firstConnect = client.connect();
        await Promise.resolve();
        const firstSocket = FakeWebSocket.instances[0];

        await firstSocket.emit('error', { type: 'error' });

        await expect(firstConnect).rejects.toThrow('WebSocket error. Type: error');
        expect(onError).toHaveBeenCalledOnce();

        const secondConnect = client.connect();
        await Promise.resolve();
        expect(FakeWebSocket.instances).toHaveLength(2);

        const secondSocket = FakeWebSocket.instances[1];
        secondSocket.readyState = FakeWebSocket.OPEN;
        await secondSocket.emit('open', { type: 'open' });

        await expect(secondConnect).resolves.toBeUndefined();
    });

    it('resolves a fresh URL for each new socket connection', async () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);

        let sequence = 0;
        const client = new JsonWebSocketClient(() => `ws://test?ticket=${++sequence}`);

        const firstConnect = client.connect();
        await Promise.resolve();
        expect(FakeWebSocket.instances[0].url).toBe('ws://test?ticket=1');
        FakeWebSocket.instances[0].readyState = FakeWebSocket.OPEN;
        await FakeWebSocket.instances[0].emit('open', { type: 'open' });
        await expect(firstConnect).resolves.toBeUndefined();
        expect(client.url).toBe('ws://test?ticket=1');

        client.close(1000, 'test-reconnect');

        const secondConnect = client.connect();
        await Promise.resolve();
        expect(FakeWebSocket.instances[1].url).toBe('ws://test?ticket=2');
        FakeWebSocket.instances[1].readyState = FakeWebSocket.OPEN;
        await FakeWebSocket.instances[1].emit('open', { type: 'open' });
        await expect(secondConnect).resolves.toBeUndefined();
        expect(client.url).toBe('ws://test?ticket=2');
    });

    it('keeps a reconnect started by a close callback as the active pending connection', async () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);

        let sequence = 0;
        const client = new JsonWebSocketClient(() => `ws://test?ticket=${++sequence}`);
        let reconnectPromise: Promise<void> | undefined;

        client.onWebsocketCallbacksDo('reconnect', {
            onClose: () => {
                reconnectPromise = client.connect();
            }
        });

        const firstConnect = client.connect();
        await Promise.resolve();
        const firstSocket = FakeWebSocket.instances[0];
        firstSocket.readyState = FakeWebSocket.OPEN;
        await firstSocket.emit('open', { type: 'open' });
        await expect(firstConnect).resolves.toBeUndefined();

        firstSocket.readyState = FakeWebSocket.CLOSED;
        await firstSocket.emit('close', {
            type: 'close',
            code: 1006,
            reason: 'network-lost'
        });
        const joinedReconnect = client.connect();
        await Promise.resolve();

        expect(FakeWebSocket.instances).toHaveLength(2);
        const secondSocket = FakeWebSocket.instances[1];
        expect(secondSocket.url).toBe('ws://test?ticket=2');
        secondSocket.readyState = FakeWebSocket.OPEN;
        await secondSocket.emit('open', { type: 'open' });

        expect(reconnectPromise).toBeDefined();
        await expect(reconnectPromise!).resolves.toBeUndefined();
        await expect(joinedReconnect).resolves.toBeUndefined();
        expect(client.ws).toBe(secondSocket);
    });

    it('clears the active socket when a pending connection is aborted', async () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);

        const controller = new AbortController();
        const client = new JsonWebSocketClient('ws://test');

        const connectPromise = client.connect({
            signal: controller.signal
        });
        await Promise.resolve();

        const socket = FakeWebSocket.instances[0];
        expect(client.ws).toBe(socket);

        controller.abort();

        await expect(connectPromise).rejects.toThrow('WebSocket connect aborted.');
        expect(client.ws).toBeUndefined();
        expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    });
});

describe('JsonWebSocketServer', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        FakeWebSocket.instances.length = 0;
    });

    it('dispatches lifecycle, parse errors, and decoded messages', async () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);

        const server = new JsonWebSocketServer();
        const lifecycle: string[] = [];
        const parseErrors: string[] = [];
        const messages: unknown[] = [];

        server.onWebsocketCallbacksDo('callbacks', {
            onConnection: (ctx) => lifecycle.push(`open:${ctx.id}`),
            onClose: (ctx) => {
                lifecycle.push(`close:${ctx.id}`);
            },
            onParseError: (_ctx, rawText) => parseErrors.push(rawText)
        });
        server.onMessageDo('messages', {
            onMessage: async (_ctx, data) => {
                messages.push(data);
            }
        });

        const socket = new FakeWebSocket('server');
        const ctx = new ConnectionContext('c1', socket as never);
        server.addConnection(ctx);

        socket.readyState = FakeWebSocket.OPEN;
        await socket.emit('open', { type: 'open' });
        await socket.emit('message', {
            type: 'message',
            data: JSON.stringify({ ok: 1 })
        });
        await socket.emit('message', {
            type: 'message',
            data: 'not-json'
        });

        expect(server.connections.has('c1')).toBe(true);

        socket.readyState = FakeWebSocket.CLOSED;
        await socket.emit('close', {
            type: 'close',
            code: 1000,
            reason: 'bye'
        });

        expect(lifecycle).toEqual(['open:c1', 'close:c1']);
        expect(parseErrors).toEqual(['not-json']);
        expect(messages).toEqual([{ ok: 1 }, 'not-json']);
        expect(server.connections.has('c1')).toBe(false);
    });

    it('sends directly and broadcasts only to open filtered connections', () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);

        const server = new JsonWebSocketServer();
        const first = new FakeWebSocket('first');
        const second = new FakeWebSocket('second');
        const closed = new FakeWebSocket('closed');

        first.readyState = FakeWebSocket.OPEN;
        second.readyState = FakeWebSocket.OPEN;
        closed.readyState = FakeWebSocket.CLOSED;

        server.addConnection(new ConnectionContext('one', first as never));
        server.addConnection(new ConnectionContext('two', second as never));
        server.addConnection(new ConnectionContext('three', closed as never));

        server.send('one', { hello: true });

        expect(first.sent).toEqual([JSON.stringify({ hello: true })]);
        expect(() => server.send('three', { hello: true })).toThrow(
            'JsonWebSocketServer: cannot send; connection not open: three'
        );

        const sent = server.broadcast({ ping: true }, (ctx) => ctx.id !== 'two');

        expect(sent).toBe(1);
        expect(first.sent).toEqual([JSON.stringify({ hello: true }), JSON.stringify({ ping: true })]);
        expect(second.sent).toEqual([]);
        expect(closed.sent).toEqual([]);
    });

    it('can pre-encode once and reuse the payload for direct sends', () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);

        const stringify = vi.spyOn(JSON, 'stringify');
        const server = new JsonWebSocketServer();
        const first = new FakeWebSocket('first');
        const second = new FakeWebSocket('second');

        first.readyState = FakeWebSocket.OPEN;
        second.readyState = FakeWebSocket.OPEN;

        server.addConnection(new ConnectionContext('one', first as never));
        server.addConnection(new ConnectionContext('two', second as never));

        const encoded = server.encode({ fanout: true });
        server.sendEncoded('one', encoded);
        server.sendEncoded('two', encoded);

        expect(stringify).toHaveBeenCalledOnce();
        expect(first.sent).toEqual([encoded.text]);
        expect(second.sent).toEqual([encoded.text]);
    });

    it('sends an encoded payload only to the captured connection generation', () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);

        const server = new JsonWebSocketServer();
        const first = new FakeWebSocket('first');
        const replacement = new FakeWebSocket('replacement');
        first.readyState = FakeWebSocket.OPEN;
        replacement.readyState = FakeWebSocket.OPEN;
        const captured = new ConnectionContext('session-1', first as never, 'generation-1');
        const current = new ConnectionContext('session-1', replacement as never, 'generation-2');
        server.addConnection(captured);
        const encoded = server.encode({ topology: true });

        server.addConnection(current);

        expect(server.trySendEncodedToContext(captured, encoded)).toBe(false);
        expect(server.trySendEncodedToContext(current, encoded)).toBe(true);
        expect(first.sent).toEqual([]);
        expect(replacement.sent).toEqual([encoded.text]);
    });

    it('replaces duplicate connection ids without letting stale close remove the current socket', async () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);

        const server = new JsonWebSocketServer();
        const lifecycle: string[] = [];
        const first = new FakeWebSocket('first');
        const second = new FakeWebSocket('second');

        first.readyState = FakeWebSocket.OPEN;
        second.readyState = FakeWebSocket.OPEN;
        const firstContext = new ConnectionContext('session-1', first as never);
        const secondContext = new ConnectionContext('session-1', second as never);
        server.onWebsocketCallbacksDo('lifecycle', {
            onClose: (ctx) => {
                lifecycle.push(`close:${ctx.id}:${ctx.socket === secondContext.socket}`);
            }
        });

        server.addConnection(firstContext);
        server.addConnection(secondContext);

        expect(first.closedWith).toEqual({
            code: 1000,
            reason: 'connection-replaced'
        });
        expect(server.connections.get('session-1')?.socket).toBe(second);

        await first.emit('close', {
            type: 'close',
            code: 1000,
            reason: 'connection-replaced'
        });

        expect(server.connections.get('session-1')?.socket).toBe(second);
        expect(lifecycle).toEqual(['close:session-1:false']);

        second.readyState = FakeWebSocket.CLOSED;
        await second.emit('close', {
            type: 'close',
            code: 1000,
            reason: 'done'
        });

        expect(server.connections.has('session-1')).toBe(false);
        expect(lifecycle).toEqual(['close:session-1:false', 'close:session-1:true']);
    });

    it('can close a live connection by id for auth logout', () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);

        const server = new JsonWebSocketServer();
        const socket = new FakeWebSocket('session');
        socket.readyState = FakeWebSocket.OPEN;
        server.addConnection(new ConnectionContext('session-1', socket as never));

        expect(server.closeConnection('missing-session')).toBe(false);
        expect(server.closeConnection('session-1', 1000, 'auth-logout')).toBe(true);
        expect(socket.closedWith).toEqual({
            code: 1000,
            reason: 'auth-logout'
        });
        expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    });
});

describe('WsRtcSignalingTransport', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('wires socket lifecycle callbacks and forwards only matching message types', async () => {
        const socket = createSocketHarness();
        const transport = new WsRtcSignalingTransport(socket.client as never, 'rtc');
        const lifecycle: string[] = [];
        const messages: ALMessage[] = [];

        await transport.connect({
            sessionId: 'session-1',
            token: 'token-1',
            callbacks: {
                onOpen: async (sessionId, token) => {
                    lifecycle.push(`open:${sessionId}:${token}`);
                },
                onClose: async (sessionId, token) => {
                    lifecycle.push(`close:${sessionId}:${token}`);
                },
                onError: async (_sessionId, _token, message) => {
                    lifecycle.push(`error:${message}`);
                },
                onMessage: async (_sessionId, _token, message) => {
                    messages.push(message);
                }
            }
        });

        expect(socket.connect).toHaveBeenCalledOnce();

        const matching = createEnvelope('rtc', { hello: true });
        const ignored = createEnvelope('other', { ignored: true });

        await socket.webSocketCallbacks?.onOpen?.({ type: 'open' } as Event);
        await socket.onMessageCallback?.onMessage(ignored, {
            type: 'message'
        } as MessageEvent);
        await socket.onMessageCallback?.onMessage(matching, {
            type: 'message'
        } as MessageEvent);
        await socket.webSocketCallbacks?.onError?.({
            type: 'error',
            toString: () => 'socket failed'
        } as Event);
        await socket.webSocketCallbacks?.onClose?.({ type: 'close' } as CloseEvent);

        expect(messages).toEqual([matching]);
        expect(lifecycle).toEqual([
            'open:session-1:token-1',
            'error:socket failed',
            'close:session-1:token-1'
        ]);
    });

    it('wraps signaling payloads in an AL message when sending', async () => {
        const socket = createSocketHarness();
        const transport = new WsRtcSignalingTransport(socket.client as never, 'rtc');
        const payload = createSignalingPayload();

        await transport.send(payload);

        expect(socket.send).toHaveBeenCalledOnce();

        const sent = socket.send.mock.calls[0][0] as ALMessage;

        expect(sent.payload.typeId).toBe('rtc');
        expect(sent.id.senderId).toBe(payload.fromId);
        expect(JSON.parse(sent.payload.resource)).toEqual(payload);
    });
});

describe('WsRtcSignalingTransportUsingWsQBox', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('wires qbox callbacks and forwards only matching inbox messages', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const qbox = createQboxHarness();
        const transport = new WsRtcSignalingTransportUsingWsQBox(qbox.service as never, 'rtc');
        const lifecycle: string[] = [];
        const messages: ALMessage[] = [];

        await transport.connect({
            sessionId: 'session-1',
            token: 'token-1',
            callbacks: {
                onOpen: async (sessionId, token) => {
                    lifecycle.push(`open:${sessionId}:${token}`);
                },
                onClose: async (sessionId, token) => {
                    lifecycle.push(`close:${sessionId}:${token}`);
                },
                onError: async (_sessionId, _token, message) => {
                    lifecycle.push(`error:${message}`);
                },
                onMessage: async (_sessionId, _token, message) => {
                    messages.push(message);
                }
            }
        });

        expect(qbox.socket.connect).toHaveBeenCalledOnce();

        const matching = createEnvelope('rtc', { hello: true });
        const ignored = createEnvelope('other', { ignored: true });

        await qbox.socket.webSocketCallbacks?.onOpen?.({ type: 'open' } as Event);
        await qbox.inboxCallback?.onMessage(ignored, {} as never);
        await qbox.inboxCallback?.onMessage(matching, {} as never);
        await qbox.socket.webSocketCallbacks?.onError?.({
            type: 'error',
            toString: () => 'socket failed'
        } as Event);
        await qbox.socket.webSocketCallbacks?.onClose?.({
            type: 'close'
        } as CloseEvent);

        expect(messages).toEqual([matching]);
        expect(lifecycle).toEqual([
            'open:session-1:token-1',
            'error:socket failed',
            'close:session-1:token-1'
        ]);
        expect(consoleError).toHaveBeenCalled();
    });

    it('enqueues signaling payloads as AL messages', async () => {
        const qbox = createQboxHarness();
        const transport = new WsRtcSignalingTransportUsingWsQBox(qbox.service as never, 'rtc');
        const payload = createSignalingPayload();

        await transport.send(payload);

        expect(qbox.enqueueOutboxIfAbsent).toHaveBeenCalledOnce();

        const sent = qbox.enqueueOutboxIfAbsent.mock.calls[0][0];

        expect(sent.payload.typeId).toBe('rtc');
        expect(sent.id.senderId).toBe(payload.fromId);
        expect(JSON.parse(sent.payload.resource)).toEqual(payload);
    });

    it('wakes the queue-box engine when signaling payloads queue outbox work', async () => {
        const qbox = createQboxHarness();
        qbox.enqueueOutboxIfAbsent.mockResolvedValueOnce({
            status: 'enqueued',
            message: createEnvelope('rtc', createSignalingPayload()),
            entries: []
        });
        const wakeOutbox = vi.fn();
        const transport = new WsRtcSignalingTransportUsingWsQBox(
            qbox.service as never,
            'rtc',
            wakeOutbox
        );

        await transport.send(createSignalingPayload());

        expect(wakeOutbox).toHaveBeenCalledOnce();
    });
});

describe('WsQueueBoxClientService reconnect lifecycle', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        FakeWebSocket.instances.length = 0;
    });

    it('reuses one ticket identity after a lost response within one reconnect action', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const requestIds: Array<string | undefined> = [];
        let loseNextResponse = false;
        const socket = new JsonWebSocketClient(async (options) => {
            requestIds.push(options.requestId);
            if (loseNextResponse) {
                loseNextResponse = false;
                throw new Error('ticket response lost');
            }
            return `ws://test?requestId=${options.requestId}`;
        });
        const service = createWsQueueBoxService(socket, {
            newConnectionRequestId: () => 'reconnect-request-1',
            reconnect: {
                maxAttempts: 2,
                connectTimeoutMsecs: 0,
                retryIntervalMsecs: 0,
                maxRetryIntervalMsecs: 0
            }
        });

        const initialConnect = socket.connect({ requestId: 'initial-request' });
        await Promise.resolve();
        const initialSocket = FakeWebSocket.instances[0];
        initialSocket.readyState = FakeWebSocket.OPEN;
        await initialSocket.emit('open', { type: 'open' });
        await initialConnect;
        requestIds.length = 0;
        FakeWebSocket.instances.length = 0;
        service.enableReconnect();
        loseNextResponse = true;
        initialSocket.readyState = FakeWebSocket.CLOSED;
        await initialSocket.emit('close', {
            type: 'close',
            code: 1006,
            reason: 'network-lost'
        });
        await vi.runAllTimersAsync();
        await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

        const connected = FakeWebSocket.instances[0];
        connected.readyState = FakeWebSocket.OPEN;
        await connected.emit('open', { type: 'open' });

        expect(requestIds).toEqual(['reconnect-request-1', 'reconnect-request-1']);
    });

    it('allocates a new ticket request identity for a later reconnect action', async () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const requestIds: Array<string | undefined> = [];
        let requestSequence = 0;
        const socket = new JsonWebSocketClient((options) => {
            requestIds.push(options.requestId);
            return `ws://test?requestId=${options.requestId}`;
        });
        const service = createWsQueueBoxService(socket, {
            newConnectionRequestId: () => `reconnect-request-${++requestSequence}`,
            reconnect: {
                connectTimeoutMsecs: 0,
                retryIntervalMsecs: 0,
                maxRetryIntervalMsecs: 0
            }
        });

        const initialConnect = socket.connect({ requestId: 'initial-request' });
        await Promise.resolve();
        const initialSocket = FakeWebSocket.instances[0];
        initialSocket.readyState = FakeWebSocket.OPEN;
        await initialSocket.emit('open', { type: 'open' });
        await initialConnect;
        requestIds.length = 0;
        FakeWebSocket.instances.length = 0;
        service.enableReconnect();
        initialSocket.readyState = FakeWebSocket.CLOSED;
        await initialSocket.emit('close', {
            type: 'close',
            code: 1006,
            reason: 'network-lost'
        });
        await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
        const first = FakeWebSocket.instances[0];
        first.readyState = FakeWebSocket.OPEN;
        await first.emit('open', { type: 'open' });
        await vi.waitFor(() => expect(service.readHealth().reconnecting).toBe(false));

        first.readyState = FakeWebSocket.CLOSED;
        await first.emit('close', {
            type: 'close',
            code: 1006,
            reason: 'network-lost-again'
        });
        await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
        const second = FakeWebSocket.instances[1];
        second.readyState = FakeWebSocket.OPEN;
        await second.emit('open', { type: 'open' });

        expect(requestIds).toEqual(['reconnect-request-1', 'reconnect-request-2']);
    });

    it('reconnects after an unexpected WebSocket close while reconnect is enabled', async () => {
        const socket = createReconnectSocketHarness();
        const service = createWsQueueBoxService(socket.client);

        service.enableReconnect();

        socket.webSocketCallbacks?.onClose?.({
            type: 'close',
            code: 1006,
            reason: 'network-lost'
        } as CloseEvent);
        await Promise.resolve();

        expect(socket.connect).toHaveBeenCalledOnce();
        expect(service.readHealth()).toMatchObject({
            reconnectEnabled: true
        });
    });

    it('does not reconnect after an intentional service close', async () => {
        const socket = createReconnectSocketHarness();
        const service = createWsQueueBoxService(socket.client);

        service.enableReconnect();
        service.close(1000, 'rallar-disconnect');

        socket.webSocketCallbacks?.onClose?.({
            type: 'close',
            code: 1000,
            reason: 'rallar-disconnect'
        } as CloseEvent);
        await Promise.resolve();

        expect(socket.close).toHaveBeenCalledWith(1000, 'rallar-disconnect');
        expect(socket.connect).not.toHaveBeenCalled();
        expect(service.readHealth()).toMatchObject({
            reconnectEnabled: false,
            reconnecting: false
        });
    });

    it('stops a pending reconnect loop when reconnect is disabled', async () => {
        vi.useFakeTimers();
        const socket = createReconnectSocketHarness({
            connect: async () => {
                throw new Error('offline');
            }
        });
        const service = createWsQueueBoxService(socket.client);

        service.enableReconnect();
        socket.webSocketCallbacks?.onClose?.({
            type: 'close',
            code: 1006,
            reason: 'network-lost'
        } as CloseEvent);

        expect(socket.connect).toHaveBeenCalledTimes(1);
        expect(service.readHealth()).toMatchObject({
            reconnectEnabled: true,
            reconnecting: true
        });

        service.disableReconnect();
        await vi.advanceTimersByTimeAsync(500);

        expect(socket.connect).toHaveBeenCalledTimes(1);
        expect(service.readHealth()).toMatchObject({
            reconnectEnabled: false,
            reconnecting: false
        });
    });

    it('gives up after the configured reconnect attempts', async () => {
        vi.useFakeTimers();
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const socket = createReconnectSocketHarness({
            connect: async () => {
                throw new Error('offline');
            }
        });
        const service = createWsQueueBoxService(socket.client, {
            reconnect: {
                maxAttempts: 3,
                retryIntervalMsecs: 0,
                maxRetryIntervalMsecs: 0
            }
        });

        service.enableReconnect();
        socket.webSocketCallbacks?.onClose?.({
            type: 'close',
            code: 1006,
            reason: 'network-lost'
        } as CloseEvent);

        await vi.runAllTimersAsync();

        expect(socket.connect).toHaveBeenCalledTimes(3);
        expect(service.readHealth()).toMatchObject({
            reconnectEnabled: false,
            reconnecting: false,
            reconnectAttempts: 3,
            maxReconnectAttempts: 3,
            reconnectExhausted: true
        });
        expect(consoleWarn).toHaveBeenCalledWith(
            expect.stringContaining('WebSocket reconnect exhausted after 3 attempts'),
            expect.anything()
        );
    });

    it('times out an individual reconnect attempt', async () => {
        vi.useFakeTimers();
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const signals: AbortSignal[] = [];
        const socket = createReconnectSocketHarness({
            connect: async (options?: { signal?: AbortSignal; }) => {
                if (options?.signal) {
                    signals.push(options.signal);
                }
                return await new Promise<void>(() => {});
            }
        });
        const service = createWsQueueBoxService(socket.client, {
            reconnect: {
                maxAttempts: 1,
                connectTimeoutMsecs: 25,
                retryIntervalMsecs: 0,
                maxRetryIntervalMsecs: 0
            }
        });

        service.enableReconnect();
        socket.webSocketCallbacks?.onClose?.({
            type: 'close',
            code: 1006,
            reason: 'network-lost'
        } as CloseEvent);

        expect(socket.connect).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(25);

        expect(signals).toHaveLength(1);
        expect(signals[0].aborted).toBe(true);
        expect(service.readHealth()).toMatchObject({
            reconnectEnabled: false,
            reconnecting: false,
            reconnectAttempts: 1,
            maxReconnectAttempts: 1,
            reconnectExhausted: true
        });
        expect(consoleWarn).toHaveBeenCalledWith(
            expect.stringContaining('WebSocket reconnect exhausted after 1 attempts'),
            expect.anything()
        );
    });

    it('does not reconnect when reconnect eligibility is false', async () => {
        const socket = createReconnectSocketHarness();
        const service = createWsQueueBoxService(socket.client, {
            reconnect: {
                canReconnect: () => false
            }
        });

        service.enableReconnect();
        socket.webSocketCallbacks?.onClose?.({
            type: 'close',
            code: 1006,
            reason: 'network-lost'
        } as CloseEvent);
        await Promise.resolve();

        expect(socket.connect).not.toHaveBeenCalled();
        expect(service.readHealth()).toMatchObject({
            reconnectEnabled: false,
            reconnecting: false,
            reconnectAttempts: 0,
            reconnectExhausted: false
        });
    });
});

class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static readonly instances: FakeWebSocket[] = [];

    readonly sent: string[] = [];
    readyState = FakeWebSocket.CONNECTING;

    private readonly listeners = new Map<string, Array<(event: unknown) => void | Promise<void>>>();

    public readonly url: string;

    constructor(url: string) {
        this.url = url;
        FakeWebSocket.instances.push(this);
    }

    addEventListener(type: string, handler: (event: unknown) => void | Promise<void>): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(handler);
        this.listeners.set(type, listeners);
    }

    async emit(type: string, event: unknown): Promise<void> {
        for (const listener of this.listeners.get(type) ?? []) {
            await listener(event);
        }
    }

    send(data: string): void {
        this.sent.push(data);
    }

    closedWith: { code?: number; reason?: string; } | undefined;

    close(code?: number, reason?: string): void {
        this.closedWith = { code, reason };
        this.readyState = FakeWebSocket.CLOSED;
    }
}

type WsQueueBoxClientServiceTestOptions =
    & Omit<Partial<WsQueueBoxClientServiceOptions>, 'reconnect'>
    & Readonly<{
        reconnect?: Partial<WsQueueBoxClientReconnectOptions>;
    }>;

function createWsQueueBoxService(
    socket: unknown,
    options: WsQueueBoxClientServiceTestOptions = {}
): WsQueueBoxClientService {
    const serviceOptions: WsQueueBoxClientServiceOptions = {
        ...options,
        reconnect: {
            ...DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS,
            ...options.reconnect
        }
    };

    return new WsQueueBoxClientService(
        new InMemoryQueueBox(new Map()),
        new InMemoryQueueBox(new Map()),
        socket as never,
        {
            sessionId: 'session-1'
        },
        serviceOptions
    );
}

function createReconnectSocketHarness(
    options: Readonly<{
        connect?: (options?: { signal?: AbortSignal; }) => Promise<void>;
    }> = {}
) {
    const state: {
        webSocketCallbacks?: {
            onOpen?: (ev: Event) => void | Promise<void>;
            onError?: (ev: Event) => void | Promise<void>;
            onClose?: (ev: CloseEvent) => void | Promise<void>;
        };
        ws?: { readyState: number; };
    } = {
        ws: { readyState: 1 }
    };

    const client = {
        url: 'ws://test',
        get ws() {
            return state.ws;
        },
        onWebsocketCallbacksDo: vi.fn(function (
            _id: string,
            callbacks: typeof state.webSocketCallbacks
        ) {
            state.webSocketCallbacks = callbacks;
            return client;
        }),
        connect: vi.fn(options.connect ?? (async (_options?: { signal?: AbortSignal; }) => {})),
        close: vi.fn((_code?: number, _reason?: string) => {
            state.ws = undefined;
        }),
        onWebSocketMessageDo: vi.fn(function () {
            return client;
        }),
        sendAsJsonString: vi.fn()
    };

    return {
        client,
        get webSocketCallbacks() {
            return state.webSocketCallbacks;
        },
        connect: client.connect,
        close: client.close
    };
}

function createSocketHarness() {
    const state: {
        webSocketCallbacks?: {
            onOpen?: (ev: Event) => void | Promise<void>;
            onError?: (ev: Event) => void | Promise<void>;
            onClose?: (ev: CloseEvent) => void | Promise<void>;
        };
        onMessageCallback?: {
            onMessage: (data: unknown, ev: MessageEvent) => Promise<void> | void;
        };
    } = {};

    const connect = vi.fn(async () => {});
    const send = vi.fn();

    const client = {
        onWebsocketCallbacksDo: vi.fn(function (
            _id: string,
            callbacks: typeof state.webSocketCallbacks
        ) {
            state.webSocketCallbacks = callbacks;
            return client;
        }),
        onWebSocketMessageDo: vi.fn(function (_id: string, callback: typeof state.onMessageCallback) {
            state.onMessageCallback = callback;
            return client;
        }),
        connect,
        send
    };

    return {
        client,
        connect,
        send,
        get webSocketCallbacks() {
            return state.webSocketCallbacks;
        },
        get onMessageCallback() {
            return state.onMessageCallback;
        }
    };
}

function createQboxHarness() {
    let inboxCallback:
        | {
            onMessage: (message: ALMessage, entry: unknown) => Promise<void>;
        }
        | undefined;

    const socket = createSocketHarness();
    const enqueueOutboxIfAbsent = vi.fn(
        async (message: ALMessage): Promise<ALOutboundEnqueueResult> => ({
            status: 'skipped',
            message,
            entries: []
        })
    );

    const service = {
        socket: socket.client,
        onInboxMessageDo: vi.fn(function (_id: string, callback: typeof inboxCallback) {
            inboxCallback = callback;
            return service;
        }),
        enqueueOutboxIfAbsent
    };

    return {
        service,
        socket,
        enqueueOutboxIfAbsent,
        get inboxCallback() {
            return inboxCallback;
        }
    };
}

function createSignalingPayload(): QRtcSignalingMessage {
    return {
        channel: QRtcSignalingChannel.RtcSignal,
        type: QRtcSignalingMsgType.Signal,
        fromId: 'peer-1',
        toId: 'peer-2',
        sessionId: 'session-1',
        token: 'token-1',
        signalType: QRtcSignalingType.Offer,
        payload: {
            sdp: 'offer'
        }
    };
}

function createEnvelope(typeId: string, payload: unknown): ALMessage {
    return newALUnicastMessage(
        'peer-1',
        newALEventRoute(typeId, 'session-1'),
        'session-1',
        typeId,
        payload
    );
}
