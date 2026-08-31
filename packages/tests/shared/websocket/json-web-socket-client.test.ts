import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { JsonWebSocketClient } from '@shared/websocket/JsonWebSocketClient.ts';

import { TestWebSocket } from './test-web-socket.ts';

describe('JsonWebSocketClient', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it('reuses a single pending connection and dispatches parsed messages', async () => {
        vi.stubGlobal('WebSocket', TestWebSocket);

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

        expect(TestWebSocket.instances).toHaveLength(1);

        const socket = TestWebSocket.instances[0];
        socket.open();

        await Promise.all([first, second]);

        socket.receive(JSON.stringify({ ok: 1 }));

        client.send({ ping: true });
        client.sendAsJsonString('{"pong":true}');

        expect(lifecycle).toEqual(['open']);
        await vi.waitFor(() => expect(messages).toEqual(['{"ok":1}']));
        expect(socket.sent).toEqual([JSON.stringify({ ping: true }), '{"pong":true}']);

        expect(client.removeOnMessageCallbackById('messages')).toBe(true);
        const remainingMessages: string[] = [];
        client.onWebSocketMessageDo('remaining', {
            onMessage: async (data) => {
                remainingMessages.push(JSON.stringify(data));
            }
        });
        socket.receive(JSON.stringify({ afterRemoval: true }));
        await vi.waitFor(() => expect(remainingMessages).toEqual(['{"afterRemoval":true}']));
        expect(messages).toEqual(['{"ok":1}']);
    });

    it('rejects the initial connection on close before open without notifying a removed lifecycle callback', async () => {
        vi.stubGlobal('WebSocket', TestWebSocket);

        const client = new JsonWebSocketClient('ws://test');
        let closeNotifications = 0;

        client.onWebsocketCallbacksDo('close', {
            onClose: () => {
                closeNotifications += 1;
            }
        });
        expect(client.removeWebsocketCallbackById('close')).toBe(true);

        const connectPromise = client.connect();
        await Promise.resolve();
        const socket = TestWebSocket.instances[0];

        socket.disconnect(1006, 'boom');

        await expect(connectPromise).rejects.toThrow('WebSocket is closed. Code: 1006 Reason boom');
        expect(client.ws).toBeUndefined();
        expect(closeNotifications).toBe(0);

        expect(() => client.send({ nope: true })).toThrow(
            'WebSocketClient: cannot send; socket is not open.'
        );
    });

    it('rejects the initial connection on error before open and can reconnect', async () => {
        vi.stubGlobal('WebSocket', TestWebSocket);

        const client = new JsonWebSocketClient('ws://test');
        let errorNotifications = 0;

        client.onWebsocketCallbacksDo('error', {
            onError: () => {
                errorNotifications += 1;
            }
        });

        const firstConnect = client.connect();
        await Promise.resolve();
        const firstSocket = TestWebSocket.instances[0];

        firstSocket.dispatchEvent(new Event('error'));

        await expect(firstConnect).rejects.toThrow('WebSocket error. Type: error');
        expect(errorNotifications).toBe(1);

        const secondConnect = client.connect();
        await Promise.resolve();
        expect(TestWebSocket.instances).toHaveLength(2);

        const secondSocket = TestWebSocket.instances[1];
        secondSocket.open();

        await expect(secondConnect).resolves.toBeUndefined();
    });

    it('resolves a fresh URL for each new socket connection', async () => {
        vi.stubGlobal('WebSocket', TestWebSocket);

        let sequence = 0;
        const client = new JsonWebSocketClient(() => `ws://test?ticket=${++sequence}`);

        const firstConnect = client.connect();
        await Promise.resolve();
        expect(TestWebSocket.instances[0].url).toBe('ws://test?ticket=1');
        TestWebSocket.instances[0].open();
        await expect(firstConnect).resolves.toBeUndefined();
        expect(client.url).toBe('ws://test?ticket=1');

        client.close(1000, 'test-reconnect');

        const secondConnect = client.connect();
        await Promise.resolve();
        expect(TestWebSocket.instances[1].url).toBe('ws://test?ticket=2');
        TestWebSocket.instances[1].open();
        await expect(secondConnect).resolves.toBeUndefined();
        expect(client.url).toBe('ws://test?ticket=2');
    });

    it('keeps a reconnect started by a close callback as the active pending connection', async () => {
        vi.stubGlobal('WebSocket', TestWebSocket);

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
        const firstSocket = TestWebSocket.instances[0];
        firstSocket.open();
        await expect(firstConnect).resolves.toBeUndefined();

        firstSocket.disconnect(1006, 'network-lost');
        const joinedReconnect = client.connect();
        await Promise.resolve();

        expect(TestWebSocket.instances).toHaveLength(2);
        const secondSocket = TestWebSocket.instances[1];
        expect(secondSocket.url).toBe('ws://test?ticket=2');
        secondSocket.open();

        expect(reconnectPromise).toBeDefined();
        await expect(reconnectPromise).resolves.toBeUndefined();
        await expect(joinedReconnect).resolves.toBeUndefined();
        expect(client.ws).toBe(secondSocket);
    });

    it('clears the active socket when a pending connection is aborted', async () => {
        vi.stubGlobal('WebSocket', TestWebSocket);

        const controller = new AbortController();
        const client = new JsonWebSocketClient('ws://test');

        const connectPromise = client.connect({
            signal: controller.signal
        });
        await Promise.resolve();

        const socket = TestWebSocket.instances[0];
        expect(client.ws).toBe(socket);

        controller.abort();

        await expect(connectPromise).rejects.toThrow('WebSocket connect aborted.');
        expect(client.ws).toBeUndefined();
        expect(socket.readyState).toBe(TestWebSocket.CLOSED);
    });
});
