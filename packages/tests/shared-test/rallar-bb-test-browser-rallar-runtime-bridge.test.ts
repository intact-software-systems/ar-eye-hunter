import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createBrowserWebSocketFactory,
    createSpaBrowserRallarRuntime,
    installSpaBrowserRallarEventBridge,
} from '../../shared-test/rallar-bb-test/browser-rallar-runtime-bridge.ts';
import type {
    RallarBlackBoxBrowserRallarEvent,
    RallarBlackBoxBrowserRallarRuntime,
    RallarBlackBoxBrowserTestRuntime,
} from '../../shared-test/rallar-bb-test/browser-adapter.ts';

describe('browser Rallar runtime bridge', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('delegates SPA browser Rallar runtime calls to the window runtime', async () => {
        const refreshRoom = vi.fn(async input => ({ action: 'refreshRoom', input }));
        const runtime: RallarBlackBoxBrowserRallarRuntime = {
            authenticate: vi.fn(async input => ({ action: 'authenticate', input })),
            connect: vi.fn(async input => ({ action: 'connect', input })),
            send: vi.fn(async input => ({ action: 'send', input })),
            sendWs: vi.fn(async input => ({ action: 'sendWs', input })),
            refreshRoom,
            director: {
                appoint: vi.fn(async input => ({ action: 'appoint', input })),
                resign: vi.fn(async input => ({ action: 'resign', input })),
                status: vi.fn(async input => ({ action: 'status', input })),
                relayStart: vi.fn(async input => ({ action: 'relayStart', input })),
                intent: vi.fn(async input => ({ action: 'intent', input })),
                syncRequest: vi.fn(async input => ({ action: 'syncRequest', input })),
                relayStop: vi.fn(async input => ({ action: 'relayStop', input })),
            },
            close: vi.fn(async () => ({ action: 'close' })),
            health: vi.fn(async input => ({ action: 'health', input })),
        };
        vi.stubGlobal('window', {
            __blackBoxRallar: runtime,
        });
        const bridge = createSpaBrowserRallarRuntime();
        const refreshController = new AbortController();
        const connectInput = {
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                applicationId: 'app-1',
            },
        };

        await expect(bridge.authenticate?.(connectInput)).resolves.toEqual({
            action: 'authenticate',
            input: connectInput,
        });
        await expect(bridge.connect(connectInput)).resolves.toEqual({
            action: 'connect',
            input: connectInput,
        });
        await expect(bridge.send({ connection: 'aliceRtc', send: { text: 'hello' } }))
            .resolves.toMatchObject({ action: 'send' });
        await expect(bridge.sendWs?.({ connection: 'ws', data: { text: 'hello' } }))
            .resolves.toMatchObject({ action: 'sendWs' });
        await expect(bridge.refreshRoom({
            signal: refreshController.signal,
            timeoutMs: 321,
        })).resolves.toMatchObject({ action: 'refreshRoom' });
        await expect(bridge.director?.appoint({ roomId: 'room-1', principalId: 'alice' }))
            .resolves.toMatchObject({ action: 'appoint' });
        await expect(bridge.director?.relayStop({ relayId: 'relay-1' }))
            .resolves.toMatchObject({ action: 'relayStop' });
        await expect(bridge.health({ connection: 'aliceRtc' }))
            .resolves.toEqual({
                action: 'health',
                input: {
                    connection: 'aliceRtc',
                },
            });
        await expect(bridge.close()).resolves.toEqual({ action: 'close' });

        expect(runtime.authenticate).toHaveBeenCalledWith(connectInput);
        expect(runtime.connect).toHaveBeenCalledWith(connectInput);
        expect(runtime.send).toHaveBeenCalledWith({
            connection: 'aliceRtc',
            send: {
                text: 'hello',
            },
        });
        expect(refreshRoom).toHaveBeenCalledWith({
            signal: refreshController.signal,
            timeoutMs: 321,
        });
        expect(runtime.director?.appoint).toHaveBeenCalledWith({
            roomId: 'room-1',
            principalId: 'alice',
        });
    });

    it('falls back to full connect when an older window runtime cannot authenticate separately', async () => {
        const runtime: RallarBlackBoxBrowserRallarRuntime = {
            connect: vi.fn(async input => ({ action: 'connect', input })),
            send: vi.fn(async input => ({ action: 'send', input })),
            refreshRoom: vi.fn(async () => ({ action: 'refreshRoom' })),
            close: vi.fn(async () => ({ action: 'close' })),
            health: vi.fn(async () => ({ action: 'health' })),
        };
        vi.stubGlobal('window', {
            __blackBoxRallar: runtime,
        });
        const bridge = createSpaBrowserRallarRuntime();
        const input = {
            connection: 'legacy',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
            },
        };

        await expect(bridge.authenticate?.(input)).resolves.toEqual({
            action: 'connect',
            input,
        });
        expect(runtime.connect).toHaveBeenCalledWith(input);
    });

    it('installs and restores the SPA browser event bridge', async () => {
        const previousEmitter = vi.fn();
        const fakeWindow: {
            __blackBoxRallarEmit?: (event: RallarBlackBoxBrowserRallarEvent) => void | Promise<void>;
        } = {
            __blackBoxRallarEmit: previousEmitter,
        };
        const runtime = {
            receiveRallarBrowserEvent: vi.fn(),
        } as unknown as RallarBlackBoxBrowserTestRuntime;
        vi.stubGlobal('window', fakeWindow);

        const restore = installSpaBrowserRallarEventBridge(runtime);
        await fakeWindow.__blackBoxRallarEmit?.({
            kind: 'message',
            topic: 'rallar.test.message',
            connection: 'aliceRtc',
        });

        expect(runtime.receiveRallarBrowserEvent).toHaveBeenCalledWith({
            kind: 'message',
            topic: 'rallar.test.message',
            connection: 'aliceRtc',
        });

        restore();
        expect(fakeWindow.__blackBoxRallarEmit).toBe(previousEmitter);
    });

    it('creates browser WebSockets through the global constructor', () => {
        class FakeWebSocket {
            readonly url: string;
            readonly protocols?: string | readonly string[];

            constructor(url: string, protocols?: string | readonly string[]) {
                this.url = url;
                this.protocols = protocols;
            }

            send(): void {}

            close(): void {}
        }

        vi.stubGlobal('WebSocket', FakeWebSocket);

        const socket = createBrowserWebSocketFactory()(
            'wss://control.example.test/agent',
            ['control.v1'],
        ) as FakeWebSocket;

        expect(socket).toBeInstanceOf(FakeWebSocket);
        expect(socket.url).toBe('wss://control.example.test/agent');
        expect(socket.protocols).toEqual(['control.v1']);
    });
});
