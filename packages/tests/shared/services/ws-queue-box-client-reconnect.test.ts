import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import {
    createDefaultWsQueueBoxClientService,
    DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS,
    type WsQueueBoxClientReconnectOptions,
    type WsQueueBoxClientService
} from '@shared/services/ws-queue-box-client-service.ts';
import { JsonWebSocketClient } from '@shared/websocket/JsonWebSocketClient.ts';

import { TestWebSocket } from '../websocket/test-web-socket.ts';

interface ReconnectTestConfig {
    readonly newConnectionRequestId?: () => string;
    readonly reconnect?: Partial<WsQueueBoxClientReconnectOptions>;
}

describe('WsQueueBoxClientService reconnect lifecycle', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it('reuses one ticket identity after a lost response within one reconnect action', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', TestWebSocket);
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
        const service = createDefaultReconnectService(socket, {
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
        const initialSocket = TestWebSocket.instances[0];
        initialSocket.open();
        await initialConnect;
        requestIds.length = 0;
        TestWebSocket.instances.length = 0;
        service.enableReconnect();
        loseNextResponse = true;
        initialSocket.disconnect(1006, 'network-lost');
        await vi.runAllTimersAsync();
        await vi.waitFor(() => expect(TestWebSocket.instances).toHaveLength(1));

        const connected = TestWebSocket.instances[0];
        connected.open();

        expect(requestIds).toEqual(['reconnect-request-1', 'reconnect-request-1']);
    });

    it('allocates a new ticket request identity for a later reconnect action', async () => {
        vi.stubGlobal('WebSocket', TestWebSocket);
        const requestIds: Array<string | undefined> = [];
        let requestSequence = 0;
        const socket = new JsonWebSocketClient((options) => {
            requestIds.push(options.requestId);
            return `ws://test?requestId=${options.requestId}`;
        });
        const service = createDefaultReconnectService(socket, {
            newConnectionRequestId: () => `reconnect-request-${++requestSequence}`,
            reconnect: {
                connectTimeoutMsecs: 0,
                retryIntervalMsecs: 0,
                maxRetryIntervalMsecs: 0
            }
        });

        const initialConnect = socket.connect({ requestId: 'initial-request' });
        await Promise.resolve();
        const initialSocket = TestWebSocket.instances[0];
        initialSocket.open();
        await initialConnect;
        requestIds.length = 0;
        TestWebSocket.instances.length = 0;
        service.enableReconnect();
        initialSocket.disconnect(1006, 'network-lost');
        await vi.waitFor(() => expect(TestWebSocket.instances).toHaveLength(1));
        const first = TestWebSocket.instances[0];
        first.open();
        await vi.waitFor(() => expect(service.readHealth().reconnecting).toBe(false));

        first.disconnect(1006, 'network-lost-again');
        await vi.waitFor(() => expect(TestWebSocket.instances).toHaveLength(2));
        const second = TestWebSocket.instances[1];
        second.open();

        expect(requestIds).toEqual(['reconnect-request-1', 'reconnect-request-2']);
    });

    it('reconnects after an unexpected WebSocket close while reconnect is enabled', async () => {
        const client = new JsonWebSocketClient('ws://test');
        const service = createDefaultReconnectService(client);
        const first = await openInitialConnection(client);
        service.enableReconnect();

        first.disconnect(1006, 'network-lost');
        await vi.waitFor(() => expect(TestWebSocket.instances).toHaveLength(2));
        TestWebSocket.instances[1].open();

        await vi.waitFor(() =>
            expect(service.readHealth()).toMatchObject({
                reconnectEnabled: true,
                reconnecting: false,
                readyState: 'open'
            })
        );
    });

    it('does not reconnect after an intentional service close', async () => {
        vi.useFakeTimers();
        const client = new JsonWebSocketClient('ws://test');
        const service = createDefaultReconnectService(client);
        const socket = await openInitialConnection(client);
        service.enableReconnect();

        service.close(1000, 'rallar-disconnect');
        socket.disconnect(1000, 'rallar-disconnect');
        await vi.advanceTimersByTimeAsync(5_000);

        expect(socket.closedWith).toEqual({ code: 1000, reason: 'rallar-disconnect' });
        expect(TestWebSocket.instances).toHaveLength(1);
        expect(service.readHealth()).toMatchObject({
            reconnectEnabled: false,
            reconnecting: false
        });
    });

    it('stops a pending reconnect loop when reconnect is disabled', async () => {
        vi.useFakeTimers();
        let connectionRequests = 0;
        const client = new JsonWebSocketClient(() => {
            if (++connectionRequests > 1) {
                throw new Error('offline');
            }
            return 'ws://test';
        });
        const service = createDefaultReconnectService(client);
        const socket = await openInitialConnection(client);
        service.enableReconnect();

        socket.disconnect(1006, 'network-lost');
        await vi.advanceTimersByTimeAsync(0);
        expect(service.readHealth().reconnecting).toBe(true);

        service.disableReconnect();
        await vi.advanceTimersByTimeAsync(5_000);

        expect(connectionRequests).toBe(2);
        expect(service.readHealth()).toMatchObject({
            reconnectEnabled: false,
            reconnecting: false
        });
    });

    it('gives up after the configured reconnect attempts', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        let connectionRequests = 0;
        const client = new JsonWebSocketClient(() => {
            if (++connectionRequests > 1) {
                throw new Error('offline');
            }
            return 'ws://test';
        });
        const service = createDefaultReconnectService(client, {
            reconnect: { maxAttempts: 3, retryIntervalMsecs: 0, maxRetryIntervalMsecs: 0 }
        });
        const socket = await openInitialConnection(client);
        service.enableReconnect();

        socket.disconnect(1006, 'network-lost');
        await vi.runAllTimersAsync();

        expect(connectionRequests).toBe(4);
        expect(service.readHealth()).toMatchObject({
            reconnectEnabled: false,
            reconnecting: false,
            reconnectAttempts: 3,
            maxReconnectAttempts: 3,
            reconnectExhausted: true
        });
    });

    it('aborts the real pending socket when an individual reconnect attempt times out', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const client = new JsonWebSocketClient('ws://test');
        const service = createDefaultReconnectService(client, {
            reconnect: { maxAttempts: 1, connectTimeoutMsecs: 25, retryIntervalMsecs: 0, maxRetryIntervalMsecs: 0 }
        });
        const socket = await openInitialConnection(client);
        service.enableReconnect();

        socket.disconnect(1006, 'network-lost');
        await vi.advanceTimersByTimeAsync(0);
        expect(TestWebSocket.instances).toHaveLength(2);
        const pending = TestWebSocket.instances[1];
        expect(pending.readyState).toBe(TestWebSocket.CONNECTING);

        await vi.advanceTimersByTimeAsync(25);

        expect(pending.closedWith).toEqual({ code: 1000, reason: 'connect-aborted' });
        expect(pending.readyState).toBe(TestWebSocket.CLOSED);
        expect(client.ws).toBeUndefined();
        expect(service.readHealth()).toMatchObject({
            reconnectEnabled: false,
            reconnecting: false,
            reconnectAttempts: 1,
            maxReconnectAttempts: 1,
            reconnectExhausted: true
        });
    });

    it('does not reconnect when reconnect eligibility is false', async () => {
        vi.useFakeTimers();
        const client = new JsonWebSocketClient('ws://test');
        const service = createDefaultReconnectService(client, { reconnect: { canReconnect: () => false } });
        const socket = await openInitialConnection(client);
        service.enableReconnect();

        socket.disconnect(1006, 'network-lost');
        await vi.advanceTimersByTimeAsync(5_000);

        expect(TestWebSocket.instances).toHaveLength(1);
        expect(service.readHealth()).toMatchObject({
            reconnectEnabled: false,
            reconnecting: false,
            reconnectAttempts: 0,
            reconnectExhausted: false
        });
    });
});

function createDefaultReconnectService(
    socket: JsonWebSocketClient,
    config: ReconnectTestConfig = {}
): WsQueueBoxClientService {
    vi.stubGlobal('WebSocket', TestWebSocket);
    const service = createDefaultWsQueueBoxClientService({
        inbox: new InMemoryQueueBox(new Map()),
        outbox: new InMemoryQueueBox(new Map()),
        socket,
        sessionId: 'session-1',
        newConnectionRequestId: config.newConnectionRequestId,
        reconnect: { ...DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS, ...config.reconnect }
    });
    onTestFinished(() => service.close(1000, 'test-finished'));
    return service;
}

async function openInitialConnection(client: JsonWebSocketClient): Promise<TestWebSocket> {
    const connected = client.connect();
    await Promise.resolve();
    const socket = TestWebSocket.instances.at(-1);
    if (!socket) {
        throw new Error('Connecting the client must create a WebSocket');
    }
    socket.open();
    await connected;
    return socket;
}
