import type { BlackBoxRallarHealthInput } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createBrowserWebSocketFactory,
    createSpaBrowserRallarRuntime,
    installSpaBrowserRallarEventBridge
} from '../../shared-test/rallar-bb-test/browser-rallar-runtime-bridge.ts';
import type {
    RallarBlackBoxBrowserRallarEvent,
    RallarBlackBoxBrowserTestRuntime
} from '../../shared-test/rallar-bb-test/browser/browser-command-contracts.ts';
import { SimulatedWebSocket } from '../shared/native-websocket-fixture.ts';

describe('browser Rallar runtime bridge', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('normalizes the optional health diagnostics request at the page boundary', async () => {
        vi.stubGlobal('window', { __blackBoxRallar: { health: async (input: BlackBoxRallarHealthInput) => input } });
        const bridge = createSpaBrowserRallarRuntime();
        expect(await bridge.health({ connection: 'aliceRtc' })).toEqual({ includeRtcDiagnostics: false });
        expect(await bridge.health({ includeRtcDiagnostics: true })).toEqual({ includeRtcDiagnostics: true });
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
        socket.close(1000, 'done');
        expect(native.closedWith).toEqual({ code: 1000, reason: 'done' });
        expect(socket.readyState).toBe(WebSocket.CLOSED);
    });
});
