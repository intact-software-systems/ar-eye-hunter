import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
    RallarBlackBoxBrowserRallarEvent,
    RallarBlackBoxBrowserRallarRuntime,
    RallarBlackBoxBrowserTestRuntime
} from '../../shared-test/rallar-bb-test/browser-adapter.ts';
import {
    createBrowserWebSocketFactory,
    createSpaBrowserRallarRuntime,
    installSpaBrowserRallarEventBridge
} from '../../shared-test/rallar-bb-test/browser-rallar-runtime-bridge.ts';
import { SimulatedWebSocket } from '../shared/native-websocket-fixture.ts';

describe('browser Rallar runtime bridge', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('delegates SPA browser Rallar runtime calls to the window runtime', async () => {
        const refreshRoom = vi.fn(async (input) => ({ action: 'refreshRoom', input }));
        const runtime: RallarBlackBoxBrowserRallarRuntime = {
            authenticate: vi.fn(async (input) => ({ action: 'authenticate', input })),
            connect: vi.fn(async (input) => ({ action: 'connect', input })),
            send: vi.fn(async (input) => ({ action: 'send', input })),
            sendWs: vi.fn(async (input) => ({ action: 'sendWs', input })),
            refreshRoom,
            director: {
                appoint: vi.fn(async (input) => ({ action: 'appoint', input })),
                resign: vi.fn(async (input) => ({ action: 'resign', input })),
                status: vi.fn(async (input) => ({ action: 'status', input })),
                relayStart: vi.fn(async (input) => ({ action: 'relayStart', input })),
                intent: vi.fn(async (input) => ({ action: 'intent', input })),
                syncRequest: vi.fn(async (input) => ({ action: 'syncRequest', input })),
                relayStop: vi.fn(async (input) => ({ action: 'relayStop', input }))
            },
            close: vi.fn(async () => ({ action: 'close' })),
            health: vi.fn(async (input) => ({ action: 'health', input }))
        };
        vi.stubGlobal('window', {
            __blackBoxRallar: runtime
        });
        const bridge = createSpaBrowserRallarRuntime();
        const refreshController = new AbortController();
        const connectInput = {
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'room-1',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                applicationId: 'app-1'
            }
        };

        await expect(bridge.authenticate?.(connectInput)).resolves.toEqual({
            action: 'authenticate',
            input: connectInput
        });
        await expect(bridge.connect(connectInput)).resolves.toEqual({
            action: 'connect',
            input: connectInput
        });
        await expect(bridge.send({ connection: 'aliceRtc', send: { text: 'hello' } }))
            .resolves.toMatchObject({ action: 'send' });
        await expect(bridge.sendWs?.({ connection: 'ws', data: { text: 'hello' } }))
            .resolves.toMatchObject({ action: 'sendWs' });
        await expect(bridge.refreshRoom({
            signal: refreshController.signal,
            timeoutMs: 321
        })).resolves.toMatchObject({ action: 'refreshRoom' });
        await expect(bridge.director?.appoint({ roomId: 'room-1', principalId: 'alice' }))
            .resolves.toMatchObject({ action: 'appoint' });
        await expect(bridge.director?.relayStop({ relayId: 'relay-1' }))
            .resolves.toMatchObject({ action: 'relayStop' });
        await expect(bridge.health({ connection: 'aliceRtc' }))
            .resolves.toEqual({
                action: 'health',
                input: {
                    includeRtcDiagnostics: false
                }
            });
        await expect(bridge.close()).resolves.toEqual({ action: 'close' });

        expect(runtime.authenticate).toHaveBeenCalledWith(connectInput);
        expect(runtime.connect).toHaveBeenCalledWith(connectInput);
        expect(runtime.send).toHaveBeenCalledWith({
            connection: 'aliceRtc',
            send: {
                text: 'hello'
            }
        });
        expect(refreshRoom).toHaveBeenCalledWith({
            signal: refreshController.signal,
            timeoutMs: 321
        });
        expect(runtime.director?.appoint).toHaveBeenCalledWith({
            roomId: 'room-1',
            principalId: 'alice'
        });
    });

    it('rejects missing authentication capability without starting a full connection', async () => {
        const runtime: RallarBlackBoxBrowserRallarRuntime = {
            connect: vi.fn(async (input) => ({ action: 'connect', input })),
            send: vi.fn(async (input) => ({ action: 'send', input })),
            refreshRoom: vi.fn(async () => ({ action: 'refreshRoom' })),
            close: vi.fn(async () => ({ action: 'close' })),
            health: vi.fn(async () => ({ action: 'health' }))
        };
        vi.stubGlobal('window', {
            __blackBoxRallar: runtime
        });
        const bridge = createSpaBrowserRallarRuntime();
        const input = {
            connection: 'legacy',
            rallar: {
                apiBaseUrl: 'https://api.example.test'
            }
        };

        await expect(bridge.authenticate?.(input)).rejects.toThrow('authenticate');
        expect(runtime.connect).not.toHaveBeenCalled();
    });

    it('validates connection configuration before calling the native runtime', async () => {
        const connect = vi.fn(async (input) => input);
        vi.stubGlobal('window', { __blackBoxRallar: { connect } });
        const bridge = createSpaBrowserRallarRuntime();
        const input = {
            connection: 'alice',
            roomRef: { applicationId: 'app', workspaceId: 'space', groupId: 'room' },
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                transport: 'messages.rtc',
                messageSelector: { topicId: 'topic', typeId: 'message' },
                register: 'if-needed',
                dataChannelLanes: [{
                    id: 'reliable',
                    label: '',
                    init: { ordered: false, protocol: '' },
                    flowControl: { maxQueueItems: 20 }
                }],
                logoutOnClose: false
            }
        };
        await expect(bridge.connect(input)).resolves.toEqual(input);
        const forwarded = connect.mock.calls[0][0];
        expect(Object.keys(forwarded.rallar.dataChannelLanes[0].flowControl)).toEqual(['maxQueueItems']);

        for (
            const rallar of [
                { apiBaseUrl: 42 },
                { apiBaseUrl: input.rallar.apiBaseUrl, transport: 'unsupported' },
                { apiBaseUrl: input.rallar.apiBaseUrl, timeoutMs: Number.NaN },
                { apiBaseUrl: input.rallar.apiBaseUrl, peerIds: [4] },
                { apiBaseUrl: input.rallar.apiBaseUrl, dataChannelLanes: [{ id: 'lane', label: 1 }] }
            ]
        ) {
            await expect(bridge.connect({ ...input, rallar })).rejects.toThrow(TypeError);
        }
        await expect(bridge.connect({ ...input, roomRef: { groupId: 'unscoped' } })).rejects.toThrow('applicationId');
        expect(connect).toHaveBeenCalledTimes(1);
    });

    it('installs and restores the SPA browser event bridge', async () => {
        const previousEmitter = vi.fn();
        const fakeWindow: {
            __blackBoxRallarEmit?: (event: RallarBlackBoxBrowserRallarEvent) => void | Promise<void>;
        } = {
            __blackBoxRallarEmit: previousEmitter
        };
        const runtime: Pick<RallarBlackBoxBrowserTestRuntime, 'receiveRallarBrowserEvent'> = {
            receiveRallarBrowserEvent: vi.fn()
        };
        vi.stubGlobal('window', fakeWindow);

        const restore = installSpaBrowserRallarEventBridge(runtime);
        await fakeWindow.__blackBoxRallarEmit?.({
            kind: 'message',
            topic: 'rallar.test.message',
            connection: 'aliceRtc'
        });

        expect(runtime.receiveRallarBrowserEvent).toHaveBeenCalledWith({
            kind: 'message',
            topic: 'rallar.test.message',
            connection: 'aliceRtc'
        });

        restore();
        expect(fakeWindow.__blackBoxRallarEmit).toBe(previousEmitter);
    });

    it('connects native WebSocket effects and removes event listeners through the bridge', async () => {
        const constructed: Array<{ readonly socket: SimulatedWebSocket; readonly protocols: string | string[] | undefined; }> = [];
        const binarySends: Uint8Array[] = [];
        class NativeBridgeSocket extends SimulatedWebSocket {
            constructor(url: string, protocols?: string | string[]) {
                super(url);
                constructed.push({ socket: this, protocols });
            }
            override send(data: Parameters<WebSocket['send']>[0]): void {
                if (this.readyState === WebSocket.OPEN && ArrayBuffer.isView(data)) {
                    binarySends.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
                    return;
                }
                super.send(data);
            }
        }
        vi.stubGlobal('WebSocket', NativeBridgeSocket);
        const socket = createBrowserWebSocketFactory()('wss://control.example.test/agent', ['control.v1']);
        const native = constructed[0].socket;
        expect(constructed[0].protocols).toEqual(['control.v1']);
        expect(socket.url).toBe('wss://control.example.test/agent');
        const received: string[] = [];
        const receive = (event: unknown) => {
            if (!(event instanceof MessageEvent) || typeof event.data !== 'string') {
                throw new TypeError('Expected a native text message');
            }
            received.push(event.data);
        };
        socket.addEventListener?.('message', receive);
        await native.open();
        expect(socket.readyState).toBe(WebSocket.OPEN);
        socket.send('outgoing');
        expect(native.sent).toEqual(['outgoing']);
        socket.send(new Uint8Array([0, 1, 2, 3]).subarray(1, 3));
        expect(binarySends).toEqual([new Uint8Array([1, 2])]);
        await native.receive('incoming');
        socket.removeEventListener?.('message', receive);
        await native.receive('after unsubscribe');
        expect(received).toEqual(['incoming']);
        expect(() => socket.send({ arbitrary: 'object' })).toThrow('WebSocket data');
        socket.close(1000, 'done');
        expect(native.closedWith).toEqual({ code: 1000, reason: 'done' });
        expect(socket.readyState).toBe(WebSocket.CLOSED);
    });
});
