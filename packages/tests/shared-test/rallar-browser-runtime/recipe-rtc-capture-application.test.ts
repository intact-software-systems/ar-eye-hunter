import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BlackBoxRallarEvent } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import type { BlackBoxRallarRuntime } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts';
import {
    createBlackBoxRallarRuntime,
    type BlackBoxRallarRuntimeInstallationTarget
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime.ts';
import {
    createBlackBoxBrowserRallarRuntimeDependency,
    type BlackBoxBrowserRallarRuntimeDependency
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts';
import type { BlackBoxRallarConnectionRuntime } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-connection-runtime.ts';
import { BlackBoxRallarVolatileLimits } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-volatile-limits.ts';
import { createSpaBrowserRallarRuntime } from '@shared-test/rallar-bb-test/browser-rallar-runtime-bridge.ts';
import type { RallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/browser/browser-command-contracts.ts';
import { parseControlServerMessage } from '@shared-test/rallar-bb-test/control-protocol.ts';
import { createRallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import * as connectionHttp from '@shared-web/browser/connection/connection-http-api.ts';
import * as heartbeat from '@shared-web/browser/session/browser-session-heartbeat.ts';
import * as snapshots from '@shared-web/browser/state-read/refresh-state-snapshots.ts';
import * as auth from '@shared/api/auth.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import '../../setup-browser-indexeddb.ts';
import { installFakeBroadcastChannelPerTest } from '../../shared-web/data/rallar-data-test-runtime.ts';

installFakeBroadcastChannelPerTest();
beforeEach(() => {
    vi.spyOn(auth, 'readSession').mockReturnValue({
        clientId: 'client',
        sessionId: 'session',
        username: 'tester',
        accessToken: 'unit-test',
        expiresAtEpochMs: Date.now() + 60_000
    });
    vi.stubGlobal(
        'localStorage',
        {
            getItem: () => JSON.stringify(auth.readSession()),
            setItem: vi.fn(),
            removeItem: vi.fn()
        } satisfies Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
    );
    vi.spyOn(connectionHttp, 'readApiConfig').mockResolvedValue({
        apiBaseUrl: 'https://test.invalid',
        wsBaseUrl: 'wss://test.invalid',
        endpoints: { createWs: '/ws' }
    });
    vi.spyOn(connectionHttp, 'readIceCandidates').mockResolvedValue({ iceServers: [], expiresAtEpochMs: Date.now() + 60_000 });
    vi.spyOn(JsonWebSocketClient.prototype, 'connect').mockResolvedValue();
    vi.spyOn(snapshots, 'refreshStateSnapshots').mockResolvedValue({ clients: [], groups: [] });
    vi.spyOn(heartbeat, 'initHeartbeat').mockResolvedValue({ sessionId: 'session', generationId: 'test', stop: () => {} });
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

interface CaptureApplicationRuntime {
    readonly events: BlackBoxRallarEvent[];
    readonly facade: BlackBoxBrowserRallarRuntimeDependency;
    readonly page: BlackBoxRallarRuntime;
    readonly runtime: RallarBlackBoxBrowserTestRuntime;
    readonly targetWindow: BlackBoxRallarRuntimeInstallationTarget;
}

function createRuntime(
    readDocument: BlackBoxRallarConnectionRuntime.Input['readDocument'] = () => ({ timeOrigin: 1, origin: 'https://test.invalid' })
): CaptureApplicationRuntime {
    const events: BlackBoxRallarEvent[] = [];
    const volatileLimits = new BlackBoxRallarVolatileLimits();
    const facade = createBlackBoxBrowserRallarRuntimeDependency({ readVolatileSessionLimits: volatileLimits.get });
    const targetWindow: BlackBoxRallarRuntimeInstallationTarget = {
        __blackBoxRallarEmit: (event) => {
            events.push(event);
        }
    };
    const page = createBlackBoxRallarRuntime({
        facade,
        volatileLimits,
        targetWindow,
        clock: { now: Date.now },
        readDocument,
        delay: async () => {}
    });
    vi.stubGlobal('window', Object.assign(new EventTarget(), { __blackBoxRallar: page }));
    return { events, facade, page, targetWindow, runtime: createRallarBlackBoxBrowserTestRuntime({ rallarRuntime: createSpaBrowserRallarRuntime() }) };
}

describe('decoded recipe application through the SPA and SDK initializer', () => {
    it('required connect cannot verify after phase-completed callback closes its page', async () => {
        const { events, facade, page, runtime, targetWindow } = createRuntime();
        let closing: ReturnType<BlackBoxRallarRuntime['close']> | undefined;
        let originalReceipt: ReturnType<BlackBoxBrowserRallarRuntimeDependency['rtcCapture']>;
        targetWindow.__blackBoxRallarEmit = (event) => {
            events.push(event);
            if (
                event.topic === 'rallar.browser.connect.phase_completed' &&
                typeof event.data === 'object' && event.data !== null &&
                'phase' in event.data && event.data.phase === 'rallar-connect'
            ) {
                originalReceipt = facade.rtcCapture();
                closing = page.close();
            }
        };
        try {
            const result = await runtime.execute({
                kind: 'recipe.run',
                rtcCaptureMode: 'off',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'closed-connect',
                    commands: [
                        { kind: 'configure', config: { rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app' } } },
                        { kind: 'rtc.connect' }
                    ]
                }
            });
            expect(originalReceipt).toMatchObject({
                configuration: { mode: 'off', origin: 'run' },
                application: { status: 'applied', mode: 'off' }
            });
            expect(closing).toBeDefined();
            await closing;
            expect.soft(result.ok, JSON.stringify(result)).toBe(false);
            const connectCommand = runtime.state().commandHistory.find((entry) => entry.kind === 'rtc.connect');
            expect.soft(JSON.parse(JSON.stringify(connectCommand))).toMatchObject({
                status: 'failed',
                error: {
                    code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                    details: {
                        reason: 'operation-not-current',
                        requestedConfiguration: { mode: 'off', origin: 'run' },
                        rtcCapture: { status: 'observed', value: originalReceipt }
                    }
                }
            });
            expect.soft(events.filter((event) => event.topic === 'rallar.browser.connect_completed')).toEqual([]);
            expect.soft(JSON.parse(JSON.stringify(events.filter((event) => event.topic === 'rallar.browser.connect_failed')))).toEqual(
                expect.arrayContaining([expect.objectContaining({
                    topic: 'rallar.browser.connect_failed',
                    error: expect.objectContaining({
                        code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                        reason: 'operation-not-current',
                        requestedConfiguration: { mode: 'off', origin: 'run' },
                        rtcCapture: { status: 'observed', value: originalReceipt }
                    })
                })])
            );
        }
        finally {
            await page.close();
        }
    });

    it.each(['phase status', 'result lane health'] as const)('required connect cannot verify after %s diagnostic read closes its page', async (boundary) => {
        const { events, facade, page, runtime } = createRuntime();
        let closing: ReturnType<BlackBoxRallarRuntime['close']> | undefined;
        let originalReceipt: ReturnType<BlackBoxBrowserRallarRuntimeDependency['rtcCapture']>;
        const closeAfterDiagnosticRead = (): void => {
            const receipt = facade.rtcCapture();
            if (!closing && receipt) {
                originalReceipt = receipt;
                closing = page.close();
            }
        };
        if (boundary === 'phase status') {
            const readStatus = facade.rtc.status;
            vi.spyOn(facade.rtc, 'status').mockImplementation((options) => {
                const status = readStatus(options);
                closeAfterDiagnosticRead();
                return status;
            });
        }
        else {
            const readHealth = facade.realtime.health;
            vi.spyOn(facade.realtime, 'health').mockImplementation((options) => {
                const health = readHealth(options);
                closeAfterDiagnosticRead();
                return health;
            });
        }
        try {
            const result = await runtime.execute({
                kind: 'recipe.run',
                rtcCaptureMode: 'off',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'closed-diagnostic-read',
                    commands: [
                        { kind: 'configure', config: { rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app' } } },
                        { kind: 'rtc.connect' }
                    ]
                }
            });
            expect(originalReceipt).toMatchObject({
                configuration: { mode: 'off', origin: 'run' },
                application: { status: 'applied', mode: 'off' }
            });
            expect(closing).toBeDefined();
            await closing;
            expect.soft(result.ok, JSON.stringify(result)).toBe(false);
            const connectCommand = runtime.state().commandHistory.find((entry) => entry.kind === 'rtc.connect');
            expect.soft(JSON.parse(JSON.stringify(connectCommand))).toMatchObject({
                status: 'failed',
                error: {
                    code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                    details: {
                        reason: 'operation-not-current',
                        requestedConfiguration: { mode: 'off', origin: 'run' },
                        rtcCapture: { status: 'observed', value: originalReceipt }
                    }
                }
            });
            expect.soft(events.filter((event) => event.topic === 'rallar.browser.connect_completed')).toEqual([]);
            expect.soft(JSON.parse(JSON.stringify(events.filter((event) => event.topic === 'rallar.browser.connect_failed')))).toEqual(
                expect.arrayContaining([expect.objectContaining({
                    connection: 'default',
                    error: expect.objectContaining({
                        code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                        reason: 'operation-not-current',
                        requestedConfiguration: { mode: 'off', origin: 'run' },
                        rtcCapture: { status: 'observed', value: originalReceipt }
                    })
                })])
            );
        }
        finally {
            await page.close();
        }
    });

    it('required connect cannot return verified success after terminal publication closes its page', async () => {
        const { events, facade, page, runtime, targetWindow } = createRuntime();
        let closing: ReturnType<BlackBoxRallarRuntime['close']> | undefined;
        let originalReceipt: ReturnType<BlackBoxBrowserRallarRuntimeDependency['rtcCapture']>;
        targetWindow.__blackBoxRallarEmit = (event) => {
            events.push(event);
            if (event.topic === 'rallar.browser.connect_completed') {
                originalReceipt = facade.rtcCapture();
                closing = page.close();
            }
        };
        try {
            const result = await runtime.execute({
                kind: 'recipe.run',
                rtcCaptureMode: 'off',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'closed-terminal-publication',
                    commands: [
                        { kind: 'configure', config: { rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app' } } },
                        { kind: 'rtc.connect' }
                    ]
                }
            });
            expect(originalReceipt).toMatchObject({
                configuration: { mode: 'off', origin: 'run' },
                application: { status: 'applied', mode: 'off' }
            });
            expect(closing).toBeDefined();
            await closing;
            const completion = events.find((event) => event.topic === 'rallar.browser.connect_completed');
            expect(JSON.parse(JSON.stringify(completion))).toMatchObject({
                connection: 'default',
                data: { status: 'connected', rtcCapture: { status: 'observed', value: originalReceipt } }
            });
            expect.soft(result.ok, JSON.stringify(result)).toBe(false);
            const connectCommand = runtime.state().commandHistory.find((entry) => entry.kind === 'rtc.connect');
            expect.soft(JSON.parse(JSON.stringify(connectCommand))).toMatchObject({
                status: 'failed',
                error: {
                    code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                    details: {
                        reason: 'operation-not-current',
                        requestedConfiguration: { mode: 'off', origin: 'run' },
                        rtcCapture: { status: 'observed', value: originalReceipt }
                    }
                }
            });
            expect.soft(JSON.parse(JSON.stringify(events.filter((event) => event.topic === 'rallar.browser.connect_failed')))).toEqual(
                expect.arrayContaining([expect.objectContaining({
                    connection: 'default',
                    error: expect.objectContaining({
                        code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                        reason: 'operation-not-current',
                        requestedConfiguration: { mode: 'off', origin: 'run' },
                        rtcCapture: { status: 'observed', value: originalReceipt }
                    })
                })])
            );
        }
        finally {
            await page.close();
        }
    });

    it('required Native refuses unavailable application while actual SDK construction succeeds', async () => {
        const { facade, page, runtime, events, targetWindow } = createRuntime();
        let originalReceipt: ReturnType<BlackBoxBrowserRallarRuntimeDependency['rtcCapture']>;
        let constructionConnected = false;
        let connectedAtRefusal = false;
        let receiptAtRefusal: ReturnType<BlackBoxBrowserRallarRuntimeDependency['rtcCapture']>;
        const connect = facade.connect;
        vi.spyOn(facade, 'connect').mockImplementation(async (options) => {
            const completion = await connect(options);
            originalReceipt = completion.rtcCapture.status === 'observed' ? completion.rtcCapture.value : undefined;
            constructionConnected = facade.isConnected();
            return completion;
        });
        targetWindow.__blackBoxRallarEmit = (event) => {
            events.push(event);
            if (event.topic === 'rallar.browser.connect_failed') {
                connectedAtRefusal = facade.isConnected();
                receiptAtRefusal = facade.rtcCapture();
            }
        };
        try {
            const result = await runtime.execute({
                kind: 'recipe.run',
                rtcCaptureMode: 'native',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'native-unavailable',
                    commands: [
                        { kind: 'configure', config: { rallar: { apiBaseUrl: 'https://test.invalid' } } },
                        { kind: 'rtc.connect' }
                    ]
                }
            });
            expect(originalReceipt).toMatchObject({
                configuration: { mode: 'native', origin: 'run' },
                application: { status: 'unavailable', reason: 'sink-unavailable' }
            });
            expect(constructionConnected).toBe(true);
            expect(connectedAtRefusal).toBe(true);
            expect(receiptAtRefusal).toBe(originalReceipt);
            expect.soft(result.ok, JSON.stringify(result)).toBe(false);
            expect.soft(JSON.parse(JSON.stringify(runtime.state().commandHistory.find((entry) => entry.kind === 'rtc.connect')))).toMatchObject({
                status: 'failed',
                error: {
                    code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                    details: {
                        reason: 'application-unavailable',
                        requestedConfiguration: { mode: 'native', origin: 'run' },
                        rtcCapture: { status: 'observed', value: originalReceipt }
                    }
                }
            });
            expect.soft(events.filter((event) => event.topic === 'rallar.browser.connect_completed')).toEqual([]);
            expect.soft(JSON.parse(JSON.stringify(events.filter((event) => event.topic === 'rallar.browser.connect_failed')))).toEqual(
                expect.arrayContaining([expect.objectContaining({
                    connection: 'default',
                    error: expect.objectContaining({
                        code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                        reason: 'application-unavailable',
                        requestedConfiguration: { mode: 'native', origin: 'run' },
                        rtcCapture: { status: 'observed', value: originalReceipt }
                    })
                })])
            );
        }
        finally {
            await page.close();
        }
    });

    it('required Native preserves actual applied partial coverage through page JSON success', async () => {
        const { facade, page, runtime, events } = createRuntime();
        try {
            const result = await runtime.execute({
                kind: 'recipe.run',
                rtcCaptureMode: 'native',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'native-partial',
                    commands: [
                        { kind: 'configure', config: { rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app' } } },
                        { kind: 'rtc.connect' }
                    ]
                }
            });
            const originalReceipt = facade.rtcCapture();
            expect(originalReceipt).toMatchObject({
                configuration: { mode: 'native', origin: 'run' },
                application: { status: 'applied', mode: 'native' },
                nativeCoverage: 'partial'
            });
            expect(result.ok, JSON.stringify(result)).toBe(true);
            expect(facade.isConnected()).toBe(true);
            expect(JSON.parse(JSON.stringify(runtime.state().commandHistory.find((entry) => entry.kind === 'rtc.connect')))).toMatchObject({
                status: 'ok',
                value: { status: 'connected', rtcCapture: { status: 'observed', value: originalReceipt } }
            });
            expect(JSON.parse(JSON.stringify(events.find((event) => event.topic === 'rallar.browser.connect_completed')))).toMatchObject({
                connection: 'default',
                data: { rtcCapture: { status: 'observed', value: originalReceipt } }
            });
        }
        finally {
            await page.close();
        }
    });

    it('required connect refuses session invalidated through observed SDK lifecycle clock after graph acceptance', async () => {
        const realNow = Date.now;
        const clock = vi.spyOn(Date, 'now');
        const { facade, page, runtime, events, targetWindow } = createRuntime();
        let completion: BlackBoxBrowserRallarRuntimeDependency.ConnectCompletion | undefined;
        let constructionConnected = false;
        let connectedAtRefusal = false;
        let receiptAtRefusal: ReturnType<BlackBoxBrowserRallarRuntimeDependency['rtcCapture']>;
        const connect = facade.connect;
        vi.spyOn(facade, 'connect').mockImplementation(async (options) => {
            completion = await connect(options);
            constructionConnected = facade.isConnected();
            return completion;
        });
        targetWindow.__blackBoxRallarEmit = (event) => {
            events.push(event);
            if (event.topic === 'rallar.browser.connect_failed') {
                connectedAtRefusal = facade.isConnected();
                receiptAtRefusal = facade.rtcCapture();
            }
        };
        let originalReceipt: ReturnType<BlackBoxBrowserRallarRuntimeDependency['rtcCapture']>;
        let reentryFired = false;
        clock.mockImplementation(() => {
            const now = realNow();
            const receipt = facade.rtcCapture();
            if (!reentryFired && receipt && facade.isConnected()) {
                originalReceipt = receipt;
                reentryFired = true;
                vi.mocked(auth.readSession).mockReturnValue(undefined);
            }
            return now;
        });
        try {
            const result = await runtime.execute({
                kind: 'recipe.run',
                rtcCaptureMode: 'off',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'clock-session-ended',
                    commands: [
                        { kind: 'configure', config: { rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app' } } },
                        { kind: 'rtc.connect' }
                    ]
                }
            });
            expect(originalReceipt).toMatchObject({
                configuration: { mode: 'off', origin: 'run' },
                application: { status: 'applied', mode: 'off' }
            });
            expect(reentryFired).toBe(true);
            expect(constructionConnected).toBe(true);
            expect(connectedAtRefusal).toBe(true);
            expect(receiptAtRefusal).toBe(originalReceipt);
            expect(completion?.rtcCapture).toEqual({ status: 'observed', value: originalReceipt });
            expect(facade.session()).toBeUndefined();
            expect.soft(result.ok, JSON.stringify(result)).toBe(false);
            expect.soft(JSON.parse(JSON.stringify(runtime.state().commandHistory.find((entry) => entry.kind === 'rtc.connect')))).toMatchObject({
                status: 'failed',
                error: {
                    code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                    details: {
                        reason: 'session-not-current',
                        requestedConfiguration: { mode: 'off', origin: 'run' },
                        rtcCapture: { status: 'observed', value: originalReceipt }
                    }
                }
            });
            expect.soft(events.filter((event) => event.topic === 'rallar.browser.connect_completed')).toEqual([]);
            expect.soft(JSON.parse(JSON.stringify(events.filter((event) => event.topic === 'rallar.browser.connect_failed')))).toEqual(
                expect.arrayContaining([expect.objectContaining({
                    connection: 'default',
                    error: expect.objectContaining({
                        code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                        reason: 'session-not-current',
                        requestedConfiguration: { mode: 'off', origin: 'run' },
                        rtcCapture: { status: 'observed', value: originalReceipt }
                    })
                })])
            );
        }
        finally {
            await page.close();
        }
    });

    it('required connect preserves canonical refusal when observed SDK lifecycle clock closes its page', async () => {
        const realNow = Date.now;
        const clock = vi.spyOn(Date, 'now');
        const { facade, page, runtime, events } = createRuntime();
        let originalReceipt: ReturnType<BlackBoxBrowserRallarRuntimeDependency['rtcCapture']>;
        let constructionConnected = false;
        let closing: ReturnType<BlackBoxRallarRuntime['close']> | undefined;
        clock.mockImplementation(() => {
            const now = realNow();
            const receipt = facade.rtcCapture();
            if (!closing && receipt && facade.isConnected()) {
                originalReceipt = receipt;
                constructionConnected = facade.isConnected();
                closing = page.close();
            }
            return now;
        });
        try {
            const result = await runtime.execute({
                kind: 'recipe.run',
                rtcCaptureMode: 'off',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'sdk-clock-page-closed',
                    commands: [
                        { kind: 'configure', config: { rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app' } } },
                        { kind: 'rtc.connect' }
                    ]
                }
            });
            expect(originalReceipt).toMatchObject({
                configuration: { mode: 'off', origin: 'run' },
                application: { status: 'applied', mode: 'off' }
            });
            expect(constructionConnected).toBe(true);
            expect(closing).toBeDefined();
            await closing;
            expect.soft(result.ok, JSON.stringify(result)).toBe(false);
            expect.soft(JSON.parse(JSON.stringify(runtime.state().commandHistory.find((entry) => entry.kind === 'rtc.connect')))).toMatchObject({
                status: 'failed',
                error: {
                    code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                    details: {
                        reason: 'operation-not-current',
                        requestedConfiguration: { mode: 'off', origin: 'run' },
                        rtcCapture: { status: 'observed', value: originalReceipt }
                    }
                }
            });
            expect.soft(events.filter((event) => event.topic === 'rallar.browser.connect_completed')).toEqual([]);
            expect.soft(JSON.parse(JSON.stringify(events.filter((event) => event.topic === 'rallar.browser.connect_failed')))).toEqual(
                expect.arrayContaining([expect.objectContaining({
                    connection: 'default',
                    error: expect.objectContaining({
                        code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                        reason: 'operation-not-current',
                        requestedConfiguration: { mode: 'off', origin: 'run' },
                        rtcCapture: { status: 'observed', value: originalReceipt }
                    })
                })])
            );
        }
        finally {
            await page.close();
        }
    });

    it.each([
        { scenario: 'required Off room-await closure retains canonical refusal', required: true },
        { scenario: 'omitted-intent room-await closure retains ordinary cancellation', required: false }
    ])('$scenario', async ({ required }) => {
        const { facade, page, runtime, events } = createRuntime();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let originalReceipt: ReturnType<BlackBoxBrowserRallarRuntimeDependency['rtcCapture']>;
        let constructionConnected = false;
        vi.spyOn(facade.rooms, 'join').mockImplementation(async () => {
            originalReceipt = facade.rtcCapture();
            constructionConnected = facade.isConnected();
            entered.resolve();
            await release.promise;
        });
        try {
            const executing = runtime.execute({
                kind: 'recipe.run',
                rtcCaptureMode: required ? 'off' : undefined,
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'pending-room-page-closed',
                    commands: [
                        { kind: 'configure', config: { rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app', workspaceId: 'workspace' } } },
                        { kind: 'rtc.connect', roomId: 'room' }
                    ]
                }
            });
            await entered.promise;
            const closing = page.close();
            release.resolve();
            const result = await executing;
            expect(await closing).toMatchObject({ status: 'closed', disconnected: true });
            expect(originalReceipt).toMatchObject({ application: { status: 'applied' }, connectionId: { status: 'observed' } });
            expect(constructionConnected).toBe(true);
            expect(facade.isConnected()).toBe(false);
            expect(result.ok, JSON.stringify(result)).toBe(false);
            expect(events.filter((event) => event.topic === 'rallar.browser.connect_completed')).toEqual([]);
            const history = JSON.parse(JSON.stringify(runtime.state().commandHistory.find((entry) => entry.kind === 'rtc.connect')));
            const failures = JSON.parse(JSON.stringify(events.filter((event) => event.topic === 'rallar.browser.connect_failed')));
            if (required) {
                expect(originalReceipt).toMatchObject({
                    configuration: { mode: 'off', origin: 'run' },
                    application: { status: 'applied', mode: 'off' }
                });
                expect.soft(history).toMatchObject({
                    status: 'failed',
                    error: {
                        code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                        details: {
                            reason: 'operation-not-current',
                            requestedConfiguration: { mode: 'off', origin: 'run' },
                            rtcCapture: { status: 'observed', value: originalReceipt }
                        }
                    }
                });
                expect.soft(failures).toEqual(expect.arrayContaining([expect.objectContaining({
                    connection: 'default',
                    error: expect.objectContaining({
                        code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                        reason: 'operation-not-current',
                        requestedConfiguration: { mode: 'off', origin: 'run' },
                        rtcCapture: { status: 'observed', value: originalReceipt }
                    })
                })]));
            }
            else {
                expect(history).toMatchObject({
                    status: 'failed',
                    error: {
                        code: 'RALLAR_BLACK_BOX_COMMAND_FAILED',
                        message: expect.stringContaining('cancelled'),
                        details: { name: 'Error' }
                    }
                });
                expect(failures).toEqual(expect.arrayContaining([expect.objectContaining({
                    connection: 'default',
                    error: expect.objectContaining({ name: 'Error', message: expect.stringContaining('cancelled') })
                })]));
                expect(history.error.details).not.toHaveProperty('rtcCapture');
                expect(failures[0].error).not.toHaveProperty('code');
            }
        }
        finally {
            release.resolve();
            await page.close();
        }
    });

    it('required room connect refuses replaced SDK middleware with its original receipt', async () => {
        const { facade, page, runtime, events, targetWindow } = createRuntime();
        let originalCompletion: BlackBoxBrowserRallarRuntimeDependency.ConnectCompletion | undefined;
        let replacementCompletion: BlackBoxBrowserRallarRuntimeDependency.ConnectCompletion | undefined;
        let originalSession: ReturnType<BlackBoxBrowserRallarRuntimeDependency['session']>;
        let replacementSession: ReturnType<BlackBoxBrowserRallarRuntimeDependency['session']>;
        let originalConnected = false;
        let replacementConnected = false;
        let latestReceiptAtRefusal: ReturnType<BlackBoxBrowserRallarRuntimeDependency['rtcCapture']>;
        const connect = facade.connect;
        vi.spyOn(facade, 'connect').mockImplementation(async (options) => {
            originalCompletion = await connect(options);
            originalSession = facade.session();
            originalConnected = facade.isConnected();
            return originalCompletion;
        });
        vi.spyOn(facade.rooms, 'join').mockImplementation(async () => {
            await facade.disconnect();
            replacementCompletion = await connect({ rtcCaptureContext: { run: 'off' } });
            replacementSession = facade.session();
            replacementConnected = facade.isConnected();
        });
        targetWindow.__blackBoxRallarEmit = (event) => {
            events.push(event);
            if (event.topic === 'rallar.browser.connect_failed') {
                latestReceiptAtRefusal = facade.rtcCapture();
            }
        };
        try {
            const result = await runtime.execute({
                kind: 'recipe.run',
                rtcCaptureMode: 'off',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'room-sdk-replaced',
                    commands: [
                        { kind: 'configure', config: { rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app', workspaceId: 'workspace' } } },
                        { kind: 'rtc.connect', roomId: 'room' }
                    ]
                }
            });
            const originalReceipt = originalCompletion?.rtcCapture.status === 'observed' ? originalCompletion.rtcCapture.value : undefined;
            const replacementReceipt = replacementCompletion?.rtcCapture.status === 'observed' ? replacementCompletion.rtcCapture.value : undefined;
            expect(originalReceipt).toMatchObject({
                configuration: { mode: 'off', origin: 'run' },
                application: { status: 'applied', mode: 'off' },
                connectionId: { status: 'observed' }
            });
            expect(replacementReceipt).toMatchObject({
                configuration: { mode: 'off', origin: 'run' },
                application: { status: 'applied', mode: 'off' },
                connectionId: { status: 'observed' }
            });
            expect(replacementReceipt?.connectionId).not.toEqual(originalReceipt?.connectionId);
            expect(originalConnected).toBe(true);
            expect(replacementConnected).toBe(true);
            expect(originalSession?.sessionId).toBe('session');
            expect(replacementSession).toEqual(originalSession);
            expect(latestReceiptAtRefusal).toBe(replacementReceipt);
            expect.soft(result.ok, JSON.stringify(result)).toBe(false);
            expect.soft(JSON.parse(JSON.stringify(runtime.state().commandHistory.find((entry) => entry.kind === 'rtc.connect')))).toMatchObject({
                status: 'failed',
                error: {
                    code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                    details: {
                        reason: 'middleware-not-current',
                        requestedConfiguration: { mode: 'off', origin: 'run' },
                        rtcCapture: { status: 'observed', value: originalReceipt }
                    }
                }
            });
            expect.soft(events.filter((event) => event.topic === 'rallar.browser.connect_completed')).toEqual([]);
            expect.soft(JSON.parse(JSON.stringify(events.filter((event) => event.topic === 'rallar.browser.connect_failed')))).toEqual(
                expect.arrayContaining([expect.objectContaining({
                    connection: 'default',
                    error: expect.objectContaining({
                        code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                        reason: 'middleware-not-current',
                        requestedConfiguration: { mode: 'off', origin: 'run' },
                        rtcCapture: { status: 'observed', value: originalReceipt }
                    })
                })])
            );
        }
        finally {
            await page.close();
        }
    });

    it.each([
        { scenario: 'non-reentrant room completion starts genuine readiness', closePage: false },
        { scenario: 'closed room completion refuses before readiness starts', closePage: true }
    ])('$scenario', async ({ closePage }) => {
        const { facade, page, runtime, events, targetWindow } = createRuntime();
        let originalReceipt: ReturnType<BlackBoxBrowserRallarRuntimeDependency['rtcCapture']>;
        let closing: ReturnType<BlackBoxRallarRuntime['close']> | undefined;
        vi.spyOn(facade.rooms, 'join').mockResolvedValue();
        vi.spyOn(facade, 'refreshRoomState').mockResolvedValue();
        targetWindow.__blackBoxRallarEmit = (event) => {
            events.push(event);
            if (event.topic === 'rallar.browser.connect_completed') {
                originalReceipt = facade.rtcCapture();
                if (closePage) {
                    closing = page.close();
                }
            }
        };
        try {
            const result = await runtime.execute({
                kind: 'recipe.run',
                rtcCaptureMode: 'off',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'room-measurement-start',
                    commands: [
                        { kind: 'configure', config: { rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app', workspaceId: 'workspace' } } },
                        { kind: 'rtc.connect', roomId: 'room', readiness: { minReadyPeers: 1, timeoutMs: 100, intervalMs: 10 } }
                    ]
                }
            });
            expect(originalReceipt).toMatchObject({
                configuration: { mode: 'off', origin: 'run' },
                application: { status: 'applied', mode: 'off' }
            });
            expect(JSON.parse(JSON.stringify(events.find((event) => event.topic === 'rallar.browser.connect_completed')))).toMatchObject({
                connection: 'default',
                data: { roomId: 'room', rtcCapture: { status: 'observed', value: originalReceipt } }
            });
            const history = JSON.parse(JSON.stringify(runtime.state().commandHistory.find((entry) => entry.kind === 'rtc.connect')));
            const readinessStarts = runtime.state().events.filter((event) => event.topic === 'rallar.bb.rtc.readiness_wait_started');
            expect(result.ok, JSON.stringify(result)).toBe(false);
            if (closePage) {
                expect(closing).toBeDefined();
                await closing;
                expect(history).toMatchObject({
                    status: 'failed',
                    error: {
                        code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                        details: {
                            reason: 'operation-not-current',
                            requestedConfiguration: { mode: 'off', origin: 'run' },
                            rtcCapture: { status: 'observed', value: originalReceipt }
                        }
                    }
                });
                expect(readinessStarts).toEqual([]);
            }
            else {
                expect(readinessStarts).toEqual(expect.arrayContaining([expect.objectContaining({
                    payload: expect.objectContaining({ data: { minReadyPeers: 1, timeoutMs: 100, intervalMs: 10 } })
                })]));
                expect(history).toMatchObject({
                    status: 'failed',
                    value: {
                        roomId: 'room',
                        rtcCapture: { status: 'observed', value: originalReceipt },
                        readiness: { ready: false, readyPeerIds: [] }
                    },
                    error: { code: 'RALLAR_BB_RTC_READY_TIMEOUT' }
                });
                expect(history.value.readiness.roomRefreshSuccesses).toBeGreaterThan(0);
            }
        }
        finally {
            await page.close();
        }
    });

    it('required connect refuses when separate document read closes its page', async () => {
        const readDocument = vi.fn<BlackBoxRallarConnectionRuntime.Input['readDocument']>();
        const { facade, page, runtime, events } = createRuntime(readDocument);
        let originalReceipt: ReturnType<BlackBoxBrowserRallarRuntimeDependency['rtcCapture']>;
        let closing: ReturnType<BlackBoxRallarRuntime['close']> | undefined;
        readDocument.mockImplementation(() => {
            const receipt = facade.rtcCapture();
            if (!closing && receipt) {
                originalReceipt = receipt;
                closing = page.close();
            }
            return { timeOrigin: 1, origin: 'https://test.invalid' };
        });
        try {
            const result = await runtime.execute({
                kind: 'recipe.run',
                rtcCaptureMode: 'off',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'document-closed-connect',
                    commands: [
                        { kind: 'configure', config: { rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app' } } },
                        { kind: 'rtc.connect' }
                    ]
                }
            });
            expect(originalReceipt).toMatchObject({
                configuration: { mode: 'off', origin: 'run' },
                application: { status: 'applied', mode: 'off' }
            });
            expect(closing).toBeDefined();
            await closing;
            expect(result.ok, JSON.stringify(result)).toBe(false);
            expect(JSON.parse(JSON.stringify(runtime.state().commandHistory.find((entry) => entry.kind === 'rtc.connect')))).toMatchObject({
                status: 'failed',
                error: {
                    code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                    details: {
                        reason: 'operation-not-current',
                        requestedConfiguration: { mode: 'off', origin: 'run' },
                        rtcCapture: { status: 'observed', value: originalReceipt }
                    }
                }
            });
            expect(events.filter((event) => event.topic === 'rallar.browser.connect_completed')).toEqual([]);
        }
        finally {
            await page.close();
        }
    });

    it('preserves actual non-reentrant Off connect evidence through page JSON success', async () => {
        const { facade, page } = createRuntime();
        try {
            const connected = await createSpaBrowserRallarRuntime().connect({
                connection: 'default',
                rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app', rtcCaptureContext: { run: 'off' } }
            });
            expect(JSON.parse(JSON.stringify(connected))).toMatchObject({
                status: 'connected',
                rtcCapture: {
                    status: 'observed',
                    value: {
                        configuration: { mode: 'off', origin: 'run' },
                        application: { status: 'applied', mode: 'off' }
                    }
                }
            });
            expect(connected).toMatchObject({ rtcCapture: { status: 'observed', value: facade.rtcCapture() } });
        }
        finally {
            await page.close();
        }
    });

    it('carries a recipe run override to an already connected WS acquisition', async () => {
        const { page, runtime } = createRuntime();
        try {
            await page.connect({ connection: 'default', rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app', rtcCaptureMode: 'native' } });
            const result = await runtime.execute({
                kind: 'recipe.run',
                rtcCaptureMode: 'off',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'ws-existing',
                    commands: [
                        { kind: 'configure', config: { control: { providerMode: 'browser-rallar' }, rallar: { applicationId: 'app' } } },
                        { kind: 'ws.send', data: { typeId: 'test', topicId: 'app.capture', payload: {} } }
                    ]
                }
            });
            expect(result.ok, JSON.stringify(result)).toBe(false);
        }
        finally {
            await page.close();
        }
    });

    it('refuses incompatible capture passed through the SPA WS operation before sending', async () => {
        const { page } = createRuntime();
        try {
            await page.connect({ connection: 'default', rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app', rtcCaptureMode: 'native' } });
            const bridge = createSpaBrowserRallarRuntime();
            const outcome = await bridge.sendWs?.({ typeId: 'test', topicId: 'app.capture', payload: {} }, { rtcCaptureContext: { run: 'off' } }).then(
                () => ({ sent: true }),
                (error: unknown) => ({ error: toError(error) })
            );
            expect(outcome).toMatchObject({ error: { code: 'new-connection-required', requestedConfiguration: { mode: 'off', origin: 'run' } } });
        }
        finally {
            await page.close();
        }
    });

    it('snapshots separate SPA WS intent before its runtime lookup yields', async () => {
        const { page } = createRuntime();
        try {
            await page.connect({ connection: 'default', rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app', rtcCaptureMode: 'off' } });
            const context: { run: 'off' | 'native'; } = { run: 'off' };
            const sending = createSpaBrowserRallarRuntime().sendWs?.({ typeId: 'test', topicId: 'app.capture', payload: {} }, { rtcCaptureContext: context });
            context.run = 'native';
            expect(await sending).toMatchObject({ rtcCapture: { status: 'observed', value: { configuration: { mode: 'off', origin: 'step' } } } });
        }
        finally {
            await page.close();
        }
    });

    it('returns the acquired Off receipt through the existing page WS result and JSON boundary', async () => {
        const { page, facade } = createRuntime();
        try {
            await page.connect({ connection: 'default', rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app', rtcCaptureMode: 'off' } });
            const result = await page.sendWs({ typeId: 'test', topicId: 'app.capture', payload: { rtcCapture: { status: 'observed', value: 'lookalike' } } });
            expect(JSON.parse(JSON.stringify(result))).toMatchObject({
                rtcCapture: { status: 'observed', value: facade.rtcCapture() },
                message: { rtcCapture: { status: 'observed', value: 'lookalike' } }
            });
        }
        finally {
            await page.close();
        }
    });

    it.each([
        { run: 'off', recipe: 'native', step: 'signaling', app: 'app', mode: 'off', origin: 'run', application: { status: 'applied', mode: 'off' } },
        { run: 'native', recipe: 'off', step: 'off', app: 'app', mode: 'native', origin: 'run', application: { status: 'applied', mode: 'native' } },
        { recipe: 'native', step: 'off', app: 'app', mode: 'off', origin: 'step', application: { status: 'applied', mode: 'off' } },
        { recipe: 'native', app: 'app', mode: 'native', origin: 'recipe', application: { status: 'applied', mode: 'native' } },
        { app: 'app', mode: 'signaling', origin: 'product-default', application: { status: 'applied', mode: 'signaling' } },
        { mode: 'off', origin: 'product-default', application: { status: 'applied', mode: 'off' } },
        { run: 'native', mode: 'native', origin: 'run', application: { status: 'unavailable', reason: 'sink-unavailable' } }
    ])('constructs $mode/$origin and exposes the actual public receipt', async (selection) => {
        const { facade, page, runtime } = createRuntime();
        let completion: BlackBoxBrowserRallarRuntimeDependency.ConnectCompletion | undefined;
        let constructionConnected = false;
        const connect = facade.connect;
        vi.spyOn(facade, 'connect').mockImplementation(async (options) => {
            completion = await connect(options);
            constructionConnected = facade.isConnected();
            return completion;
        });
        const decoded = parseControlServerMessage(
            JSON.stringify({
                kind: 'command',
                protocolVersion: 1,
                runId: 'run',
                agentId: 'agent',
                commandId: 'wire',
                command: {
                    kind: 'recipe.run',
                    rtcCaptureMode: selection.run,
                    recipe: {
                        schemaVersion: 1,
                        recipeId: 'authored',
                        rtcCaptureMode: selection.recipe,
                        commands: [
                            {
                                kind: 'configure',
                                config: { rallar: { apiBaseUrl: 'https://test.invalid', applicationId: selection.app, rtcCaptureMode: selection.step } }
                            },
                            { kind: 'rtc.connect' }
                        ]
                    }
                }
            }),
            { runId: 'run', agentId: 'agent' }
        );
        expect(decoded.ok).toBe(true);
        if (!decoded.ok) {
            throw new Error(decoded.error);
        }
        try {
            const result = await runtime.execute(decoded.envelope.command);
            const originalReceipt = completion?.rtcCapture.status === 'observed' ? completion.rtcCapture.value : undefined;
            expect(constructionConnected).toBe(true);
            expect(originalReceipt).toMatchObject({
                configuration: { mode: selection.mode, origin: selection.origin },
                application: selection.application
            });
            if (selection.application.status === 'unavailable') {
                expect(result.ok, JSON.stringify(result)).toBe(false);
                expect(runtime.state().commandHistory.find((entry) => entry.kind === 'rtc.connect')).toMatchObject({
                    status: 'failed',
                    error: {
                        code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                        details: {
                            reason: 'application-unavailable',
                            requestedConfiguration: { mode: selection.mode, origin: selection.origin },
                            rtcCapture: { status: 'observed', value: originalReceipt }
                        }
                    }
                });
                return;
            }
            expect(result.ok, JSON.stringify(result)).toBe(true);
            expect(runtime.state().commandHistory.find((entry) => entry.kind === 'rtc.connect')?.value).toMatchObject({
                rtcCapture: {
                    status: 'observed',
                    value: { configuration: { mode: selection.mode, origin: selection.origin }, application: selection.application }
                }
            });
        }
        finally {
            await page.close();
        }
    });
    it('queues different source intent while construction is held and rejects it with the actual original receipt', async () => {
        const { page, facade } = createRuntime();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        vi.mocked(connectionHttp.readIceCandidates).mockImplementation(async () => {
            entered.resolve();
            await release.promise;
            return { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 };
        });
        const config = {
            connection: 'default',
            rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app', rtcCaptureContext: { run: 'off' as const } }
        };
        const first = page.connect(config);
        await entered.promise;
        const different = page.connect({ ...config, rallar: { ...config.rallar, rtcCaptureContext: { run: 'native' } } });
        let settled = false;
        const checked = different.then((value) => {
            settled = true;
            return { value };
        }, (error: unknown) => {
            settled = true;
            return { error: toError(error) };
        });
        expect(settled).toBe(false);
        release.resolve();
        try {
            const original = await first;
            expect(await checked).toMatchObject({
                error: {
                    code: 'new-connection-required',
                    requestedConfiguration: { mode: 'native', origin: 'run' },
                    currentReceipt: { status: 'observed', value: { configuration: { mode: 'off', origin: 'run' } } }
                }
            });
            expect(facade.session()?.sessionId).toBe('session');
            const reused = await page.connect({ ...config, rallar: { ...config.rallar, rtcCaptureContext: { recipe: 'off' } } });
            expect(reused.rtcCapture).toEqual(original.rtcCapture);
            expect(connectionHttp.readIceCandidates).toHaveBeenCalledTimes(1);
        }
        finally {
            await page.close();
        }
    });

    it('carries run Off through the WS fallback and retries exactly once', async () => {
        const { page, facade } = createRuntime();
        const send = vi.fn().mockRejectedValueOnce(new Error('Black-box Rallar runtime is not connected.')).mockResolvedValue({ status: 'sent' });
        const runtime = createRallarBlackBoxBrowserTestRuntime({ rallarRuntime: { ...createSpaBrowserRallarRuntime(), sendWs: send } });
        try {
            const result = await runtime.execute({
                kind: 'recipe.run',
                rtcCaptureMode: 'off',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'ws',
                    commands: [
                        {
                            kind: 'configure',
                            config: { control: { providerMode: 'browser-rallar' }, apiBaseUrl: 'https://test.invalid', rallar: { applicationId: 'app' } }
                        },
                        { kind: 'ws.send', data: { typeId: 'hello', topicId: 'capture', payload: {} } }
                    ]
                }
            });
            expect(result.ok, JSON.stringify(result)).toBe(true);
            expect(facade.rtcCapture()?.configuration).toEqual({ mode: 'off', origin: 'run' });
            expect(send).toHaveBeenCalledTimes(2);
        }
        finally {
            await page.close();
        }
    });

    it.each(['fresh', 'existing', 'no-api', 'local-only'] as const)('carries capture into the %s CRDT path', async (path) => {
        const { page, facade, runtime } = createRuntime();
        if (path === 'existing' || path === 'no-api') {
            await page.connect({ connection: 'default', rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app', rtcCaptureMode: 'off' } });
        }
        try {
            const command = {
                kind: 'crdt.open' as const,
                name: 'capture',
                applicationId: 'app',
                apiBaseUrl: path === 'no-api' ? undefined : 'https://test.invalid',
                transport: path === 'local-only' ? 'local-only' as const : 'ws' as const,
                persist: false,
                tabSync: false
            };
            if (path === 'existing' || path === 'no-api') {
                await expect(page.crdt.open({ ...command, rallar: { rtcCaptureContext: { run: 'native' } } })).rejects.toMatchObject({
                    code: 'new-connection-required',
                    requestedConfiguration: { mode: 'native', origin: 'run' }
                });
                expect(facade.rtcCapture()?.configuration).toEqual({ mode: 'off', origin: 'step' });
            }
            else {
                const result = await runtime.execute({
                    kind: 'recipe.run',
                    rtcCaptureMode: 'native',
                    recipe: { schemaVersion: 1, recipeId: 'crdt', commands: [command] }
                });
                expect(result.ok, JSON.stringify(result)).toBe(true);
                expect(runtime.state().commandHistory.find((entry) => entry.kind === 'crdt.open')?.value).toMatchObject({
                    rtcCapture: path === 'fresh'
                        ? { status: 'observed', value: { configuration: { mode: 'native', origin: 'run' } } }
                        : { status: 'unavailable', reason: 'not-applicable' }
                });
                expect(facade.rtcCapture()?.configuration).toEqual(path === 'fresh' ? { mode: 'native', origin: 'run' } : undefined);
                expect(connectionHttp.readIceCandidates).toHaveBeenCalledTimes(path === 'fresh' ? 1 : 0);
            }
        }
        finally {
            await page.close();
        }
    });

    it('preserves host selection and actual pending receipt across compatible direct SDK acquisition', async () => {
        const { facade, page } = createRuntime();
        facade.setDefaults({ applicationId: 'app', rtc: { captureMode: 'native' }, diagnosticsPorts: { signalingDiagnostics: () => {} } });
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        vi.mocked(connectionHttp.readIceCandidates).mockImplementation(async () => {
            entered.resolve();
            await release.promise;
            return { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 };
        });
        const first = facade.connect();
        await entered.promise;
        expect(facade.rtcCapture()).toBeUndefined();
        const compatible = facade.connect({ rtcCaptureContext: { run: 'native' } });
        await expect(facade.connect({ rtcCaptureContext: { run: 'off' } })).rejects.toMatchObject({
            code: 'new-connection-required',
            currentReceipt: { status: 'unavailable', reason: 'absent' },
            requestedConfiguration: { mode: 'off', origin: 'run' }
        });
        release.resolve();
        try {
            await Promise.all([first, compatible]);
            const original = facade.rtcCapture();
            expect(original?.configuration).toEqual({ mode: 'native', origin: 'host' });
            expect(JSON.parse(JSON.stringify(original))).toEqual(original);
            expect(connectionHttp.readIceCandidates).toHaveBeenCalledTimes(1);
            await facade.disconnect();
            await facade.connect({ rtcCaptureContext: { run: 'off' } });
            expect(facade.rtcCapture()?.configuration).toEqual({ mode: 'off', origin: 'run' });
            expect(facade.rtcCapture()?.connectionId).not.toEqual(original?.connectionId);
        }
        finally {
            await page.close();
        }
    });

    it('captures direct adapter intent before asynchronous authentication and construction', async () => {
        const { facade, page } = createRuntime();
        const run: { run: 'off' | 'native'; } = { run: 'off' };
        const pending = page.connect({ connection: 'default', rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app', rtcCaptureContext: run } });
        run.run = 'native';
        try {
            await pending;
            expect(facade.rtcCapture()?.configuration).toEqual({ mode: 'off', origin: 'run' });
        }
        finally {
            await page.close();
        }
    });
    it('captures supported page CRDT context before live connection awaits', async () => {
        const { facade, page } = createRuntime();
        const context: { run: 'off' | 'native'; } = { run: 'off' };
        const pending = page.crdt.open({
            name: 'immutable-page-context',
            applicationId: 'app',
            apiBaseUrl: 'https://test.invalid',
            transport: 'ws',
            persist: false,
            tabSync: false,
            rallar: { rtcCaptureContext: context }
        });
        context.run = 'native';
        try {
            expect(await pending).toMatchObject({
                rtcCapture: { status: 'observed', value: { configuration: { mode: 'off', origin: 'run' } } }
            });
            expect(facade.rtcCapture()?.configuration).toEqual({ mode: 'off', origin: 'run' });
        }
        finally {
            await page.close();
        }
    });
});
