import { describe, expect, it, vi } from 'vitest';
import { RallarValidationError } from '../../../packages/shared/api/rallar-validation.ts';
import { ApiHttpError } from '../../../packages/shared-web/browser/api/http-error.ts';
import {
    createRallarBlackBoxBrowserTestRuntime,
    type RallarBlackBoxBrowserRoomRefreshOptions,
} from '../../../packages/shared-test/rallar-bb-test/browser-adapter.ts';
import { selectRallarBlackBoxDiagnostics } from '../../../packages/shared-test/rallar-bb-test/selectors.ts';
import {
    createSpaBrowserRallarRuntime,
    installSpaBrowserRallarEventBridge,
} from '../../../apps/rallar-black-box/src/browser-rallar-runtime.ts';

async function withFakeWindow<T>(
    value: Record<string, unknown>,
    run: () => T | Promise<T>,
): Promise<T> {
    vi.stubGlobal('window', value);
    try {
        return await run();
    } finally {
        vi.unstubAllGlobals();
    }
}

describe('rallar-black-box SPA browser-rallar runtime', () => {
    it('proxies runtime calls to window.__blackBoxRallar', async () => {
        const calls: string[] = [];
        const healthInputs: unknown[] = [];
        await withFakeWindow({
            __blackBoxRallar: {
                connect: async () => {
                    calls.push('connect');
                    return { connected: true };
                },
                send: async () => {
                    calls.push('send');
                    return { sent: true };
                },
                sendWs: async () => {
                    calls.push('sendWs');
                    return { wsSent: true };
                },
                director: {
                    appoint: async () => {
                        calls.push('director.appoint');
                        return { status: 'appointed' };
                    },
                    resign: async () => {
                        calls.push('director.resign');
                        return { status: 'resigned' };
                    },
                    status: async () => {
                        calls.push('director.status');
                        return { status: 'status' };
                    },
                    relayStart: async () => {
                        calls.push('director.relayStart');
                        return { status: 'relay_started' };
                    },
                    intent: async () => {
                        calls.push('director.intent');
                        return { status: 'intent_sent' };
                    },
                    syncRequest: async () => {
                        calls.push('director.syncRequest');
                        return { status: 'sync_requested' };
                    },
                    relayStop: async () => {
                        calls.push('director.relayStop');
                        return { status: 'relay_stopped' };
                    },
                },
                close: async () => {
                    calls.push('close');
                    return { closed: true };
                },
                health: async (input?: unknown) => {
                    healthInputs.push(input);
                    calls.push('health');
                    return { connected: true };
                },
            },
        }, async () => {
            const runtime = createSpaBrowserRallarRuntime();

            await runtime.connect({ connection: 'aliceRtc', rallar: {} });
            await runtime.send({ data: { text: 'hello' } });
            await runtime.sendWs?.({ typeId: 'room.manual.message', payload: { text: 'hello ws' } });
            await runtime.director?.appoint({ roomId: 'room-1' });
            await runtime.director?.status({ roomId: 'room-1' });
            await runtime.director?.relayStart({
                handle: 'relay-1',
                intentTypeId: 'intent',
                outputTypeId: 'output',
            });
            await runtime.director?.intent({ handle: 'relay-1', intent: { intentId: 'intent-1' } });
            await runtime.director?.syncRequest({ handle: 'relay-1' });
            await runtime.director?.relayStop({ handle: 'relay-1' });
            await runtime.director?.resign({ roomId: 'room-1' });
            await runtime.health({ includeRtcDiagnostics: true });
            await runtime.close();
        });

        expect(calls).toEqual([
            'connect',
            'send',
            'sendWs',
            'director.appoint',
            'director.status',
            'director.relayStart',
            'director.intent',
            'director.syncRequest',
            'director.relayStop',
            'director.resign',
            'health',
            'close',
        ]);
        expect(healthInputs).toEqual([{ includeRtcDiagnostics: true }]);
    });

    it('bridges browser Rallar events into the shared runtime', async () => {
        await withFakeWindow({
            __blackBoxRallar: {
                connect: async () => {
                    const target = globalThis.window as {
                        __blackBoxRallarEmit?: (event: unknown) => void;
                    };
                    target.__blackBoxRallarEmit?.({
                        kind: 'diagnostic',
                        topic: 'rallar.browser.connect.phase_completed',
                        connection: 'aliceRtc',
                        actor: 'alice',
                        transport: 'realtime',
                        data: {
                            phase: 'rallar-connect',
                        },
                    });
                    return { connected: true };
                },
                send: vi.fn(),
                close: vi.fn(),
                health: vi.fn(),
            },
        }, async () => {
            const runtime = createRallarBlackBoxBrowserTestRuntime({
                rallarRuntime: createSpaBrowserRallarRuntime(),
            });
            installSpaBrowserRallarEventBridge(runtime);

            await runtime.execute({
                kind: 'configure',
                commandId: 'configure-browser-rallar',
                config: {
                    apiBaseUrl: 'https://api.example.test',
                    actor: 'alice',
                    sessionId: 'alice-session',
                    roomId: 'room-1',
                    transport: 'realtime',
                    rallar: {
                        username: 'alice',
                        password: 'secret',
                    },
                    control: {
                        providerMode: 'browser-rallar',
                    },
                },
            });
            const result = await runtime.execute({
                kind: 'rtc.connect',
                commandId: 'connect-browser-rallar',
                connection: 'aliceRtc',
            });

            expect(result.ok).toBe(true);
            expect(selectRallarBlackBoxDiagnostics(runtime.state()).some(event =>
                event.topic === 'rallar.browser.connect.phase_completed' &&
                event.connection === 'aliceRtc'
            )).toBe(true);
        });
    });

    it('maps shared connect and send commands to the browser Rallar runtime', async () => {
        const connect = vi.fn(async () => ({
            connected: true,
            connection: 'realRtc',
            transport: 'realtime',
            roomId: 'room-1',
        }));
        const send = vi.fn(async () => ({
            status: 'sent',
            transport: 'realtime',
            roomId: 'room-1',
        }));

        await withFakeWindow({
            __blackBoxRallar: {
                connect,
                send,
                close: vi.fn(),
                health: vi.fn(),
            },
        }, async () => {
            const runtime = createRallarBlackBoxBrowserTestRuntime({
                rallarRuntime: createSpaBrowserRallarRuntime(),
            });

            await runtime.execute({
                kind: 'configure',
                commandId: 'configure-real-command-path',
                config: {
                    apiBaseUrl: 'https://api.example.test',
                    actor: 'alice',
                    sessionId: 'alice-session',
                    roomId: 'room-1',
                    transport: 'realtime',
                    rallar: {
                        username: 'alice',
                        password: 'secret',
                        transport: 'realtime',
                    },
                    control: {
                        providerMode: 'browser-rallar',
                    },
                },
            });
            const connectResult = await runtime.execute({
                kind: 'rtc.connect',
                commandId: 'connect-real-command-path',
                connection: 'realRtc',
            });
            const sendResult = await runtime.execute({
                kind: 'rtc.send',
                commandId: 'send-real-command-path',
                connection: 'realRtc',
                transport: 'realtime',
                send: {
                    roomId: 'room-1',
                    peerIds: ['bob-session'],
                    data: {
                        text: 'hello',
                    },
                },
            });

            expect(connectResult.ok).toBe(true);
            expect(sendResult.ok).toBe(true);
            expect(connect).toHaveBeenCalledWith({
                connection: 'realRtc',
                actor: 'alice',
                roomId: 'room-1',
                rallar: {
                    apiBaseUrl: 'https://api.example.test',
                    username: 'alice',
                    password: 'secret',
                    transport: 'realtime',
                    expectedSessionId: 'alice-session',
                },
            });
            expect(send).toHaveBeenCalledWith({
                roomId: 'room-1',
                peerIds: ['bob-session'],
                data: {
                    text: 'hello',
                },
            });
            expect(selectRallarBlackBoxDiagnostics(runtime.state()).some(event =>
                event.topic === 'rallar.bb.rtc.send_completed' &&
                event.commandId === 'send-real-command-path'
            )).toBe(true);
        });
    });

    it('waits for rtc.connect readiness before reporting success', async () => {
        const health = vi.fn()
            .mockResolvedValueOnce({
                rtcStatus: {
                    readyPeerIds: [],
                },
            })
            .mockResolvedValueOnce({
                rtcStatus: {
                    readyPeerIds: ['peer-a', 'peer-b'],
                },
            });
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                connect: vi.fn(async () => ({
                    connected: true,
                    rtcStatus: {
                        readyPeerIds: [],
                    },
                })),
                send: vi.fn(),
                refreshRoom: vi.fn(),
                close: vi.fn(),
                health,
            },
        });

        const result = await runtime.execute({
            kind: 'rtc.connect',
            commandId: 'connect-ready-peers',
            connection: 'rtc',
            readiness: {
                minReadyPeers: 2,
                timeoutMs: 50,
                intervalMs: 1,
            },
        });

        expect(result.ok).toBe(true);
        expect(health).toHaveBeenCalledTimes(2);
        expect(result.value).toMatchObject({
            readiness: {
                readyPeerIds: ['peer-a', 'peer-b'],
                minReadyPeers: 2,
            },
        });
        expect(selectRallarBlackBoxDiagnostics(runtime.state()).map(event => event.topic)).toEqual(expect.arrayContaining([
            'rallar.bb.rtc.readiness_wait_started',
            'rallar.bb.rtc.readiness_ready',
            'rallar.bb.rtc.connected',
        ]));
    });

    it('does not refresh room state when rtc.connect is already ready', async () => {
        const refreshRoom = vi.fn();
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                connect: vi.fn(async () => ({ connected: true })),
                send: vi.fn(),
                close: vi.fn(),
                health: vi.fn(async () => ({
                    rtcStatus: {
                        readyPeerIds: ['peer-a'],
                    },
                })),
                refreshRoom,
            },
        });

        const result = await runtime.execute({
            kind: 'rtc.connect',
            commandId: 'connect-already-ready',
            connection: 'rtc',
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 50,
                intervalMs: 1,
            },
        });

        expect(result.ok).toBe(true);
        expect(refreshRoom).not.toHaveBeenCalled();
        expect(result.value).toMatchObject({
            readiness: {
                roomRefreshAttempts: 0,
                roomRefreshSuccesses: 0,
                roomRefreshRetryableFailures: 0,
            },
        });
    });

    it('refreshes room state while waiting for an initially undiscovered RTC peer', async () => {
        let roomStateRefreshed = false;
        const refreshRoom = vi.fn(async (_options: RallarBlackBoxBrowserRoomRefreshOptions) => {
            roomStateRefreshed = true;
        });
        const health = vi.fn(async () => ({
            rtcStatus: {
                readyPeerIds: roomStateRefreshed ? ['peer-a'] : [],
            },
        }));
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                connect: vi.fn(async () => ({
                    connected: true,
                    rtcStatus: {
                        readyPeerIds: [],
                    },
                })),
                send: vi.fn(),
                close: vi.fn(),
                health,
                refreshRoom,
            },
        });

        const result = await runtime.execute({
            kind: 'rtc.connect',
            commandId: 'connect-after-room-refresh',
            connection: 'rtc',
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 50,
                intervalMs: 1,
            },
        });

        expect(result.ok).toBe(true);
        expect(refreshRoom).toHaveBeenCalledTimes(1);
        expect(refreshRoom).toHaveBeenCalledWith({
            signal: expect.any(AbortSignal),
            timeoutMs: expect.any(Number),
        });
        const refreshOptions = refreshRoom.mock.calls[0]?.[0];
        expect(refreshOptions?.timeoutMs).toBeGreaterThan(0);
        expect(refreshOptions?.timeoutMs).toBeLessThanOrEqual(50);
        expect(health).toHaveBeenCalledTimes(2);
        expect(result.value).toMatchObject({
            readiness: {
                readyPeerIds: ['peer-a'],
                roomRefreshAttempts: 1,
                roomRefreshSuccesses: 1,
                roomRefreshRetryableFailures: 0,
            },
        });
    });

    it('does not let a pending room refresh overrun rtc.connect readiness', async () => {
        vi.useFakeTimers();
        try {
            const refreshRoom = vi.fn((_options: Readonly<{
                signal?: AbortSignal;
                timeoutMs: number;
            }>) => new Promise<unknown>(() => undefined));
            const runtime = createRallarBlackBoxBrowserTestRuntime({
                rallarRuntime: {
                    connect: vi.fn(async () => ({ connected: true })),
                    send: vi.fn(),
                    close: vi.fn(),
                    health: vi.fn(async () => ({
                        rtcStatus: {
                            readyPeerIds: [],
                        },
                    })),
                    refreshRoom,
                },
            });

            const pending = runtime.execute({
                kind: 'rtc.connect',
                commandId: 'connect-pending-room-refresh',
                connection: 'rtc',
                readiness: {
                    minReadyPeers: 1,
                    timeoutMs: 10,
                    intervalMs: 1,
                },
            });
            await vi.advanceTimersByTimeAsync(0);

            expect(refreshRoom).toHaveBeenCalledTimes(1);
            const signal = refreshRoom.mock.calls[0]?.[0].signal;
            expect(signal?.aborted).toBe(false);

            await vi.advanceTimersByTimeAsync(10);
            const result = await pending;

            expect(result.ok).toBe(false);
            expect(result.error).toMatchObject({
                code: 'RALLAR_BB_RTC_READY_TIMEOUT',
            });
            expect(result.value).toMatchObject({
                readiness: {
                    roomRefreshAttempts: 1,
                    roomRefreshSuccesses: 0,
                    roomRefreshRetryableFailures: 0,
                },
            });
            expect(signal?.aborted).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('cancels a pending room refresh when distributed execution is cancelled', async () => {
        vi.useFakeTimers();
        try {
            const refreshRoom = vi.fn((_options: Readonly<{
                signal?: AbortSignal;
                timeoutMs: number;
            }>) => new Promise<unknown>(() => undefined));
            const runtime = createRallarBlackBoxBrowserTestRuntime({
                rallarRuntime: {
                    connect: vi.fn(async () => ({ connected: true })),
                    send: vi.fn(),
                    close: vi.fn(),
                    health: vi.fn(async () => ({
                        rtcStatus: {
                            readyPeerIds: [],
                        },
                    })),
                    refreshRoom,
                },
            });

            const pendingConnect = runtime.execute({
                kind: 'rtc.connect',
                commandId: 'connect-cancelled-room-refresh',
                connection: 'rtc',
                readiness: {
                    minReadyPeers: 1,
                    timeoutMs: 10_000,
                    intervalMs: 1,
                },
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(refreshRoom).toHaveBeenCalledTimes(1);
            const signal = refreshRoom.mock.calls[0]?.[0].signal;

            await runtime.execute({
                kind: 'recipe.cancel',
                commandId: 'cancel-pending-room-refresh',
                reason: 'distributed run cancelled',
            });
            const result = await pendingConnect;

            expect(result.status).toBe('cancelled');
            expect(signal?.aborted).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps waiting after a transient room refresh failure', async () => {
        vi.useFakeTimers();
        try {
            const refreshError = new Error('transient point-read failure');
            let roomStateRefreshed = false;
            const refreshRoom = vi.fn()
                .mockRejectedValueOnce(refreshError)
                .mockImplementationOnce(async () => {
                    roomStateRefreshed = true;
                });
            const runtime = createRallarBlackBoxBrowserTestRuntime({
                rallarRuntime: {
                    connect: vi.fn(async () => ({ connected: true })),
                    send: vi.fn(),
                    close: vi.fn(),
                    health: vi.fn(async () => ({
                        rtcStatus: {
                            readyPeerIds: roomStateRefreshed ? ['peer-a'] : [],
                        },
                    })),
                    refreshRoom,
                },
            });

            const pending = runtime.execute({
                kind: 'rtc.connect',
                commandId: 'connect-after-transient-refresh-failure',
                connection: 'rtc',
                readiness: {
                    minReadyPeers: 1,
                    timeoutMs: 1_500,
                    intervalMs: 100,
                },
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(refreshRoom).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(1_000);
            const result = await pending;

            expect(result.ok).toBe(true);
            expect(refreshRoom).toHaveBeenCalledTimes(2);
            expect(result.value).toMatchObject({
                readiness: {
                    readyPeerIds: ['peer-a'],
                    roomRefreshAttempts: 2,
                    roomRefreshSuccesses: 1,
                    roomRefreshRetryableFailures: 1,
                    lastRefreshError: {
                        name: 'Error',
                        message: refreshError.message,
                    },
                },
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([
        [
            'HTTP authorization',
            new ApiHttpError(
                'GET',
                '/api/state/rooms/example',
                403,
                'room refresh forbidden',
            ),
        ],
        [
            'configuration validation',
            new RallarValidationError('$.roomRef: Exact room reference is required.', [
                {
                    path: '$.roomRef',
                    code: 'room-ref-required',
                    message: 'Exact room reference is required.',
                },
            ]),
        ],
    ])('fails rtc.connect immediately after a permanent %s refresh failure', async (_label, refreshError) => {
        vi.useFakeTimers();
        try {
            const refreshRoom = vi.fn().mockRejectedValue(refreshError);
            const runtime = createRallarBlackBoxBrowserTestRuntime({
                rallarRuntime: {
                    connect: vi.fn(async () => ({ connected: true })),
                    send: vi.fn(),
                    close: vi.fn(),
                    health: vi.fn(async () => ({
                        rtcStatus: {
                            readyPeerIds: [],
                        },
                    })),
                    refreshRoom,
                },
            });

            const pending = runtime.execute({
                kind: 'rtc.connect',
                commandId: `connect-after-${refreshError.name}`,
                connection: 'rtc',
                readiness: {
                    minReadyPeers: 1,
                    timeoutMs: 25,
                    intervalMs: 1,
                },
            });
            await vi.advanceTimersByTimeAsync(25);
            const result = await pending;

            expect(result.ok).toBe(false);
            expect(result.error).toMatchObject({
                code: 'RALLAR_BLACK_BOX_COMMAND_FAILED',
                message: refreshError.message,
                details: {
                    name: refreshError.name,
                },
            });
            expect(refreshRoom).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('uses the readiness timeout window after rtc.connect completes', async () => {
        const health = vi.fn()
            .mockResolvedValueOnce({
                rtcStatus: {
                    readyPeerIds: [],
                },
            })
            .mockResolvedValueOnce({
                rtcStatus: {
                    readyPeerIds: ['peer-a'],
                },
            });
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                connect: vi.fn(async () => ({
                    connected: true,
                    rtcStatus: {
                        readyPeerIds: [],
                    },
                })),
                send: vi.fn(),
                refreshRoom: vi.fn(),
                close: vi.fn(),
                health,
            },
        });

        const result = await runtime.execute({
            kind: 'rtc.connect',
            commandId: 'connect-ready-after-command-timeout',
            connection: 'rtc',
            timeoutMs: 1,
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 50,
                intervalMs: 5,
            },
        });

        expect(result.ok).toBe(true);
        expect(health).toHaveBeenCalledTimes(2);
        expect(result.value).toMatchObject({
            readiness: {
                ready: true,
                readyPeerIds: ['peer-a'],
                minReadyPeers: 1,
            },
        });
    });

    it('fails rtc.connect when readiness times out', async () => {
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                connect: vi.fn(async () => ({
                    connected: true,
                    rtcStatus: {
                        readyPeerIds: [],
                    },
                })),
                send: vi.fn(),
                refreshRoom: vi.fn(),
                close: vi.fn(),
                health: vi.fn(async () => ({
                    rtcStatus: {
                        readyPeerIds: [],
                    },
                })),
            },
        });

        const result = await runtime.execute({
            kind: 'rtc.connect',
            commandId: 'connect-ready-timeout',
            connection: 'rtc',
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 5,
                intervalMs: 1,
            },
        });

        expect(result.ok).toBe(false);
        expect(result.error).toMatchObject({
            code: 'RALLAR_BB_RTC_READY_TIMEOUT',
            message: 'RTC connect timed out waiting for ready peers.',
        });
        expect(selectRallarBlackBoxDiagnostics(runtime.state()).some(event =>
            event.topic === 'rallar.bb.rtc.readiness_timeout' &&
            event.commandId === 'connect-ready-timeout' &&
            event.severity === 'error'
        )).toBe(true);
    });

    it('fails realtime send commands when the browser runtime resolves no peers', async () => {
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                connect: vi.fn(async () => ({ connected: true })),
                send: vi.fn(async () => ({
                    status: 'no-peers',
                    transport: 'realtime',
                    roomId: 'awesome',
                    peerIds: [],
                    results: [],
                    health: [],
                })),
                refreshRoom: vi.fn(),
                close: vi.fn(),
                health: vi.fn(),
            },
        });

        const result = await runtime.execute({
            kind: 'rtc.send',
            commandId: 'manual-send-no-peers',
            connection: 'aliceRtc',
            transport: 'realtime',
            send: {
                roomId: 'awesome',
                data: {
                    text: 'hello solo room',
                },
            },
        });

        expect(result.ok).toBe(false);
        expect(result.error).toMatchObject({
            code: 'RALLAR_BB_RTC_NO_PEERS',
            message: 'RTC send resolved no target peers.',
        });
        expect(selectRallarBlackBoxDiagnostics(runtime.state()).some(event =>
            event.topic === 'rallar.bb.rtc.send_failed' &&
            event.commandId === 'manual-send-no-peers' &&
            event.severity === 'error'
        )).toBe(true);
    });

    it('fails messages.rtc send commands when the browser runtime reports no route', async () => {
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                connect: vi.fn(async () => ({ connected: true })),
                send: vi.fn(async () => ({
                    status: 'sent',
                    transport: 'messages.rtc',
                    roomId: 'awesome',
                    message: {
                        status: 'no-route',
                        reason: 'No outbound transport route for message test-msg',
                    },
                    health: [],
                })),
                refreshRoom: vi.fn(),
                close: vi.fn(),
                health: vi.fn(),
            },
        });

        const result = await runtime.execute({
            kind: 'rtc.send',
            commandId: 'manual-send-no-route',
            connection: 'aliceRtc',
            transport: 'messages.rtc',
            send: {
                roomId: 'awesome',
                typeId: 'manual.type',
                topicId: 'manual.topic',
                payload: {
                    text: 'hello solo room',
                },
            },
        });

        expect(result.ok).toBe(false);
        expect(result.error).toMatchObject({
            code: 'RALLAR_BB_RTC_NO_ROUTE',
            message: 'RTC send failed with status no-route: No outbound transport route for message test-msg',
        });
        expect(selectRallarBlackBoxDiagnostics(runtime.state()).some(event =>
            event.topic === 'rallar.bb.rtc.send_failed' &&
            event.commandId === 'manual-send-no-route' &&
            event.severity === 'error'
        )).toBe(true);
    });
});
