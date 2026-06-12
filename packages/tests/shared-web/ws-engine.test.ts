import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ClientInfo } from '@shared/api/api-config.ts';
import { CommandTimedOutError } from '@shared/cache/Command.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { type WebSocketConnectOptions } from '@shared/websocket/JsonWebSocketClient.ts';
import { configureBrowserALRuntimeStores } from '@shared-web/browser/browser-al-runtime-stores.ts';
import { initialiseWsEngine } from '@shared-web/browser/ws-engine.ts';
import { toResilienceDto } from '@shared-web/browser/resilience-config.ts';

describe('initialiseWsEngine', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('connects the socket once and returns the queuebox service after connect resolves', async () => {
        const socket = new TestJsonWebSocketClient();
        const qboxEngine = new InboxOutboxEngine();

        const service = await initialiseWsEngine(
            qboxEngine,
            socket.asJsonWebSocketClient(),
            testClientInfo(),
            toResilienceDto(),
            {
                connectTimeoutMs: 25,
            },
        );

        expect(service.socket).toBe(socket);
        expect(socket.connectCalls).toHaveLength(1);
        expect(socket.connectCalls[0].signal).toBeInstanceOf(AbortSignal);
        expect(socket.webSocketCallbackIds).toEqual(['session-1']);
        expect(socket.messageCallbackIds).toEqual(['session-1-inbox']);
    });

    it('rejects a hanging socket connect with CommandTimedOutError and aborts the connect signal', async () => {
        vi.useFakeTimers();
        const socket = new TestJsonWebSocketClient({
            hangConnect: true,
        });
        const qboxEngine = new InboxOutboxEngine();

        const initPromise = initialiseWsEngine(
            qboxEngine,
            socket.asJsonWebSocketClient(),
            testClientInfo(),
            toResilienceDto(),
            {
                connectTimeoutMs: 25,
            },
        );
        await Promise.resolve();

        expect(socket.connectCalls).toHaveLength(1);
        expect(socket.connectCalls[0].signal?.aborted).toBe(false);

        const rejected = expect(initPromise).rejects.toBeInstanceOf(CommandTimedOutError);
        await vi.advanceTimersByTimeAsync(25);

        await rejected;
        expect(socket.connectCalls[0].signal?.aborted).toBe(true);
        expect(socket.connectCalls[0].signal?.reason).toBeInstanceOf(CommandTimedOutError);
    });

    it('uses the default websocket connect timeout when no timeout is provided', async () => {
        vi.useFakeTimers();
        const socket = new TestJsonWebSocketClient({
            hangConnect: true,
        });
        const qboxEngine = new InboxOutboxEngine();

        const initPromise = initialiseWsEngine(
            qboxEngine,
            socket.asJsonWebSocketClient(),
            testClientInfo(),
            toResilienceDto(),
        );
        await Promise.resolve();

        await vi.advanceTimersByTimeAsync(9_999);
        expect(socket.connectCalls[0].signal?.aborted).toBe(false);

        const rejected = expect(initPromise).rejects.toBeInstanceOf(CommandTimedOutError);
        await vi.advanceTimersByTimeAsync(1);

        await rejected;
        expect(socket.connectCalls[0].signal?.aborted).toBe(true);
    });

    it('enables websocket callbacks only after the initial connect succeeds', async () => {
        const socket = new TestJsonWebSocketClient({
            hangConnect: true,
        });
        const qboxEngine = new InboxOutboxEngine();

        const initPromise = initialiseWsEngine(
            qboxEngine,
            socket.asJsonWebSocketClient(),
            testClientInfo(),
            toResilienceDto(),
            {
                connectTimeoutMs: 0,
            },
        );
        await Promise.resolve();

        expect(socket.connectCalls).toHaveLength(1);
        expect(socket.webSocketCallbackIds).toEqual([]);
        expect(socket.messageCallbackIds).toEqual([]);

        socket.resolveConnect();
        await initPromise;

        expect(socket.webSocketCallbackIds).toEqual(['session-1']);
        expect(socket.messageCallbackIds).toEqual(['session-1-inbox']);
    });

    it('allows unbounded connect when connectTimeoutMs is zero or negative', async () => {
        vi.useFakeTimers();
        const socket = new TestJsonWebSocketClient({
            hangConnect: true,
        });
        const qboxEngine = new InboxOutboxEngine();

        const initPromise = initialiseWsEngine(
            qboxEngine,
            socket.asJsonWebSocketClient(),
            testClientInfo(),
            toResilienceDto(),
            {
                connectTimeoutMs: 0,
            },
        );
        await Promise.resolve();

        expect(socket.connectCalls).toHaveLength(1);
        expect(socket.connectCalls[0].signal).toBeUndefined();

        await vi.advanceTimersByTimeAsync(1_000);
        expect(socket.connectCalls[0].signal).toBeUndefined();

        socket.resolveConnect();
        await expect(initPromise).resolves.toMatchObject({
            input: {
                sessionId: 'session-1',
            },
        });
    });
});

type TestJsonWebSocketClientOptions = Readonly<{
    hangConnect?: boolean;
}>;

type ConnectCall = Readonly<{
    signal?: AbortSignal;
}>;

class TestJsonWebSocketClient {
    readonly connectCalls: ConnectCall[] = [];
    readonly webSocketCallbackIds: string[] = [];
    readonly messageCallbackIds: string[] = [];
    readonly url = 'ws://test';
    readonly ws = {
        readyState: 1,
    };

    private resolvePendingConnect: (() => void) | undefined;

    constructor(private readonly options: TestJsonWebSocketClientOptions = {}) {
    }

    connect(options: WebSocketConnectOptions = {}): Promise<void> {
        this.connectCalls.push({
            signal: options.signal,
        });
        if (!this.options.hangConnect) {
            return Promise.resolve();
        }

        return new Promise<void>((resolve) => {
            this.resolvePendingConnect = resolve;
        });
    }

    resolveConnect(): void {
        this.resolvePendingConnect?.();
    }

    onWebsocketCallbacksDo(id: string): this {
        this.webSocketCallbackIds.push(id);
        return this;
    }

    onWebSocketMessageDo(id: string): this {
        this.messageCallbackIds.push(id);
        return this;
    }

    sendAsJsonString(): void {
    }

    asJsonWebSocketClient() {
        return this as never;
    }
}

function testClientInfo(): ClientInfo {
    configureBrowserALRuntimeStores('session-1');

    return {
        clientId: 'client-1',
        sessionId: 'session-1',
        isOnline: true,
    };
}
