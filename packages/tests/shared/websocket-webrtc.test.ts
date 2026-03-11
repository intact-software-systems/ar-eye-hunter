import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ALMessage, newALEventRoute, newALUnicastMessage, } from '@shared/al-contracts/al-contract.ts';
import { JsonWebSocketClient } from '@shared/websocket/JsonWebSocketClient.ts';
import { ConnectionContext, JsonWebSocketServer, } from '@shared/websocket/JsonWebSocketServer.ts';
import {
    QRtcSignalingChannel,
    type QRtcSignalingMessage,
    QRtcSignalingMsgType,
    QRtcSignalingType,
} from '@shared/webrtc/QRtcSignalingContracts.ts';
import { WsRtcSignalingTransport } from '@shared/webrtc/WsRtcSignalingTransport.ts';
import { WsRtcSignalingTransportUsingWsQBox } from '@shared/webrtc/WsRtcSignalingTransportUsingWsQBox.ts';

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
            onOpen: () => lifecycle.push('open'),
        });
        client.onWebSocketMessageDo('messages', {
            onMessage: async (data) => {
                messages.push(data);
            },
        });

        const first = client.connect();
        const second = client.connect();

        expect(FakeWebSocket.instances).toHaveLength(1);

        const socket = FakeWebSocket.instances[0];
        socket.readyState = FakeWebSocket.OPEN;
        await socket.emit('open', { type: 'open' });

        await Promise.all([first, second]);

        await socket.emit('message', {
            type: 'message',
            data: JSON.stringify({ ok: 1 }),
        });

        client.send({ ping: true });
        client.sendAsJsonString('{"pong":true}');

        expect(lifecycle).toEqual(['open']);
        expect(messages).toEqual([{ ok: 1 }]);
        expect(socket.sent).toEqual([
            JSON.stringify({ ping: true }),
            '{"pong":true}',
        ]);
    });

    it('rejects the initial connection on close before open and supports callback removal', async () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);

        const client = new JsonWebSocketClient('ws://test');
        const onClose = vi.fn();
        const onMessage = vi.fn();

        client.onWebsocketCallbacksDo('close', {
            onClose,
        });
        client.onWebSocketMessageDo('message', {
            onMessage,
        });

        expect(client.removeWebsocketCallbackById('close')).toBe(true);
        expect(client.removeOnMessageCallbackById('message')).toBe(true);

        const connectPromise = client.connect();
        const socket = FakeWebSocket.instances[0];

        socket.readyState = FakeWebSocket.CLOSED;
        await socket.emit('close', {
            type: 'close',
            code: 1006,
            reason: 'boom',
        });

        await expect(connectPromise).rejects.toThrow(
            'WebSocket is closed. Code: 1006 Reason boom',
        );
        expect(client.ws).toBeUndefined();
        expect(onClose).not.toHaveBeenCalled();

        await socket.emit('message', {
            type: 'message',
            data: JSON.stringify({ ignored: true }),
        });
        expect(onMessage).not.toHaveBeenCalled();
        expect(() => client.send({ nope: true })).toThrow(
            'WebSocketClient: cannot send; socket is not open.',
        );
    });

    it('rejects the initial connection on error before open and can reconnect', async () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);

        const client = new JsonWebSocketClient('ws://test');
        const onError = vi.fn();

        client.onWebsocketCallbacksDo('error', {
            onError,
        });

        const firstConnect = client.connect();
        const firstSocket = FakeWebSocket.instances[0];

        await firstSocket.emit('error', { type: 'error' });

        await expect(firstConnect).rejects.toThrow('WebSocket error. Type: error');
        expect(onError).toHaveBeenCalledOnce();

        const secondConnect = client.connect();
        expect(FakeWebSocket.instances).toHaveLength(2);

        const secondSocket = FakeWebSocket.instances[1];
        secondSocket.readyState = FakeWebSocket.OPEN;
        await secondSocket.emit('open', { type: 'open' });

        await expect(secondConnect).resolves.toBeUndefined();
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
            onClose: (ctx) => lifecycle.push(`close:${ctx.id}`),
            onParseError: (_ctx, rawText) => parseErrors.push(rawText),
        });
        server.onMessageDo('messages', {
            onMessage: async (_ctx, data) => {
                messages.push(data);
            },
        });

        const socket = new FakeWebSocket('server');
        const ctx = new ConnectionContext('c1', socket as never);
        server.addConnection(ctx);

        socket.readyState = FakeWebSocket.OPEN;
        await socket.emit('open', { type: 'open' });
        await socket.emit('message', {
            type: 'message',
            data: JSON.stringify({ ok: 1 }),
        });
        await socket.emit('message', {
            type: 'message',
            data: 'not-json',
        });

        expect(server.connections.has('c1')).toBe(true);

        socket.readyState = FakeWebSocket.CLOSED;
        await socket.emit('close', {
            type: 'close',
            code: 1000,
            reason: 'bye',
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
            'JsonWebSocketServer: cannot send; connection not open: three',
        );

        const sent = server.broadcast({ ping: true }, (ctx) => ctx.id !== 'two');

        expect(sent).toBe(1);
        expect(first.sent).toEqual([
            JSON.stringify({ hello: true }),
            JSON.stringify({ ping: true }),
        ]);
        expect(second.sent).toEqual([]);
        expect(closed.sent).toEqual([]);
    });
});

describe('WsRtcSignalingTransport', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('wires socket lifecycle callbacks and forwards only matching message types', async () => {
        const socket = createSocketHarness();
        const transport = new WsRtcSignalingTransport(
            socket.client as never,
            'rtc',
        );
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
                },
            },
        });

        expect(socket.connect).toHaveBeenCalledOnce();

        const matching = createEnvelope('rtc', { hello: true });
        const ignored = createEnvelope('other', { ignored: true });

        await socket.webSocketCallbacks?.onOpen?.({ type: 'open' } as Event);
        await socket.onMessageCallback?.onMessage(ignored, {
            type: 'message',
        } as MessageEvent);
        await socket.onMessageCallback?.onMessage(matching, {
            type: 'message',
        } as MessageEvent);
        await socket.webSocketCallbacks?.onError?.({
            type: 'error',
            toString: () => 'socket failed',
        } as Event);
        await socket.webSocketCallbacks?.onClose?.({ type: 'close' } as CloseEvent);

        expect(messages).toEqual([matching]);
        expect(lifecycle).toEqual([
            'open:session-1:token-1',
            'error:socket failed',
            'close:session-1:token-1',
        ]);
    });

    it('wraps signaling payloads in an AL message when sending', async () => {
        const socket = createSocketHarness();
        const transport = new WsRtcSignalingTransport(
            socket.client as never,
            'rtc',
        );
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
        const consoleError = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {
            });
        const qbox = createQboxHarness();
        const transport = new WsRtcSignalingTransportUsingWsQBox(
            qbox.service as never,
            'rtc',
        );
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
                },
            },
        });

        expect(qbox.socket.connect).toHaveBeenCalledOnce();

        const matching = createEnvelope('rtc', { hello: true });
        const ignored = createEnvelope('other', { ignored: true });

        await qbox.socket.webSocketCallbacks?.onOpen?.({ type: 'open' } as Event);
        await qbox.inboxCallback?.onMessage(ignored, {} as never);
        await qbox.inboxCallback?.onMessage(matching, {} as never);
        await qbox.socket.webSocketCallbacks?.onError?.({
            type: 'error',
            toString: () => 'socket failed',
        } as Event);
        await qbox.socket.webSocketCallbacks?.onClose?.({
            type: 'close',
        } as CloseEvent);

        expect(messages).toEqual([matching]);
        expect(lifecycle).toEqual([
            'open:session-1:token-1',
            'error:socket failed',
            'close:session-1:token-1',
        ]);
        expect(consoleError).toHaveBeenCalled();
    });

    it('enqueues signaling payloads as AL messages', async () => {
        const qbox = createQboxHarness();
        const transport = new WsRtcSignalingTransportUsingWsQBox(
            qbox.service as never,
            'rtc',
        );
        const payload = createSignalingPayload();

        await transport.send(payload);

        expect(qbox.enqueueOutboxIfAbsent).toHaveBeenCalledOnce();

        const sent = qbox.enqueueOutboxIfAbsent.mock.calls[0][0] as ALMessage;

        expect(sent.payload.typeId).toBe('rtc');
        expect(sent.id.senderId).toBe(payload.fromId);
        expect(JSON.parse(sent.payload.resource)).toEqual(payload);
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

    private readonly listeners = new Map<
        string,
        Array<(event: unknown) => void | Promise<void>>
    >();

    constructor(public readonly url: string) {
        FakeWebSocket.instances.push(this);
    }

    addEventListener(
        type: string,
        handler: (event: unknown) => void | Promise<void>,
    ): void {
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

    close(): void {
        this.readyState = FakeWebSocket.CLOSED;
    }
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

    const connect = vi.fn(async () => {
    });
    const send = vi.fn();

    const client = {
        onWebsocketCallbacksDo: vi.fn(function (
            _id: string,
            callbacks: typeof state.webSocketCallbacks,
        ) {
            state.webSocketCallbacks = callbacks;
            return client;
        }),
        onWebSocketMessageDo: vi.fn(function (
            _id: string,
            callback: typeof state.onMessageCallback,
        ) {
            state.onMessageCallback = callback;
            return client;
        }),
        connect,
        send,
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
        },
    };
}

function createQboxHarness() {
    let inboxCallback:
        | {
        onMessage: (message: ALMessage, entry: unknown) => Promise<void>;
    }
        | undefined;

    const socket = createSocketHarness();
    const enqueueOutboxIfAbsent = vi.fn(async () => ({
        resourceId: 'outbox-entry',
    }));

    const service = {
        socket: socket.client,
        onInboxMessageDo: vi.fn(function (
            _id: string,
            callback: typeof inboxCallback,
        ) {
            inboxCallback = callback;
            return service;
        }),
        enqueueOutboxIfAbsent,
    };

    return {
        service,
        socket,
        enqueueOutboxIfAbsent,
        get inboxCallback() {
            return inboxCallback;
        },
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
            sdp: 'offer',
        },
    };
}

function createEnvelope(typeId: string, payload: unknown): ALMessage {
    return newALUnicastMessage(
        'peer-1',
        newALEventRoute(typeId, 'session-1'),
        'session-1',
        typeId,
        payload,
    );
}
