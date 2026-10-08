import type {
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarHealthInput
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import {
    AL_VOLATILE_SESSION_MAX_AGE_MS,
    AL_VOLATILE_SESSION_MAX_TRACKS
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createBrowserWebSocketFactory,
    createSpaBrowserRallarRuntime,
    installSpaBrowserRallarEventBridge
} from '../../shared-test/rallar-bb-test/browser-rallar-runtime-bridge.ts';
import type {
    RallarBlackBoxBrowserRallarEvent,
    RallarBlackBoxBrowserTestRuntime,
    RallarBlackBoxBrowserWebSocketEvent
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
                messageTypeIds: ['message', 'other-message'],
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
                { apiBaseUrl: input.rallar.apiBaseUrl, messageTypeIds: ['message', 4] },
                { apiBaseUrl: input.rallar.apiBaseUrl, dataChannelLanes: [{ id: 'lane', label: 1 }] }
            ]
        ) {
            await expect(bridge.connect({ ...input, rallar })).rejects.toThrow(TypeError);
        }
        await expect(bridge.connect({ ...input, roomRef: { groupId: 'unscoped' } })).rejects.toThrow('applicationId');
        expect(connect).toHaveBeenCalledTimes(1);
    });

    it('decodes the lane-only volatile limits of a connect, reading the age and track bounds the connect leaves out as the constants', async () => {
        const forwarded: BlackBoxRallarConnectionConfig[] = [];
        vi.stubGlobal('window', {
            __blackBoxRallar: {
                connect: async (config: BlackBoxRallarConnectionConfig) => {
                    forwarded.push(config);
                    return config;
                }
            }
        });
        const bridge = createSpaBrowserRallarRuntime();
        const input = {
            connection: 'alice',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                almVolatileLimits: { maxAdmissions: 2, maxBytes: 4_096 }
            }
        };
        const lowered = { maxAdmissions: 2, maxBytes: 4_096, maxAgeMs: 60_000, maxTracks: 2 };

        await bridge.connect(input);
        await bridge.connect({ ...input, rallar: { ...input.rallar, almVolatileLimits: lowered } });
        for (
            const almVolatileLimits of [
                { maxAdmissions: 0, maxBytes: 4_096 },
                { maxAdmissions: 2 },
                { maxAdmissions: 2, maxBytes: 1.5 },
                { maxAdmissions: 2, maxBytes: 4_096, maxAgeMs: 0 },
                { maxAdmissions: 2, maxBytes: 4_096, maxTracks: 1.5 },
                { maxAdmissions: 2, maxBytes: 4_096, maxWindowMs: 1 }
            ]
        ) {
            await expect(bridge.connect({ ...input, rallar: { ...input.rallar, almVolatileLimits } }))
                .rejects.toThrow(
                    'rallar.almVolatileLimits must name maxAdmissions and maxBytes and may name maxAgeMs and maxTracks, ' +
                        'each a positive integer.'
                );
        }
        // Only the well-formed limits reached the native runtime.
        expect(forwarded.map((config) => config.rallar.almVolatileLimits)).toEqual([
            {
                maxAdmissions: 2,
                maxBytes: 4_096,
                maxAgeMs: AL_VOLATILE_SESSION_MAX_AGE_MS,
                maxTracks: AL_VOLATILE_SESSION_MAX_TRACKS
            },
            lowered
        ]);
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
        const receive = (event: RallarBlackBoxBrowserWebSocketEvent) => {
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
