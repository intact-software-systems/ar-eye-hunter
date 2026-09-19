import { describe, expect, it, vi } from 'vitest';

import type { BlackBoxRallarRuntime } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts';
import {
    createBlackBoxRallarRuntime,
    type BlackBoxRallarRuntimeInstallationTarget
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime.ts';

import {
    createSpaBrowserRallarRuntime,
    installSpaBrowserRallarEventBridge
} from '../../../apps/rallar-black-box/src/browser-rallar-runtime.ts';
import { toRallarBlackBoxDiagnostics } from '../../../packages/shared-test/rallar-bb-test/test-state-accessors.ts';
import { ApiHttpError } from '../../../packages/shared-web/browser/api/http-error.ts';
import { RallarValidationError } from '../../../packages/shared/api/rallar-validation.ts';
import type { RallarBlackBoxBrowserRoomRefreshOptions } from '../../shared-test/rallar-bb-test/browser/browser-command-contracts.ts';
import { createRallarBlackBoxBrowserTestRuntime } from '../../shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';

import { createBrowserRallarRequiredMethodsTestDouble } from '../shared-test/browser-rallar-required-methods-test-double.ts';
import {
    events,
    facade,
    resetFacade
} from '../shared-test/rallar-browser-runtime/browser-rallar-runtime-test-harness.ts';
import { openFacadeDelivery } from '../shared-test/rallar-browser-runtime/browser-runtime-facade-test-double.ts';

interface BrowserRuntimeTiming {
    readonly now: () => number;
    readonly delay: (milliseconds: number) => Promise<void>;
}

async function withBrowserRuntime(
    run: (nativeRuntime: BlackBoxRallarRuntime) => Promise<void>
): Promise<void> {
    await withBrowserRuntimeTiming(
        { now: Date.now, delay: async () => undefined },
        run
    );
}

async function withBrowserRuntimeTiming(
    timing: BrowserRuntimeTiming,
    run: (nativeRuntime: BlackBoxRallarRuntime) => Promise<void>
): Promise<void> {
    resetFacade();
    const targetWindow: BlackBoxRallarRuntimeInstallationTarget = {
        __blackBoxRallarEmit: (event) => {
            events.push(event);
        }
    };
    const nativeRuntime = createBlackBoxRallarRuntime({
        facade: facade.rallar,
        targetWindow,
        clock: { now: timing.now },
        delay: timing.delay
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
            facade.behavior.realtimeSend.mockResolvedValue([
                {
                    peerId: 'bob-session',
                    laneId: 'realtime',
                    result: { status: 'sent', bufferedAmount: 0 }
                }
            ]);
            facade.behavior.rtcWaitForRoom.mockResolvedValue({
                roomRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1'
                },
                ws: facade.rallar.ws.status(),
                rtc: {
                    desired: true,
                    mode: 'lazy',
                    state: 'open',
                    acceptedLayoutIdentity: {
                        groupRevision: 2,
                        presenceRevision: 2,
                        version: 1,
                        state: 'active'
                    },
                    desiredPeerIds: ['bob-session'],
                    knownPeerIds: ['bob-session'],
                    activePeerIds: ['bob-session'],
                    readyPeerIds: ['bob-session'],
                    failedPeerIds: [],
                    peers: [],
                    laneId: 'realtime'
                }
            });
            const runtime = createSpaBrowserRallarRuntime();
            await expect(
                runtime.connect({
                    connection: 'aliceRtc',
                    roomId: 'room-1',
                    rallar: {
                        apiBaseUrl: 'https://api.example.test',
                        applicationId: 'app-1',
                        workspaceId: 'workspace-1',
                        username: 'alice',
                        password: 'secret'
                    }
                })
            ).resolves.toMatchObject({
                status: 'connected',
                connection: 'aliceRtc',
                sessionId: facade.session.sessionId
            });
            await expect(
                runtime.send({ peerIds: ['bob-session'], data: { text: 'hello' } })
            ).resolves.toMatchObject({ status: 'sent', peerIds: ['bob-session'] });
            await expect(
                runtime.sendWs?.({
                    typeId: 'room.manual.message',
                    payload: { text: 'hello ws' }
                })
            ).resolves.toMatchObject({
                status: 'sent',
                transport: 'ws',
                typeId: 'room.manual.message'
            });
            await expect(
                runtime.refreshRoom({ timeoutMs: 100 })
            ).resolves.toBeUndefined();
            expect(facade.records.roomStateRefreshes).toContainEqual([
                {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1'
                },
                {
                    timeoutMs: 100,
                    scope: { applicationId: 'app-1', workspaceId: 'workspace-1' }
                }
            ]);
            await expect(
                runtime.waitForRoom({
                    connect: true,
                    minReadyPeers: 1,
                    timeoutMs: 100
                })
            ).resolves.toMatchObject({
                rtc: { state: 'open', readyPeerIds: ['bob-session'] }
            });
            expect(facade.records.rtcRoomWaits).toContainEqual([
                {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1'
                },
                {
                    connect: true,
                    laneId: 'realtime',
                    minReadyPeers: 1,
                    signal: undefined,
                    timeoutMs: 100
                }
            ]);
            await expect(
                runtime.health({ includeRtcDiagnostics: true })
            ).resolves.toMatchObject({
                connected: true,
                rtcDiagnostics: { sessionId: facade.session.sessionId, peerCount: 1 }
            });
            await expect(runtime.close()).resolves.toMatchObject({
                status: 'closed',
                disconnected: true,
                cleanupErrors: []
            });
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
                toRallarBlackBoxDiagnostics(runtime.state()).some(
                    (event) =>
                        event.topic === 'rallar.browser.connect.phase_completed' &&
                        event.connection === 'aliceRtc'
                )
            ).toBe(true);
        });
    });

    it('maps shared connect and send commands to the browser Rallar runtime', async () => {
        await withBrowserRuntime(async (nativeRuntime) => {
            const connect = vi.spyOn(nativeRuntime, 'connect');
            facade.behavior.realtimeSend.mockResolvedValue([
                {
                    peerId: 'bob-session',
                    laneId: 'realtime',
                    result: { status: 'sent', bufferedAmount: 0 }
                }
            ]);
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
            expect(facade.behavior.realtimeSend).toHaveBeenCalledWith(expect.objectContaining({
                roomId: 'room-1',
                peerIds: ['bob-session'],
                data: {
                    text: 'hello'
                }
            }));
            expect(
                toRallarBlackBoxDiagnostics(runtime.state()).some(
                    (event) =>
                        event.topic === 'rallar.bb.rtc.send_completed' &&
                        event.commandId === 'send-real-command-path'
                )
            ).toBe(true);
        });
    });

    it('waits for rtc.connect readiness before reporting success', async () => {
        const health = vi
            .fn()
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
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: vi.fn(async () => ({
                    connected: true,
                    rtcStatus: {
                        readyPeerIds: []
                    }
                })),
                send: vi.fn(),
                refreshRoom: vi.fn(async () => undefined),
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
        expect(
            toRallarBlackBoxDiagnostics(runtime.state()).map(
                (event) => event.topic
            )
        ).toEqual(
            expect.arrayContaining([
                'rallar.bb.rtc.readiness_wait_started',
                'rallar.bb.rtc.readiness_ready',
                'rallar.bb.rtc.connected'
            ])
        );
    });

    it('delegates messages.rtc readiness to the canonical room wait', async () => {
        const waitForRoom = vi.fn<BlackBoxRallarRuntime['waitForRoom']>(
            async () => ({
                roomRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1'
                },
                ws: facade.rallar.ws.status(),
                rtc: {
                    desired: true,
                    mode: 'lazy',
                    state: 'open',
                    acceptedLayoutIdentity: {
                        groupRevision: 2,
                        presenceRevision: 2,
                        version: 1,
                        state: 'active'
                    },
                    desiredPeerIds: ['peer-a'],
                    knownPeerIds: ['peer-a'],
                    activePeerIds: ['peer-a'],
                    readyPeerIds: ['peer-a'],
                    failedPeerIds: [],
                    peers: [],
                    laneId: 'realtime'
                }
            })
        );
        const rallarRuntime = {
            ...createBrowserRallarRequiredMethodsTestDouble(),
            connect: vi.fn(async () => ({ connected: true })),
            send: vi.fn(),
            refreshRoom: vi.fn(async () => undefined),
            waitForRoom,
            close: vi.fn(),
            health: vi.fn(async () => {
                throw new Error(
                    'messages.rtc readiness must not poll global RTC health.'
                );
            })
        };
        const runtime = createRallarBlackBoxBrowserTestRuntime({ rallarRuntime });

        const result = await runtime.execute({
            kind: 'rtc.connect',
            commandId: 'connect-ready-room',
            connection: 'rtc',
            roomId: 'room-1',
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            transport: 'messages.rtc',
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 50,
                intervalMs: 1
            }
        });

        expect(result.ok).toBe(true);
        expect(waitForRoom).toHaveBeenCalledWith({
            connect: true,
            minReadyPeers: 1,
            signal: expect.any(AbortSignal),
            timeoutMs: expect.any(Number)
        });
        expect(result.value).toMatchObject({
            readiness: {
                ready: true,
                readyPeerIds: ['peer-a'],
                room: {
                    rtc: {
                        state: 'open'
                    }
                }
            }
        });
    });

    it('fails messages.rtc readiness from canonical room state without polling global health', async () => {
        const refreshRoom = vi.fn(async () => undefined);
        const waitForRoom = vi.fn<BlackBoxRallarRuntime['waitForRoom']>(
            async () => ({
                roomRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1'
                },
                ws: facade.rallar.ws.status(),
                rtc: {
                    desired: true,
                    mode: 'lazy',
                    state: 'idle',
                    desiredPeerIds: [],
                    knownPeerIds: [],
                    activePeerIds: [],
                    readyPeerIds: [],
                    failedPeerIds: [],
                    peers: [],
                    laneId: 'realtime'
                }
            })
        );
        const health = vi.fn(async () => {
            throw new Error(
                'messages.rtc readiness must not poll global RTC health.'
            );
        });
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: vi.fn(async () => ({ connected: true })),
                send: vi.fn(),
                refreshRoom,
                waitForRoom,
                close: vi.fn(),
                health
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.connect',
            commandId: 'connect-room-not-ready',
            connection: 'rtc',
            roomId: 'room-1',
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            transport: 'messages.rtc',
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 50,
                intervalMs: 1
            }
        });

        expect(result.ok).toBe(false);
        expect(result.error).toMatchObject({
            code: 'RALLAR_BB_RTC_READY_TIMEOUT',
            message: 'RTC connect timed out waiting for room transport readiness.'
        });
        expect(result.value).toMatchObject({
            readiness: {
                ready: false,
                roomRefreshAttempts: 1,
                roomRefreshSuccesses: 1,
                roomRefreshRetryableFailures: 0,
                room: { rtc: { state: 'idle' } }
            }
        });
    });

    it('times out messages.rtc readiness when the room wait outlasts the readiness budget', async () => {
        const waitForRoom: BlackBoxRallarRuntime['waitForRoom'] = (options) =>
            new Promise((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
            });
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: vi.fn(async () => ({ connected: true })),
                send: vi.fn(),
                refreshRoom: async () => undefined,
                waitForRoom,
                close: vi.fn(),
                health: async (): Promise<never> => {
                    throw new Error('messages.rtc readiness must not poll global RTC health.');
                }
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.connect',
            commandId: 'connect-room-wait-timeout',
            connection: 'rtc',
            roomId: 'room-1',
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            transport: 'messages.rtc',
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 20,
                intervalMs: 1
            }
        });

        expect(result.ok).toBe(false);
        expect(result.error).toMatchObject({
            code: 'RALLAR_BB_RTC_READY_TIMEOUT',
            message: 'RTC connect timed out waiting for room transport readiness.'
        });
        expect(result.value).toMatchObject({
            readiness: { ready: false, roomRefreshAttempts: 1, roomRefreshSuccesses: 1, readyPeerIds: [] }
        });
        expect(result.value).not.toHaveProperty('readiness.room');
    });

    it('does not retry a messages.rtc authority refresh failure', async () => {
        const refreshError = new Error('transient point-read failure');
        let refreshAttempts = 0;
        const refreshRoom = async (): Promise<never> => {
            refreshAttempts += 1;
            throw refreshError;
        };
        const waitForRoom: BlackBoxRallarRuntime['waitForRoom'] = async () => {
            throw new Error('A failed authority refresh must stop before room readiness.');
        };
        const health = async (): Promise<never> => {
            throw new Error('messages.rtc readiness must not poll global RTC health.');
        };
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: vi.fn(async () => ({ connected: true })),
                send: vi.fn(),
                refreshRoom,
                waitForRoom,
                close: vi.fn(),
                health
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.connect',
            commandId: 'connect-room-refresh-failure',
            connection: 'rtc',
            roomId: 'room-1',
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            transport: 'messages.rtc',
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 1_500,
                intervalMs: 100
            }
        });

        expect(result.ok).toBe(false);
        expect(result.error).toMatchObject({
            code: 'RALLAR_BLACK_BOX_COMMAND_FAILED',
            message: refreshError.message
        });
        expect(refreshAttempts).toBe(1);
    });

    it('refreshes room authority before accepting an already-ready RTC peer', async () => {
        const refreshRoom = vi.fn(async () => undefined);
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
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
                roomRefreshAttempts: 1,
                roomRefreshSuccesses: 1,
                roomRefreshRetryableFailures: 0
            }
        });
    });

    it('refreshes room state while waiting for an initially undiscovered RTC peer', async () => {
        let roomStateRefreshed = false;
        const refreshRoom = vi.fn(
            async (_options: RallarBlackBoxBrowserRoomRefreshOptions) => {
                roomStateRefreshed = true;
            }
        );
        const health = vi.fn(async () => ({
            rtcStatus: {
                readyPeerIds: roomStateRefreshed ? ['peer-a'] : []
            }
        }));
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
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
            const refreshRoom = vi.fn(
                (_options: RallarBlackBoxBrowserRoomRefreshOptions) => new Promise<void>(() => undefined)
            );
            const runtime = createRallarBlackBoxBrowserTestRuntime({
                rallarRuntime: {
                    ...createBrowserRallarRequiredMethodsTestDouble(),
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
            const refreshRoom = vi.fn(
                (_options: RallarBlackBoxBrowserRoomRefreshOptions) => new Promise<void>(() => undefined)
            );
            const runtime = createRallarBlackBoxBrowserTestRuntime({
                rallarRuntime: {
                    ...createBrowserRallarRequiredMethodsTestDouble(),
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
            const refreshRoom = vi
                .fn()
                .mockRejectedValueOnce(refreshError)
                .mockImplementationOnce(async () => {
                    roomStateRefreshed = true;
                });
            const runtime = createRallarBlackBoxBrowserTestRuntime({
                rallarRuntime: {
                    ...createBrowserRallarRequiredMethodsTestDouble(),
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

    it('does not trust already-ready RTC health after a transient room refresh failure', async () => {
        vi.useFakeTimers();
        try {
            const refreshError = new Error('transient point-read failure');
            const refreshRoom = vi
                .fn()
                .mockRejectedValueOnce(refreshError)
                .mockResolvedValueOnce(undefined);
            const runtime = createRallarBlackBoxBrowserTestRuntime({
                rallarRuntime: {
                    ...createBrowserRallarRequiredMethodsTestDouble(),
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

            const pending = runtime.execute({
                kind: 'rtc.connect',
                commandId: 'connect-after-stale-ready-health',
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
            new RallarValidationError(
                '$.roomRef: Exact room reference is required.',
                [
                    {
                        path: '$.roomRef',
                        code: 'room-ref-required',
                        message: 'Exact room reference is required.'
                    }
                ]
            )
        ]
    ])(
        'fails rtc.connect immediately after a permanent %s refresh failure',
        async (_label, refreshError) => {
            vi.useFakeTimers();
            try {
                const refreshRoom = vi.fn().mockRejectedValue(refreshError);
                const runtime = createRallarBlackBoxBrowserTestRuntime({
                    rallarRuntime: {
                        ...createBrowserRallarRequiredMethodsTestDouble(),
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
        }
    );

    it('uses the readiness timeout window after rtc.connect completes', async () => {
        const health = vi
            .fn()
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
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: vi.fn(async () => ({
                    connected: true,
                    rtcStatus: {
                        readyPeerIds: []
                    }
                })),
                send: vi.fn(),
                refreshRoom: vi.fn(async () => undefined),
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
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: vi.fn(async () => ({
                    connected: true,
                    rtcStatus: {
                        readyPeerIds: []
                    }
                })),
                send: vi.fn(),
                refreshRoom: vi.fn(async () => undefined),
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
            toRallarBlackBoxDiagnostics(runtime.state()).some(
                (event) =>
                    event.topic === 'rallar.bb.rtc.readiness_timeout' &&
                    event.commandId === 'connect-ready-timeout' &&
                    event.severity === 'error'
            )
        ).toBe(true);
    });

    it('fails realtime send commands when the browser runtime resolves no peers', async () => {
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: vi.fn(async () => ({ connected: true })),
                send: vi.fn(async () => ({
                    status: 'no-peers',
                    transport: 'realtime',
                    roomId: 'awesome',
                    peerIds: [],
                    results: [],
                    health: []
                })),
                refreshRoom: vi.fn(async () => undefined),
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
            toRallarBlackBoxDiagnostics(runtime.state()).some(
                (event) =>
                    event.topic === 'rallar.bb.rtc.send_failed' &&
                    event.commandId === 'manual-send-no-peers' &&
                    event.severity === 'error'
            )
        ).toBe(true);
    });

    it('counts the replaced realtime peer payloads on the send observation', async () => {
        const toPeerResult = (peerId: string, status: 'sent' | 'queued' | 'replaced') => ({
            peerId,
            laneId: 'realtime',
            result: { status, bufferedAmount: 0 }
        });
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: vi.fn(async () => ({ connected: true })),
                send: vi.fn(async () => ({
                    status: 'sent',
                    transport: 'realtime',
                    roomId: 'awesome',
                    peerIds: ['peer-a', 'peer-b', 'peer-c', 'peer-d'],
                    results: [
                        toPeerResult('peer-a', 'sent'),
                        toPeerResult('peer-b', 'replaced'),
                        toPeerResult('peer-c', 'replaced'),
                        toPeerResult('peer-d', 'queued')
                    ],
                    health: []
                })),
                refreshRoom: vi.fn(async () => undefined),
                close: vi.fn(),
                health: vi.fn()
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.send',
            commandId: 'manual-send-replaced',
            connection: 'aliceRtc',
            transport: 'realtime',
            send: { roomId: 'awesome', data: { text: 'latest frame' } }
        });

        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({
            sendObservation: { status: 'sent', ok: true, replacedPayloadCount: 2 }
        });
    });

    it.each(['dropped', 'replaced'] as const)(
        'fails a loop with failOnBackpressure when a realtime send reports a %s payload',
        async (peerStatus) => {
            const runtime = createRallarBlackBoxBrowserTestRuntime({
                rallarRuntime: {
                    ...createBrowserRallarRequiredMethodsTestDouble(),
                    connect: vi.fn(async () => ({ connected: true })),
                    send: vi.fn(async () => ({
                        status: 'sent',
                        transport: 'realtime',
                        results: [{ peerId: 'peer-a', laneId: 'realtime', result: { status: peerStatus, bufferedAmount: 0 } }],
                        health: []
                    })),
                    refreshRoom: vi.fn(async () => undefined),
                    close: vi.fn(),
                    health: vi.fn()
                }
            });

            const result = await runtime.execute({
                kind: 'loop',
                commandId: `loop-${peerStatus}`,
                count: 1,
                continueOnFailure: true,
                thresholds: { failOnBackpressure: true },
                commands: [{ kind: 'rtc.send', transport: 'realtime', send: { data: { text: 'frame' } } }]
            });

            expect(result.ok).toBe(false);
            expect(result.value).toMatchObject({
                sends: { [`${peerStatus}PayloadCount`]: 1 },
                thresholdFailures: [{ name: 'failOnBackpressure', category: 'backpressure' }]
            });
        }
    );

    it.each([
        ['a messages.rtc result with no delivery state', { transport: 'messages.rtc', message: { handleId: 'h-1' } }],
        ['a messages.rtc result with an unknown delivery state', { transport: 'messages.rtc', message: { state: 'delivered' } }],
        ['a realtime result with no peer results', { status: 'sent', transport: 'realtime' }],
        ['a realtime peer result with an unknown status', {
            status: 'sent',
            transport: 'realtime',
            results: [{ peerId: 'peer-a', laneId: 'realtime', result: { status: 'teleported', bufferedAmount: 0 } }]
        }],
        ['a result that is not a record', 'sent']
    ])('fails rtc.send as an invalid result when the page runtime returns %s', async (_label, sendResult) => {
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: vi.fn(async () => ({ connected: true })),
                send: vi.fn(async () => sendResult),
                refreshRoom: vi.fn(async () => undefined),
                close: vi.fn(),
                health: vi.fn()
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.send',
            commandId: 'malformed-send-result',
            connection: 'aliceRtc',
            send: { roomId: 'awesome', data: { text: 'hello' } }
        });

        expect(result.ok).toBe(false);
        expect(result.error).toMatchObject({ code: 'RALLAR_BB_RTC_INVALID_SEND_RESULT' });
        expect(result.value).toMatchObject({
            sendObservation: { ok: false, errorCode: 'RALLAR_BB_RTC_INVALID_SEND_RESULT' }
        });
    });

    it('counts an rtc.stream frame whose page runtime result does not decode as a failed frame', async () => {
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: vi.fn(async () => ({ connected: true })),
                send: vi.fn(async () => ({ transport: 'messages.rtc', message: {} })),
                refreshRoom: vi.fn(async () => undefined),
                close: vi.fn(),
                health: vi.fn()
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.stream',
            commandId: 'malformed-stream-result',
            connection: 'aliceRtc',
            count: 2,
            intervalMs: 1,
            send: { data: { seq: '{stream.index}' } }
        });

        expect(result.value).toMatchObject({
            attemptedFrames: 2,
            completedFrames: 0,
            failedFrames: 2,
            observations: [
                { ok: false, errorCode: 'RALLAR_BB_RTC_INVALID_SEND_RESULT' },
                { ok: false, errorCode: 'RALLAR_BB_RTC_INVALID_SEND_RESULT' }
            ]
        });
    });

    it('fails a messages.rtc send whose delivery lifecycle ends failed because no route remained', async () => {
        await withBrowserRuntime(async (nativeRuntime) => {
            const detail = 'No outbound transport route for the room message.';
            facade.behavior.rtcMessageSend.mockImplementation(async () => {
                const handle = openFacadeDelivery('rtc', { kind: 'unroutable', reason: 'no-route', detail });
                facade.deliveries.record({ kind: 'attempts-exhausted', msgId: handle.msgId, carrier: 'rtc', atMs: Date.now(), detail });
                return handle;
            });
            await nativeRuntime.connect({
                connection: 'aliceRtc',
                roomId: 'awesome',
                rallar: {
                    apiBaseUrl: 'https://api.example.test',
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    username: 'alice',
                    password: 'secret',
                    transport: 'messages.rtc',
                    typeId: 'manual.type'
                }
            });
            const runtime = createRallarBlackBoxBrowserTestRuntime({
                rallarRuntime: createSpaBrowserRallarRuntime()
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
                code: 'RALLAR_BB_RTC_SEND_FAILED',
                message: `RTC send failed with status failed: ${detail}`
            });
            expect(result.value).toMatchObject({
                message: { state: 'failed', submitted: false, attempts: 1, reason: detail },
                sendObservation: { status: 'failed', ok: false, errorCode: 'RALLAR_BB_RTC_SEND_FAILED' }
            });
            expect(
                toRallarBlackBoxDiagnostics(runtime.state()).some(
                    (event) =>
                        event.topic === 'rallar.bb.rtc.send_failed' &&
                        event.commandId === 'manual-send-no-route' &&
                        event.severity === 'error'
                )
            ).toBe(true);
        });
    });
});
