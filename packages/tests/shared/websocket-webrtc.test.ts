import { newALEventRoute, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import {
    DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS,
    WsQueueBoxClientService
} from '@shared/services/ws-queue-box-client-service.ts';
import {
    QRtcSignalingChannel,
    QRtcSignalingMsgType,
    QRtcSignalingType,
    type QRtcSignalingMessage,
    type QRtcSignalingTransportInputDto
} from '@shared/webrtc/QRtcSignalingContracts.ts';
import { WsRtcSignalingTransportUsingWsQBox } from '@shared/webrtc/ws-rtc-signaling-transport-using-ws-q-box.ts';
import { WsRtcSignalingTransport } from '@shared/webrtc/WsRtcSignalingTransport.ts';
import { JsonWebSocketClient } from '@shared/websocket/JsonWebSocketClient.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openConnectingWebSocket, SimulatedWebSocket } from './native-websocket-fixture.ts';

const services: WsQueueBoxClientService[] = [];
beforeEach(() => {
    vi.stubGlobal('WebSocket', SimulatedWebSocket);
});
afterEach(() => {
    for (const service of services.splice(0)) {
        service.close();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    SimulatedWebSocket.instances.length = 0;
});

describe('JsonWebSocketClient', () => {
    it('reuses a single pending connection and dispatches parsed messages', async () => {
        vi.stubGlobal('WebSocket', SimulatedWebSocket);

        const client = new JsonWebSocketClient('ws://test');
        const lifecycle: string[] = [];
        const messages: string[] = [];

        client.onWebsocketCallbacksDo('lifecycle', {
            onOpen: () => lifecycle.push('open')
        });
        client.onWebSocketMessageDo('messages', {
            onMessage: async (data) => {
                messages.push(JSON.stringify(data));
            }
        });

        const first = client.connect();
        const second = client.connect();
        await Promise.resolve();

        expect(SimulatedWebSocket.instances).toHaveLength(1);

        const socket = SimulatedWebSocket.instances[0];
        socket.readyState = SimulatedWebSocket.OPEN;
        await socket.open();

        await Promise.all([first, second]);

        await socket.receive(JSON.stringify({ ok: 1 }));

        client.send({ ping: true });
        client.sendAsJsonString('{"pong":true}');

        expect(lifecycle).toEqual(['open']);
        expect(messages).toEqual(['{"ok":1}']);
        expect(socket.sent).toEqual([JSON.stringify({ ping: true }), '{"pong":true}']);
    });

    it('rejects the initial connection on close before open and supports callback removal', async () => {
        vi.stubGlobal('WebSocket', SimulatedWebSocket);

        const client = new JsonWebSocketClient('ws://test');
        let closeNotifications = 0;
        let messageNotifications = 0;

        client.onWebsocketCallbacksDo('close', {
            onClose: () => {
                closeNotifications += 1;
            }
        });
        client.onWebSocketMessageDo('message', {
            onMessage: async () => {
                messageNotifications += 1;
            }
        });

        expect(client.removeWebsocketCallbackById('close')).toBe(true);
        expect(client.removeOnMessageCallbackById('message')).toBe(true);

        const connectPromise = client.connect();
        await Promise.resolve();
        const socket = SimulatedWebSocket.instances[0];

        socket.readyState = SimulatedWebSocket.CLOSED;
        await socket.receiveClose(1006, 'boom');

        await expect(connectPromise).rejects.toThrow('WebSocket is closed. Code: 1006 Reason boom');
        expect(client.ws).toBeUndefined();
        expect(closeNotifications).toBe(0);

        await socket.receive(JSON.stringify({ ignored: true }));
        expect(messageNotifications).toBe(0);
        expect(() => client.send({ nope: true })).toThrow(
            'WebSocketClient: cannot send; socket is not open.'
        );
    });

    it('rejects the initial connection on error before open and can reconnect', async () => {
        vi.stubGlobal('WebSocket', SimulatedWebSocket);

        const client = new JsonWebSocketClient('ws://test');
        let errorNotifications = 0;

        client.onWebsocketCallbacksDo('error', {
            onError: () => {
                errorNotifications += 1;
            }
        });

        const firstConnect = client.connect();
        await Promise.resolve();
        const firstSocket = SimulatedWebSocket.instances[0];

        await firstSocket.fail();

        await expect(firstConnect).rejects.toThrow('WebSocket error. Type: error');
        expect(errorNotifications).toBe(1);

        const secondConnect = client.connect();
        await Promise.resolve();
        expect(SimulatedWebSocket.instances).toHaveLength(2);

        const secondSocket = SimulatedWebSocket.instances[1];
        secondSocket.readyState = SimulatedWebSocket.OPEN;
        await secondSocket.open();

        await expect(secondConnect).resolves.toBeUndefined();
    });

    it('resolves a fresh URL for each new socket connection', async () => {
        vi.stubGlobal('WebSocket', SimulatedWebSocket);

        let sequence = 0;
        const client = new JsonWebSocketClient(() => `ws://test?ticket=${++sequence}`);

        const firstConnect = client.connect();
        await Promise.resolve();
        expect(SimulatedWebSocket.instances[0].url).toBe('ws://test?ticket=1');
        SimulatedWebSocket.instances[0].readyState = SimulatedWebSocket.OPEN;
        await SimulatedWebSocket.instances[0].open();
        await expect(firstConnect).resolves.toBeUndefined();
        expect(client.url).toBe('ws://test?ticket=1');

        client.close(1000, 'test-reconnect');

        const secondConnect = client.connect();
        await Promise.resolve();
        expect(SimulatedWebSocket.instances[1].url).toBe('ws://test?ticket=2');
        SimulatedWebSocket.instances[1].readyState = SimulatedWebSocket.OPEN;
        await SimulatedWebSocket.instances[1].open();
        await expect(secondConnect).resolves.toBeUndefined();
        expect(client.url).toBe('ws://test?ticket=2');
    });

    it('keeps a reconnect started by a close callback as the active pending connection', async () => {
        vi.stubGlobal('WebSocket', SimulatedWebSocket);

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
        const firstSocket = SimulatedWebSocket.instances[0];
        firstSocket.readyState = SimulatedWebSocket.OPEN;
        await firstSocket.open();
        await expect(firstConnect).resolves.toBeUndefined();

        firstSocket.readyState = SimulatedWebSocket.CLOSED;
        await firstSocket.receiveClose(1006, 'network-lost');
        const joinedReconnect = client.connect();
        await Promise.resolve();

        expect(SimulatedWebSocket.instances).toHaveLength(2);
        const secondSocket = SimulatedWebSocket.instances[1];
        expect(secondSocket.url).toBe('ws://test?ticket=2');
        secondSocket.readyState = SimulatedWebSocket.OPEN;
        await secondSocket.open();

        expect(reconnectPromise).toBeDefined();
        if (!reconnectPromise) {
            throw new Error('Expected a reconnect action');
        }
        await expect(reconnectPromise).resolves.toBeUndefined();
        await expect(joinedReconnect).resolves.toBeUndefined();
        expect(client.ws).toBe(secondSocket);
    });

    it('clears the active socket when a pending connection is aborted', async () => {
        vi.stubGlobal('WebSocket', SimulatedWebSocket);

        const controller = new AbortController();
        const client = new JsonWebSocketClient('ws://test');

        const connectPromise = client.connect({
            signal: controller.signal
        });
        await Promise.resolve();

        const socket = SimulatedWebSocket.instances[0];
        expect(client.ws).toBe(socket);

        controller.abort();

        await expect(connectPromise).rejects.toThrow('WebSocket connect aborted.');
        expect(client.ws).toBeUndefined();
        expect(socket.readyState).toBe(SimulatedWebSocket.CLOSED);
    });
});

describe('JsonWebSocketServer', () => {
    it('dispatches lifecycle, parse errors, and decoded messages', async () => {
        vi.stubGlobal('WebSocket', SimulatedWebSocket);

        const server = new JsonWebSocketServer();
        const lifecycle: string[] = [];
        const parseErrors: string[] = [];
        const messages: string[] = [];

        server.onWebsocketCallbacksDo('callbacks', {
            onConnection: (ctx) => lifecycle.push(`open:${ctx.id}`),
            onClose: (ctx) => {
                lifecycle.push(`close:${ctx.id}`);
            },
            onParseError: (_ctx, rawText) => parseErrors.push(rawText)
        });
        server.onMessageDo('messages', {
            onMessage: async (_ctx, data) => {
                messages.push(JSON.stringify(data));
            }
        });

        const socket = new SimulatedWebSocket('server');
        const ctx = new ConnectionContext('c1', socket);
        server.addConnection(ctx);

        socket.readyState = SimulatedWebSocket.OPEN;
        await socket.open();
        await socket.receive(JSON.stringify({ ok: 1 }));
        await socket.receive('not-json');

        expect(server.connections.has('c1')).toBe(true);

        socket.readyState = SimulatedWebSocket.CLOSED;
        await socket.receiveClose(1000, 'bye');

        expect(lifecycle).toEqual(['open:c1', 'close:c1']);
        expect(parseErrors).toEqual(['not-json']);
        expect(messages).toEqual(['{"ok":1}', '"not-json"']);
        expect(server.connections.has('c1')).toBe(false);
    });

    it('sends directly and broadcasts only to open filtered connections', () => {
        vi.stubGlobal('WebSocket', SimulatedWebSocket);

        const server = new JsonWebSocketServer();
        const first = new SimulatedWebSocket('first');
        const second = new SimulatedWebSocket('second');
        const closed = new SimulatedWebSocket('closed');

        first.readyState = SimulatedWebSocket.OPEN;
        second.readyState = SimulatedWebSocket.OPEN;
        closed.readyState = SimulatedWebSocket.CLOSED;

        server.addConnection(new ConnectionContext('one', first));
        server.addConnection(new ConnectionContext('two', second));
        server.addConnection(new ConnectionContext('three', closed));

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

    it('reuses a pre-encoded payload for direct sends', () => {
        vi.stubGlobal('WebSocket', SimulatedWebSocket);

        const server = new JsonWebSocketServer();
        const first = new SimulatedWebSocket('first');
        const second = new SimulatedWebSocket('second');

        first.readyState = SimulatedWebSocket.OPEN;
        second.readyState = SimulatedWebSocket.OPEN;

        server.addConnection(new ConnectionContext('one', first));
        server.addConnection(new ConnectionContext('two', second));

        const encoded = server.encode({ fanout: true });
        server.sendEncoded('one', encoded);
        server.sendEncoded('two', encoded);

        expect(first.sent).toEqual([encoded.text]);
        expect(second.sent).toEqual([encoded.text]);
    });

    it('sends an encoded payload only to the captured connection generation', () => {
        vi.stubGlobal('WebSocket', SimulatedWebSocket);

        const server = new JsonWebSocketServer();
        const first = new SimulatedWebSocket('first');
        const replacement = new SimulatedWebSocket('replacement');
        first.readyState = SimulatedWebSocket.OPEN;
        replacement.readyState = SimulatedWebSocket.OPEN;
        const captured = new ConnectionContext('session-1', first, 'generation-1');
        const current = new ConnectionContext('session-1', replacement, 'generation-2');
        server.addConnection(captured);
        const encoded = server.encode({ topology: true });

        server.addConnection(current);

        expect(server.trySendEncodedToContext(captured, encoded)).toBe(false);
        expect(server.trySendEncodedToContext(current, encoded)).toBe(true);
        expect(first.sent).toEqual([]);
        expect(replacement.sent).toEqual([encoded.text]);
    });

    it('replaces duplicate connection ids without letting stale close remove the current socket', async () => {
        vi.stubGlobal('WebSocket', SimulatedWebSocket);

        const server = new JsonWebSocketServer();
        const lifecycle: string[] = [];
        const first = new SimulatedWebSocket('first');
        const second = new SimulatedWebSocket('second');

        first.readyState = SimulatedWebSocket.OPEN;
        second.readyState = SimulatedWebSocket.OPEN;
        const firstContext = new ConnectionContext('session-1', first);
        const secondContext = new ConnectionContext('session-1', second);
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

        await first.receiveClose(1000, 'connection-replaced');

        expect(server.connections.get('session-1')?.socket).toBe(second);
        expect(lifecycle).toEqual(['close:session-1:false']);

        second.readyState = SimulatedWebSocket.CLOSED;
        await second.receiveClose(1000, 'done');

        expect(server.connections.has('session-1')).toBe(false);
        expect(lifecycle).toEqual(['close:session-1:false', 'close:session-1:true']);
    });

    it('can close a live connection by id for auth logout', () => {
        vi.stubGlobal('WebSocket', SimulatedWebSocket);

        const server = new JsonWebSocketServer();
        const socket = new SimulatedWebSocket('session');
        socket.readyState = SimulatedWebSocket.OPEN;
        server.addConnection(new ConnectionContext('session-1', socket));

        expect(server.closeConnection('missing-session')).toBe(false);
        expect(server.closeConnection('session-1', 1000, 'auth-logout')).toBe(true);
        expect(socket.closedWith).toEqual({
            code: 1000,
            reason: 'auth-logout'
        });
        expect(socket.readyState).toBe(SimulatedWebSocket.CLOSED);
    });
});

describe('RTC signaling WebSocket transports', () => {
    it('delivers direct signaling only for the registered type through native events', async () => {
        const client = new JsonWebSocketClient('ws://test');
        const transport = new WsRtcSignalingTransport(client, 'rtc');
        const lifecycle: string[] = [];
        const messages: ALMessage[] = [];
        const connecting = transport.connect(signalingConnectionInput(lifecycle, messages));
        const native = await openConnectingWebSocket(client, connecting);
        const matching = createEnvelope('rtc', { hello: true });
        await native.receive(JSON.stringify(createEnvelope('other', { ignored: true })));
        await native.receive(JSON.stringify(matching));
        await native.fail();
        await native.receiveClose(1006, 'network-lost');

        expect(messages).toEqual([matching]);
        expect(lifecycle).toEqual(['open:session-1', 'error', 'close:session-1']);
    });

    it('serializes direct signaling as a canonical AL envelope at the native socket', async () => {
        const client = new JsonWebSocketClient('ws://test');
        const native = await openConnectingWebSocket(client, client.connect());
        const transport = new WsRtcSignalingTransport(client, 'rtc');
        const payload = createSignalingPayload();
        await transport.send(payload);

        expect(native.sent).toHaveLength(1);
        const envelope = decodePersistedALMessage(native.sent[0]);
        expect(envelope.payload.typeId).toBe('rtc');
        expect(envelope.id.senderId).toBe('peer-1');
        expect(envelope.payload.resource).toBe(JSON.stringify(payload));
    });

    it('delivers queue-box signaling through the actual WS receive and inbox path', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const client = new JsonWebSocketClient('ws://test');
        const service = createWsQueueBoxService(client).enableDefaultCallbacks();
        const transport = new WsRtcSignalingTransportUsingWsQBox(service, 'rtc');
        const lifecycle: string[] = [];
        const messages: ALMessage[] = [];
        const native = await openConnectingWebSocket(client, transport.connect(signalingConnectionInput(lifecycle, messages)));
        const matching = createEnvelope('rtc', { hello: true });
        await native.receive(JSON.stringify(createEnvelope('other', { ignored: true })));
        await native.receive(JSON.stringify(matching));
        await native.fail();
        await native.receiveClose(1006, 'network-lost');

        expect(messages).toEqual([matching]);
        expect(lifecycle).toEqual(['open:session-1', 'error', 'close:session-1']);
    });

    it('queues canonical signaling while offline and wakes the outbox worker', async () => {
        const client = new JsonWebSocketClient('ws://test');
        const service = createWsQueueBoxService(client);
        let wakeCount = 0;
        const transport = new WsRtcSignalingTransportUsingWsQBox(service, 'rtc', () => {
            wakeCount++;
        });
        const payload = createSignalingPayload();
        await transport.send(payload);

        const keys = await service.outbox.getAllKeys();
        expect(keys).toHaveLength(1);
        const entry = await service.outbox.getItem(keys[0]);
        if (!entry) {
            throw new Error('Expected queued signaling');
        }
        const envelope = decodePersistedALMessage(entry.resource);
        expect(envelope.payload.typeId).toBe('rtc');
        expect(envelope.id.senderId).toBe('peer-1');
        expect(envelope.payload.resource).toBe(JSON.stringify(payload));
        expect(wakeCount).toBe(1);
    });
});

describe('WsQueueBoxClientService reconnect lifecycle', () => {
    it('reuses one ticket identity after a lost response within one reconnect action', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', SimulatedWebSocket);
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
        const initialSocket = SimulatedWebSocket.instances[0];
        initialSocket.readyState = SimulatedWebSocket.OPEN;
        await initialSocket.open();
        await initialConnect;
        requestIds.length = 0;
        SimulatedWebSocket.instances.length = 0;
        service.enableReconnect();
        loseNextResponse = true;
        initialSocket.readyState = SimulatedWebSocket.CLOSED;
        await initialSocket.receiveClose(1006, 'network-lost');
        await vi.runAllTimersAsync();
        await vi.waitFor(() => expect(SimulatedWebSocket.instances).toHaveLength(1));

        const connected = SimulatedWebSocket.instances[0];
        connected.readyState = SimulatedWebSocket.OPEN;
        await connected.open();

        expect(requestIds).toEqual(['reconnect-request-1', 'reconnect-request-1']);
    });

    it('allocates a new ticket request identity for a later reconnect action', async () => {
        vi.stubGlobal('WebSocket', SimulatedWebSocket);
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
        const initialSocket = SimulatedWebSocket.instances[0];
        initialSocket.readyState = SimulatedWebSocket.OPEN;
        await initialSocket.open();
        await initialConnect;
        requestIds.length = 0;
        SimulatedWebSocket.instances.length = 0;
        service.enableReconnect();
        initialSocket.readyState = SimulatedWebSocket.CLOSED;
        await initialSocket.receiveClose(1006, 'network-lost');
        await vi.waitFor(() => expect(SimulatedWebSocket.instances).toHaveLength(1));
        const first = SimulatedWebSocket.instances[0];
        first.readyState = SimulatedWebSocket.OPEN;
        await first.open();
        await vi.waitFor(() => expect(service.readHealth().reconnecting).toBe(false));

        first.readyState = SimulatedWebSocket.CLOSED;
        await first.receiveClose(1006, 'network-lost-again');
        await vi.waitFor(() => expect(SimulatedWebSocket.instances).toHaveLength(2));
        const second = SimulatedWebSocket.instances[1];
        second.readyState = SimulatedWebSocket.OPEN;
        await second.open();

        expect(requestIds).toEqual(['reconnect-request-1', 'reconnect-request-2']);
    });

    it('does not reconnect after an intentional service close', async () => {
        const client = new JsonWebSocketClient('ws://test');
        const native = await openConnectingWebSocket(client, client.connect());
        const service = createWsQueueBoxService(client);
        service.enableReconnect();
        service.close(1000, 'rallar-disconnect');
        await native.receiveClose(1000, 'rallar-disconnect');

        expect(native.closedWith).toEqual({ code: 1000, reason: 'rallar-disconnect' });
        expect(SimulatedWebSocket.instances).toEqual([native]);
        expect(service.readHealth()).toMatchObject({ reconnectEnabled: false, reconnecting: false });
    });

    it('stops an offline reconnect loop when reconnect is disabled', async () => {
        vi.useFakeTimers();
        let offline = false;
        const attemptedTickets: string[] = [];
        const client = new JsonWebSocketClient(() => {
            if (offline) {
                attemptedTickets.push('attempt');
                throw new Error('offline');
            }
            return 'ws://test';
        });
        const native = await openConnectingWebSocket(client, client.connect());
        const service = createWsQueueBoxService(client);
        service.enableReconnect();
        offline = true;
        await native.receiveClose(1006, 'network-lost');
        expect(service.readHealth()).toMatchObject({ reconnectEnabled: true, reconnecting: true });
        service.disableReconnect();
        await vi.advanceTimersByTimeAsync(500);

        expect(attemptedTickets).toEqual(['attempt']);
        expect(service.readHealth()).toMatchObject({ reconnectEnabled: false, reconnecting: false });
    });

    it('stops after the configured number of failed ticket attempts', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        let offline = false;
        const attemptedTickets: string[] = [];
        const client = new JsonWebSocketClient(() => {
            if (offline) {
                attemptedTickets.push('attempt');
                throw new Error('offline');
            }
            return 'ws://test';
        });
        const native = await openConnectingWebSocket(client, client.connect());
        const service = createWsQueueBoxService(client, {
            reconnect: {
                maxAttempts: 3,
                retryIntervalMsecs: 0,
                maxRetryIntervalMsecs: 0
            }
        });
        service.enableReconnect();
        offline = true;
        await native.receiveClose(1006, 'network-lost');
        await vi.runAllTimersAsync();

        expect(attemptedTickets).toEqual(['attempt', 'attempt', 'attempt']);
        expect(service.readHealth()).toMatchObject({
            reconnectEnabled: false,
            reconnecting: false,
            reconnectAttempts: 3,
            maxReconnectAttempts: 3,
            reconnectExhausted: true
        });
    });

    it('aborts a native connection that exceeds its reconnect timeout', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const client = new JsonWebSocketClient('ws://test');
        const native = await openConnectingWebSocket(client, client.connect());
        const service = createWsQueueBoxService(client, {
            reconnect: {
                maxAttempts: 1,
                connectTimeoutMsecs: 25,
                retryIntervalMsecs: 0,
                maxRetryIntervalMsecs: 0
            }
        });
        service.enableReconnect();
        await native.receiveClose(1006, 'network-lost');
        await vi.advanceTimersByTimeAsync(25);
        const pending = SimulatedWebSocket.instances[1];

        expect(pending.closedWith).toEqual({ code: 1000, reason: 'connect-aborted' });
        expect(pending.readyState).toBe(SimulatedWebSocket.CLOSED);
        expect(service.readHealth()).toMatchObject({
            reconnectEnabled: false,
            reconnecting: false,
            reconnectAttempts: 1,
            maxReconnectAttempts: 1,
            reconnectExhausted: true
        });
    });

    it('does not reconnect when the current session is ineligible', async () => {
        const client = new JsonWebSocketClient('ws://test');
        const native = await openConnectingWebSocket(client, client.connect());
        const service = createWsQueueBoxService(client, { reconnect: { canReconnect: () => false } });
        service.enableReconnect();
        await native.receiveClose(1006, 'network-lost');

        expect(SimulatedWebSocket.instances).toEqual([native]);
        expect(service.readHealth()).toMatchObject({
            reconnectEnabled: false,
            reconnecting: false,
            reconnectAttempts: 0,
            reconnectExhausted: false
        });
    });
});

type WsQueueBoxClientServiceTestOptions =
    & Omit<Partial<WsQueueBoxClientService.Options>, 'reconnect'>
    & Readonly<{
        reconnect?: Partial<WsQueueBoxClientService.ReconnectOptions>;
    }>;

function createWsQueueBoxService(
    socket: JsonWebSocketClient,
    options: WsQueueBoxClientServiceTestOptions = {}
): WsQueueBoxClientService {
    const service = new WsQueueBoxClientService({ inbox: new InMemoryQueueBox(), outbox: new InMemoryQueueBox(), socket }, {
        sessionId: 'session-1'
    }, { ...options, reconnect: { ...DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS, ...options.reconnect } });
    services.push(service);
    return service;
}

function signalingConnectionInput(lifecycle: string[], messages: ALMessage[]): QRtcSignalingTransportInputDto {
    return {
        sessionId: 'session-1',
        token: 'fixture-token',
        callbacks: {
            onOpen: async (sessionId) => {
                lifecycle.push(`open:${sessionId}`);
            },
            onClose: async (sessionId) => {
                lifecycle.push(`close:${sessionId}`);
            },
            onError: async () => {
                lifecycle.push('error');
            },
            onMessage: async (_sessionId, _token, message) => {
                messages.push(message);
            }
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
        token: 'fixture-token',
        signalType: QRtcSignalingType.Offer,
        payload: { description: { type: 'offer', sdp: 'fixture-sdp' }, candidate: null }
    };
}

function createEnvelope(typeId: string, payload: object): ALMessage {
    return newALUnicastMessage(
        'peer-1',
        newALEventRoute(typeId, 'session-1'),
        'session-1',
        typeId,
        payload
    );
}
