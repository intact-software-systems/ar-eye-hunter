import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { BlackBoxRallarRuntime } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts';
import {
    createBlackBoxRallarRuntime,
    type BlackBoxRallarRuntimeInstallationTarget
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime.ts';

import { createSpaBrowserRallarRuntime, installSpaBrowserRallarEventBridge } from '../../../apps/rallar-black-box/src/browser-rallar-runtime.ts';
import {
    createRallarBlackBoxBrowserTestRuntime,
    type RallarBlackBoxBrowserRoomRefreshOptions
} from '../../../packages/shared-test/rallar-bb-test/browser-adapter.ts';
import { selectRallarBlackBoxDiagnostics } from '../../../packages/shared-test/rallar-bb-test/selectors.ts';
import { ApiHttpError } from '../../../packages/shared-web/browser/api/http-error.ts';
import { RallarValidationError } from '../../../packages/shared/api/rallar-validation.ts';

import { facade, resetFacade } from '../shared-test/rallar-browser-runtime/browser-rallar-runtime-test-harness.ts';

async function withBrowserRuntime(
    run: (nativeRuntime: BlackBoxRallarRuntime) => Promise<void>
): Promise<void> {
    resetFacade();
    const targetWindow: BlackBoxRallarRuntimeInstallationTarget = {};
    const nativeRuntime = createBlackBoxRallarRuntime({
        facade: facade.rallar,
        targetWindow,
        clock: { now: Date.now },
        delay: async () => undefined
    });
    targetWindow.__blackBoxRallar = nativeRuntime;
    vi.stubGlobal('window', targetWindow);
    try {
        await run(nativeRuntime);
    }
    finally {
        try {
            await nativeRuntime.close();
        }
        finally {
            vi.restoreAllMocks();
            vi.unstubAllGlobals();
        }
    }
}

describe('rallar-black-box SPA browser-rallar runtime', () => {
    it('returns browser runtime results through the SPA bridge', async () => {
        await withBrowserRuntime(async () => {
            facade.behavior.realtimeSend.mockResolvedValue([{
                peerId: 'bob-session',
                laneId: 'realtime',
                result: { status: 'sent', bufferedAmount: 0 }
            }]);
            const runtime = createSpaBrowserRallarRuntime();
            await expect(runtime.connect({
                connection: 'aliceRtc',
                roomId: 'room-1',
                rallar: {
                    apiBaseUrl: 'https://api.example.test',
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    username: 'alice',
                    password: 'secret'
                }
            })).resolves.toMatchObject({
                status: 'connected',
                connection: 'aliceRtc',
                sessionId: facade.session.sessionId
            });
            await expect(runtime.send({ peerIds: ['bob-session'], data: { text: 'hello' } }))
                .resolves.toMatchObject({ status: 'sent', peerIds: ['bob-session'] });
            await expect(runtime.sendWs?.({ typeId: 'room.manual.message', payload: { text: 'hello ws' } }))
                .resolves.toMatchObject({ status: 'sent', transport: 'ws', typeId: 'room.manual.message' });
            await expect(runtime.refreshRoom({ timeoutMs: 100 })).resolves.toBeUndefined();
            expect(facade.records.roomStateRefreshes).toContainEqual([
                { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' },
                { timeoutMs: 100, scope: { applicationId: 'app-1', workspaceId: 'workspace-1' } }
            ]);
            await expect(runtime.health({ includeRtcDiagnostics: true })).resolves.toMatchObject({
                connected: true,
                rtcDiagnostics: { sessionId: facade.session.sessionId, peerCount: 1 }
            });
            await expect(runtime.close()).resolves.toMatchObject({ status: 'closed', disconnected: true, cleanupErrors: [] });
        });
    });

    it('returns director operation diagnostics through the SPA bridge', async () => {
        await withBrowserRuntime(async (nativeRuntime) => {
            vi.spyOn(nativeRuntime.director, 'appoint').mockResolvedValue({ status: 'appointed' });
            vi.spyOn(nativeRuntime.director, 'resign').mockResolvedValue({ status: 'resigned' });
            vi.spyOn(nativeRuntime.director, 'status').mockResolvedValue({ status: 'status' });
            vi.spyOn(nativeRuntime.director, 'relayStart').mockResolvedValue({ status: 'relay_started' });
            vi.spyOn(nativeRuntime.director, 'intent').mockResolvedValue({ status: 'intent_sent' });
            vi.spyOn(nativeRuntime.director, 'syncRequest').mockResolvedValue({ status: 'sync_requested' });
            vi.spyOn(nativeRuntime.director, 'relayStop').mockResolvedValue({ status: 'relay_stopped' });
            const runtime = createSpaBrowserRallarRuntime();

            await expect(runtime.director?.appoint({ roomId: 'room-1' })).resolves.toEqual({ status: 'appointed' });
            await expect(runtime.director?.status({ roomId: 'room-1' })).resolves.toEqual({ status: 'status' });
            await expect(
                runtime.director?.relayStart({
                    handle: 'relay-1',
                    intentTypeId: 'intent',
                    outputTypeId: 'output'
                })
            ).resolves.toEqual({ status: 'relay_started' });
            await expect(runtime.director?.intent({ handle: 'relay-1', intent: { intentId: 'intent-1' } }))
                .resolves.toEqual({ status: 'intent_sent' });
            await expect(runtime.director?.syncRequest({ handle: 'relay-1' })).resolves.toEqual({ status: 'sync_requested' });
            await expect(runtime.director?.relayStop({ handle: 'relay-1' })).resolves.toEqual({ status: 'relay_stopped' });
            await expect(runtime.director?.resign({ roomId: 'room-1' })).resolves.toEqual({ status: 'resigned' });
        });
    });

    it('bridges browser Rallar events into the shared runtime', async () => {
        await withBrowserRuntime(async () => {
            const runtime = createRallarBlackBoxBrowserTestRuntime({
                rallarRuntime: createSpaBrowserRallarRuntime()
            });
            installSpaBrowserRallarEventBridge(runtime);

            await runtime.execute({
                kind: 'configure',
                commandId: 'configure-browser-rallar',
                config: {
                    apiBaseUrl: 'https://api.example.test',
                    actor: 'alice',
                    sessionId: facade.session.sessionId,
                    roomId: 'room-1',
                    transport: 'realtime',
                    rallar: {
                        username: 'alice',
                        password: 'secret'
                    },
                    control: {
                        providerMode: 'browser-rallar'
                    }
                }
            });
            const result = await runtime.execute({
                kind: 'rtc.connect',
                commandId: 'connect-browser-rallar',
                connection: 'aliceRtc'
            });

            expect(result.ok).toBe(true);
            expect(
                selectRallarBlackBoxDiagnostics(runtime.state()).some((event) =>
                    event.topic === 'rallar.browser.connect.phase_completed' &&
                    event.connection === 'aliceRtc'
                )
            ).toBe(true);
        });
    });

    it('maps shared connect and send commands to the browser Rallar runtime', async () => {
        await withBrowserRuntime(async (nativeRuntime) => {
            const connect = vi.spyOn(nativeRuntime, 'connect');
            const send = vi.spyOn(nativeRuntime, 'send');
            facade.behavior.realtimeSend.mockResolvedValue([{
                peerId: 'bob-session',
                laneId: 'realtime',
                result: { status: 'sent', bufferedAmount: 0 }
            }]);
            const runtime = createRallarBlackBoxBrowserTestRuntime({
                rallarRuntime: createSpaBrowserRallarRuntime()
            });

            await runtime.execute({
                kind: 'configure',
                commandId: 'configure-real-command-path',
                config: {
                    apiBaseUrl: 'https://api.example.test',
                    actor: 'alice',
                    sessionId: facade.session.sessionId,
                    roomId: 'room-1',
                    transport: 'realtime',
                    rallar: {
                        username: 'alice',
                        password: 'secret',
                        transport: 'realtime'
                    },
                    control: {
                        providerMode: 'browser-rallar'
                    }
                }
            });
            const connectResult = await runtime.execute({
                kind: 'rtc.connect',
                commandId: 'connect-real-command-path',
                connection: 'realRtc'
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
                        text: 'hello'
                    }
                }
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
                    expectedSessionId: facade.session.sessionId
                }
            });
            expect(send).toHaveBeenCalledWith({
                roomId: 'room-1',
                peerIds: ['bob-session'],
                data: {
                    text: 'hello'
                }
            });
            expect(
                selectRallarBlackBoxDiagnostics(runtime.state()).some((event) =>
                    event.topic === 'rallar.bb.rtc.send_completed' &&
                    event.commandId === 'send-real-command-path'
                )
            ).toBe(true);
        });
    });

    it('waits for rtc.connect readiness before reporting success', async () => {
        const health = vi.fn()
            .mockResolvedValueOnce({
                rtcStatus: {
                    readyPeerIds: []
                }
            })
            .mockResolvedValueOnce({
                rtcStatus: {
                    readyPeerIds: ['peer-a', 'peer-b']
                }
            });
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                connect: vi.fn(async () => ({
                    connected: true,
                    rtcStatus: {
                        readyPeerIds: []
                    }
                })),
                send: vi.fn(),
                refreshRoom: vi.fn(),
                close: vi.fn(),
                health
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.connect',
            commandId: 'connect-ready-peers',
            connection: 'rtc',
            readiness: {
                minReadyPeers: 2,
                timeoutMs: 50,
                intervalMs: 1
            }
        });

        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({
            readiness: {
                readyPeerIds: ['peer-a', 'peer-b'],
                minReadyPeers: 2
            }
        });
        expect(selectRallarBlackBoxDiagnostics(runtime.state()).map((event) => event.topic)).toEqual(expect.arrayContaining([
            'rallar.bb.rtc.readiness_wait_started',
            'rallar.bb.rtc.readiness_ready',
            'rallar.bb.rtc.connected'
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
                        readyPeerIds: ['peer-a']
                    }
                })),
                refreshRoom
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.connect',
            commandId: 'connect-already-ready',
            connection: 'rtc',
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 50,
                intervalMs: 1
            }
        });

        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({
            readiness: {
                roomRefreshAttempts: 0,
                roomRefreshSuccesses: 0,
                roomRefreshRetryableFailures: 0
            }
        });
    });

    it('refreshes room state while waiting for an initially undiscovered RTC peer', async () => {
        let roomStateRefreshed = false;
        const refreshRoom = vi.fn(async (_options: RallarBlackBoxBrowserRoomRefreshOptions) => {
            roomStateRefreshed = true;
        });
        const health = vi.fn(async () => ({
            rtcStatus: {
                readyPeerIds: roomStateRefreshed ? ['peer-a'] : []
            }
        }));
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                connect: vi.fn(async () => ({
                    connected: true,
                    rtcStatus: {
                        readyPeerIds: []
                    }
                })),
                send: vi.fn(),
                close: vi.fn(),
                health,
                refreshRoom
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.connect',
            commandId: 'connect-after-room-refresh',
            connection: 'rtc',
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 50,
                intervalMs: 1
            }
        });

        expect(result.ok).toBe(true);
        expect(refreshRoom).toHaveBeenCalledWith({
            signal: expect.any(AbortSignal),
            timeoutMs: expect.any(Number)
        });
        const refreshOptions = refreshRoom.mock.calls[0]?.[0];
        expect(refreshOptions?.timeoutMs).toBeGreaterThan(0);
        expect(refreshOptions?.timeoutMs).toBeLessThanOrEqual(50);
        expect(result.value).toMatchObject({
            readiness: {
                readyPeerIds: ['peer-a'],
                roomRefreshAttempts: 1,
                roomRefreshSuccesses: 1,
                roomRefreshRetryableFailures: 0
            }
        });
    });

    it('does not let a pending room refresh overrun rtc.connect readiness', async () => {
        vi.useFakeTimers();
        try {
            const refreshRoom = vi.fn((
                _options: RallarBlackBoxBrowserRoomRefreshOptions
            ) => new Promise<void>(() => undefined));
            const runtime = createRallarBlackBoxBrowserTestRuntime({
                rallarRuntime: {
                    connect: vi.fn(async () => ({ connected: true })),
                    send: vi.fn(),
                    close: vi.fn(),
                    health: vi.fn(async () => ({
                        rtcStatus: {
                            readyPeerIds: []
                        }
                    })),
                    refreshRoom
                }
            });

            const pending = runtime.execute({
                kind: 'rtc.connect',
                commandId: 'connect-pending-room-refresh',
                connection: 'rtc',
                readiness: {
                    minReadyPeers: 1,
                    timeoutMs: 10,
                    intervalMs: 1
                }
            });
            await vi.advanceTimersByTimeAsync(0);

            const signal = refreshRoom.mock.calls[0]?.[0].signal;
            expect(signal?.aborted).toBe(false);

            await vi.advanceTimersByTimeAsync(10);
            const result = await pending;

            expect(result.ok).toBe(false);
            expect(result.error).toMatchObject({
                code: 'RALLAR_BB_RTC_READY_TIMEOUT'
            });
            expect(result.value).toMatchObject({
                readiness: {
                    roomRefreshAttempts: 1,
                    roomRefreshSuccesses: 0,
                    roomRefreshRetryableFailures: 0
                }
            });
            expect(signal?.aborted).toBe(true);
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('cancels a pending room refresh when distributed execution is cancelled', async () => {
        vi.useFakeTimers();
        try {
            const refreshRoom = vi.fn((
                _options: RallarBlackBoxBrowserRoomRefreshOptions
            ) => new Promise<void>(() => undefined));
            const runtime = createRallarBlackBoxBrowserTestRuntime({
                rallarRuntime: {
                    connect: vi.fn(async () => ({ connected: true })),
                    send: vi.fn(),
                    close: vi.fn(),
                    health: vi.fn(async () => ({
                        rtcStatus: {
                            readyPeerIds: []
                        }
                    })),
                    refreshRoom
                }
            });

            const pendingConnect = runtime.execute({
                kind: 'rtc.connect',
                commandId: 'connect-cancelled-room-refresh',
                connection: 'rtc',
                readiness: {
                    minReadyPeers: 1,
                    timeoutMs: 10_000,
                    intervalMs: 1
                }
            });
            await vi.advanceTimersByTimeAsync(0);
            const signal = refreshRoom.mock.calls[0]?.[0].signal;

            await runtime.execute({
                kind: 'recipe.cancel',
                commandId: 'cancel-pending-room-refresh',
                reason: 'distributed run cancelled'
            });
            const result = await pendingConnect;

            expect(result.status).toBe('cancelled');
            expect(signal?.aborted).toBe(true);
        }
        finally {
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
                            readyPeerIds: roomStateRefreshed ? ['peer-a'] : []
                        }
                    })),
                    refreshRoom
                }
            });

            const pending = runtime.execute({
                kind: 'rtc.connect',
                commandId: 'connect-after-transient-refresh-failure',
                connection: 'rtc',
                readiness: {
                    minReadyPeers: 1,
                    timeoutMs: 1_500,
                    intervalMs: 100
                }
            });
            await vi.advanceTimersByTimeAsync(0);

            await vi.advanceTimersByTimeAsync(1_000);
            const result = await pending;

            expect(result.ok).toBe(true);
            expect(result.value).toMatchObject({
                readiness: {
                    readyPeerIds: ['peer-a'],
                    roomRefreshAttempts: 2,
                    roomRefreshSuccesses: 1,
                    roomRefreshRetryableFailures: 1,
                    lastRefreshError: {
                        name: 'Error',
                        message: refreshError.message
                    }
                }
            });
        }
        finally {
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
                'room refresh forbidden'
            )
        ],
        [
            'configuration validation',
            new RallarValidationError('$.roomRef: Exact room reference is required.', [
                {
                    path: '$.roomRef',
                    code: 'room-ref-required',
                    message: 'Exact room reference is required.'
                }
            ])
        ]
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
                            readyPeerIds: []
                        }
                    })),
                    refreshRoom
                }
            });

            const pending = runtime.execute({
                kind: 'rtc.connect',
                commandId: `connect-after-${refreshError.name}`,
                connection: 'rtc',
                readiness: {
                    minReadyPeers: 1,
                    timeoutMs: 25,
                    intervalMs: 1
                }
            });
            let completed = false;
            void pending.then(() => {
                completed = true;
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(completed).toBe(true);
            const result = await pending;

            expect(result.ok).toBe(false);
            expect(result.error).toMatchObject({
                code: 'RALLAR_BLACK_BOX_COMMAND_FAILED',
                message: refreshError.message,
                details: {
                    name: refreshError.name
                }
            });
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('uses the readiness timeout window after rtc.connect completes', async () => {
        const health = vi.fn()
            .mockResolvedValueOnce({
                rtcStatus: {
                    readyPeerIds: []
                }
            })
            .mockResolvedValueOnce({
                rtcStatus: {
                    readyPeerIds: ['peer-a']
                }
            });
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                connect: vi.fn(async () => ({
                    connected: true,
                    rtcStatus: {
                        readyPeerIds: []
                    }
                })),
                send: vi.fn(),
                refreshRoom: vi.fn(),
                close: vi.fn(),
                health
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.connect',
            commandId: 'connect-ready-after-command-timeout',
            connection: 'rtc',
            timeoutMs: 1,
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 50,
                intervalMs: 5
            }
        });

        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({
            readiness: {
                ready: true,
                readyPeerIds: ['peer-a'],
                minReadyPeers: 1
            }
        });
    });

    it('fails rtc.connect when readiness times out', async () => {
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                connect: vi.fn(async () => ({
                    connected: true,
                    rtcStatus: {
                        readyPeerIds: []
                    }
                })),
                send: vi.fn(),
                refreshRoom: vi.fn(),
                close: vi.fn(),
                health: vi.fn(async () => ({
                    rtcStatus: {
                        readyPeerIds: []
                    }
                }))
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.connect',
            commandId: 'connect-ready-timeout',
            connection: 'rtc',
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 5,
                intervalMs: 1
            }
        });

        expect(result.ok).toBe(false);
        expect(result.error).toMatchObject({
            code: 'RALLAR_BB_RTC_READY_TIMEOUT',
            message: 'RTC connect timed out waiting for ready peers.'
        });
        expect(
            selectRallarBlackBoxDiagnostics(runtime.state()).some((event) =>
                event.topic === 'rallar.bb.rtc.readiness_timeout' &&
                event.commandId === 'connect-ready-timeout' &&
                event.severity === 'error'
            )
        ).toBe(true);
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
                    health: []
                })),
                refreshRoom: vi.fn(),
                close: vi.fn(),
                health: vi.fn()
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.send',
            commandId: 'manual-send-no-peers',
            connection: 'aliceRtc',
            transport: 'realtime',
            send: {
                roomId: 'awesome',
                data: {
                    text: 'hello solo room'
                }
            }
        });

        expect(result.ok).toBe(false);
        expect(result.error).toMatchObject({
            code: 'RALLAR_BB_RTC_NO_PEERS',
            message: 'RTC send resolved no target peers.'
        });
        expect(
            selectRallarBlackBoxDiagnostics(runtime.state()).some((event) =>
                event.topic === 'rallar.bb.rtc.send_failed' &&
                event.commandId === 'manual-send-no-peers' &&
                event.severity === 'error'
            )
        ).toBe(true);
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
                        reason: 'No outbound transport route for message test-msg'
                    },
                    health: []
                })),
                refreshRoom: vi.fn(),
                close: vi.fn(),
                health: vi.fn()
            }
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
                    text: 'hello solo room'
                }
            }
        });

        expect(result.ok).toBe(false);
        expect(result.error).toMatchObject({
            code: 'RALLAR_BB_RTC_NO_ROUTE',
            message: 'RTC send failed with status no-route: No outbound transport route for message test-msg'
        });
        expect(
            selectRallarBlackBoxDiagnostics(runtime.state()).some((event) =>
                event.topic === 'rallar.bb.rtc.send_failed' &&
                event.commandId === 'manual-send-no-route' &&
                event.severity === 'error'
            )
        ).toBe(true);
    });
});
