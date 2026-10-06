import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

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
import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMessageSelectorInput } from '@shared-web/browser/messages/rallar-message-selectors.ts';
import * as heartbeat from '@shared-web/browser/session/browser-session-heartbeat.ts';
import * as snapshots from '@shared-web/browser/state-read/refresh-state-snapshots.ts';
import * as auth from '@shared/api/auth.ts';
import { isRallarCrdtDocumentRef, type RallarCrdtMetricEvent } from '@shared/crdt/mod.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import '../../setup-browser-indexeddb.ts';
import { createHttpCatchUpResponse } from '../../shared-web/crdt/rallar-crdt-test-runtime.ts';
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

interface HydratedCrdtSubscription {
    readonly selector: RallarMessageSelectorInput;
    readonly ownershipFailure: ReturnType<BlackBoxBrowserRallarRuntimeDependency.ConnectCompletion['captureOwnershipFailure']>;
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
        const { page, runtime, events } = createRuntime();
        try {
            const connected = await page.connect({
                connection: 'default',
                rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app', rtcCaptureMode: 'native' }
            });
            expect(connected).toMatchObject({
                status: 'connected',
                rtcCapture: {
                    status: 'observed',
                    value: {
                        configuration: { mode: 'native', origin: 'step' },
                        application: { status: 'applied', mode: 'native' },
                        connectionId: { status: 'observed' }
                    }
                }
            });
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
            console.info(
                'recipe WS override readback',
                JSON.stringify({
                    original: connected.rtcCapture,
                    command: runtime.state().commandHistory.find((entry) => entry.kind === 'ws.send'),
                    refusals: events.filter((event) => event.topic === 'rallar.browser.ws.send_failed')
                })
            );
            expect(result).toMatchObject({
                value: {
                    results: expect.arrayContaining([expect.objectContaining({
                        kind: 'ws.send',
                        status: 'failed',
                        ok: false,
                        error: expect.objectContaining({ code: 'RALLAR_BLACK_BOX_COMMAND_FAILED' })
                    })])
                }
            });
            expect(events.filter((event) => event.topic === 'rallar.browser.ws.send_failed')).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    connection: 'default',
                    data: expect.objectContaining({ transport: 'ws', typeId: 'test', topicId: 'app.capture' }),
                    error: expect.objectContaining({
                        code: 'new-connection-required',
                        requestedConfiguration: { mode: 'off', origin: 'run' },
                        currentConfiguration: { mode: 'native', origin: 'step' },
                        currentReceipt: connected.rtcCapture
                    })
                })
            ]));
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

    it.each(
        [
            {
                scenario: 'required Off refuses initial CRDT subscriptions after hydrate metric invalidates its original session',
                mode: 'off',
                invalidate: true
            },
            { scenario: 'applied Off preserves initial CRDT subscriptions through a non-reentrant hydrate metric', mode: 'off', invalidate: false },
            { scenario: 'applied Native preserves initial CRDT subscriptions through a non-reentrant hydrate metric', mode: 'native', invalidate: false },
            { scenario: 'omitted intent preserves initial CRDT subscriptions through a non-reentrant hydrate metric', mode: undefined, invalidate: false }
        ] as const
    )('fences initial live CRDT hydrate subscriptions: $scenario', async ({ mode, invalidate }) => {
        const { page, facade, events } = createRuntime();
        const session = auth.readSession();
        const subscriptions: HydratedCrdtSubscription[] = [];
        const unsubscribes: Array<() => void> = [];
        const metrics: RallarCrdtMetricEvent[] = [];
        let callbackConnected = false;
        let ownershipBeforeMetric: ReturnType<BlackBoxBrowserRallarRuntimeDependency.ConnectCompletion['captureOwnershipFailure']>;
        let ownershipAfterMetric: ReturnType<BlackBoxBrowserRallarRuntimeDependency.ConnectCompletion['captureOwnershipFailure']>;
        try {
            facade.configure({ apiBaseUrl: 'https://test.invalid' });
            facade.setDefaults({ applicationId: 'app', diagnosticsPorts: { signalingDiagnostics: () => {} } });
            const capture = mode ? { rtcCaptureContext: { run: mode } } : {};
            const completion = await facade.connect(capture);
            expect(completion.rtcCapture).toMatchObject({
                status: 'observed',
                value: {
                    application: { status: 'applied', ...(mode ? { mode } : {}) },
                    ...(mode ? { configuration: { mode, origin: 'run' } } : {}),
                    connectionId: { status: 'observed' }
                }
            });
            expect(Object.isFrozen(completion.rtcCapture)).toBe(true);
            expect(completion.captureOwnershipFailure()).toBeUndefined();
            expect(facade.isConnected()).toBe(true);
            const subscribe = facade.messages.ws.onMessage;
            vi.spyOn(facade.messages.ws, 'onMessage').mockImplementation((selector, handler) => {
                const unsubscribe = subscribe(selector, handler);
                subscriptions.push({ selector, ownershipFailure: completion.captureOwnershipFailure() });
                unsubscribes.push(unsubscribe);
                return unsubscribe;
            });
            const open = facade.crdt.open;
            vi.spyOn(facade.crdt, 'open').mockImplementation(async (name, options) =>
                await open(name, {
                    ...options,
                    metrics: {
                        record: (event) => {
                            metrics.push(event);
                            if (event.name === 'crdt.merge.replay.ms') {
                                callbackConnected = facade.isConnected();
                                ownershipBeforeMetric = completion.captureOwnershipFailure();
                                if (invalidate) {
                                    vi.mocked(auth.readSession).mockReturnValue(undefined);
                                }
                                ownershipAfterMetric = completion.captureOwnershipFailure();
                            }
                        }
                    }
                })
            );
            const outcome = await page.crdt.open({
                name: `hydrate-session-${mode ?? 'omitted'}-${invalidate}`,
                applicationId: 'app',
                workspaceId: 'main',
                transport: 'ws',
                persist: false,
                tabSync: false,
                initialValue: { title: 'hydrated' },
                ...(mode ? { rallar: capture } : {})
            }).then((value) => ({ value }), (caught: unknown) => ({ error: toError(caught) }));
            console.info(
                'hydrate session subscription readback',
                JSON.stringify({
                    mode,
                    invalidate,
                    original: completion.rtcCapture,
                    callbackConnected,
                    ownershipBeforeMetric: ownershipBeforeMetric ?? 'current',
                    ownershipAfterMetric: ownershipAfterMetric ?? 'current',
                    metrics,
                    subscriptions,
                    outcome,
                    failures: events.filter((event) => event.topic === 'rallar.browser.crdt.open_failed')
                })
            );
            expect(metrics).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'crdt.merge.replay.ms' })]));
            expect(callbackConnected).toBe(true);
            expect(ownershipBeforeMetric).toBeUndefined();
            expect(ownershipAfterMetric).toBe(invalidate ? 'session-not-current' : undefined);
            if (invalidate) {
                expect.soft(outcome).toMatchObject({
                    error: {
                        code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                        reason: 'session-not-current',
                        requestedConfiguration: { mode: 'off', origin: 'run' },
                        rtcCapture: completion.rtcCapture
                    }
                });
                // Required initial subscription eligibility forbids these actual document-protocol registrations.
                expect.soft(subscriptions.filter(({ selector }) =>
                    typeof selector !== 'string' && (
                        selector.typeId === 'rallar.crdt.update.v1' || selector.typeId === 'rallar.crdt.sync-request.v1' ||
                        selector.typeId === 'rallar.crdt.catch-up-response.v1'
                    )
                )).toEqual([]);
                expect.soft(events.filter((event) => event.topic === 'rallar.browser.crdt.opened')).toEqual([]);
            }
            else {
                expect(outcome).toMatchObject({ value: { status: 'opened', value: { title: 'hydrated' }, rtcCapture: completion.rtcCapture } });
                expect(subscriptions).toEqual(expect.arrayContaining([
                    expect.objectContaining({ selector: expect.objectContaining({ typeId: 'rallar.crdt.update.v1' }), ownershipFailure: undefined }),
                    expect.objectContaining({ selector: expect.objectContaining({ typeId: 'rallar.crdt.sync-request.v1' }), ownershipFailure: undefined })
                ]));
                await expect(page.crdt.read({ handle: `hydrate-session-${mode ?? 'omitted'}-${invalidate}` })).resolves.toMatchObject({
                    value: { title: 'hydrated' }
                });
            }
        }
        finally {
            vi.mocked(auth.readSession).mockReturnValue(session);
            for (const unsubscribe of unsubscribes) {
                unsubscribe();
            }
            await page.close();
            expect(facade.isConnected()).toBe(false);
            console.info(
                'hydrate subscription cleanup readback',
                JSON.stringify({
                    mode,
                    invalidate,
                    releasedSelectors: subscriptions.map(({ selector }) => selector),
                    connected: facade.isConnected()
                })
            );
        }
    });

    it('required Native refuses initial live CRDT effects when its actual SDK application is unavailable', async () => {
        const { page, facade, events } = createRuntime();
        try {
            facade.configure({ apiBaseUrl: 'https://test.invalid' });
            const completion = await facade.connect({ rtcCaptureContext: { run: 'native' } });
            expect(completion.rtcCapture).toMatchObject({
                status: 'observed',
                value: {
                    configuration: { mode: 'native', origin: 'run' },
                    connectionId: { status: 'observed' },
                    application: { status: 'unavailable', reason: 'sink-unavailable' }
                }
            });
            expect(completion.captureOwnershipFailure()).toBeUndefined();
            expect(facade.isConnected()).toBe(true);
            const handles: RallarMessageHandle[] = [];
            const send = facade.messages.ws.send;
            vi.spyOn(facade.messages.ws, 'send').mockImplementation(async (input) => {
                const handle = await send(input);
                handles.push(handle);
                return handle;
            });
            const outcome = await page.crdt.open({
                name: 'unavailable-initial-live',
                applicationId: 'app',
                workspaceId: 'main',
                transport: 'ws',
                persist: false,
                tabSync: false,
                initialValue: { title: 'initial' },
                rallar: { rtcCaptureContext: { run: 'native' } }
            }).then((value) => ({ value }), (caught: unknown) => ({ error: toError(caught) }));
            console.info(
                'initial live unavailable application readback',
                JSON.stringify({
                    completion: completion.rtcCapture,
                    outcome,
                    effects: handles.map((handle) => ({
                        rtcCapture: handle.rtcCapture(),
                        lifecycle: handle.lifecycle()
                    }))
                })
            );
            expect.soft(outcome).toMatchObject({
                error: {
                    code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                    reason: 'application-unavailable',
                    requestedConfiguration: { mode: 'native', origin: 'run' },
                    rtcCapture: completion.rtcCapture
                }
            });
            expect.soft(handles.map((handle) => ({ rtcCapture: handle.rtcCapture(), lifecycle: handle.lifecycle() }))).toEqual([]);
            expect.soft(events.filter((event) => event.topic === 'rallar.browser.crdt.opened')).toEqual([]);
            expect(facade.isConnected()).toBe(true);
            expect(completion.captureOwnershipFailure()).toBeUndefined();
        }
        finally {
            await page.close();
            expect(facade.isConnected()).toBe(false);
        }
    });

    it.each(['off', 'native'] as const)('preserves applied %s initial live CRDT effects and original receipt', async (mode) => {
        const { page, facade } = createRuntime();
        try {
            facade.configure({ apiBaseUrl: 'https://test.invalid' });
            facade.setDefaults({ applicationId: 'app', diagnosticsPorts: { signalingDiagnostics: () => {} } });
            const completion = await facade.connect({ rtcCaptureContext: { run: mode } });
            expect(completion.rtcCapture).toMatchObject({
                status: 'observed',
                value: { configuration: { mode, origin: 'run' }, application: { status: 'applied', mode } }
            });
            expect(completion.captureOwnershipFailure()).toBeUndefined();
            const handles: RallarMessageHandle[] = [];
            const send = facade.messages.ws.send;
            vi.spyOn(facade.messages.ws, 'send').mockImplementation(async (input) => {
                const handle = await send(input);
                handles.push(handle);
                return handle;
            });
            const opened = await page.crdt.open({
                name: `applied-initial-live-${mode}`,
                applicationId: 'app',
                workspaceId: 'main',
                transport: 'ws',
                persist: false,
                tabSync: false,
                initialValue: { title: 'initial' },
                rallar: { rtcCaptureContext: { run: mode } }
            });
            expect(opened).toMatchObject({ status: 'opened', value: { title: 'initial' }, rtcCapture: completion.rtcCapture });
            expect(handles.map((handle) => handle.lifecycle())).toEqual(expect.arrayContaining([
                expect.objectContaining({ typeId: 'rallar.crdt.catch-up-request.v1', evidence: expect.objectContaining({ admittedAtMs: expect.any(Number) }) }),
                expect.objectContaining({ typeId: 'rallar.crdt.sync-request.v1', evidence: expect.objectContaining({ admittedAtMs: expect.any(Number) }) })
            ]));
            for (const handle of handles) {
                expect(handle.rtcCapture()).toEqual(completion.rtcCapture);
                expect(handle.lifecycle()).toMatchObject({ evidence: { admittedAtMs: expect.any(Number) } });
            }
            expect(JSON.parse(JSON.stringify(opened))).toMatchObject({ rtcCapture: completion.rtcCapture });
            const reused = await facade.crdt.open(`applied-initial-live-${mode}`, { applicationId: 'app', workspaceId: 'main' });
            expect(reused.read()).toEqual({ title: 'initial' });
            await expect(page.crdt.read({ handle: `applied-initial-live-${mode}` })).resolves.toMatchObject({ value: { title: 'initial' } });
        }
        finally {
            await page.close();
            expect(facade.isConnected()).toBe(false);
        }
    });

    it('omitted CRDT capture intent preserves live effects with an actual unavailable Native application', async () => {
        const { page, facade } = createRuntime();
        try {
            facade.configure({ apiBaseUrl: 'https://test.invalid' });
            facade.setDefaults({ applicationId: 'app', rtc: { captureMode: 'native' } });
            const completion = await facade.connect();
            expect(completion.rtcCapture).toMatchObject({
                status: 'observed',
                value: { application: { status: 'unavailable', reason: 'sink-unavailable' } }
            });
            const opened = await page.crdt.open({
                name: 'ordinary-unavailable-initial-live',
                applicationId: 'app',
                workspaceId: 'main',
                transport: 'ws',
                persist: false,
                tabSync: false,
                initialValue: { title: 'ordinary' }
            });
            expect(opened).toMatchObject({
                status: 'opened',
                value: { title: 'ordinary' },
                rtcCapture: completion.rtcCapture,
                health: { lastLiveSendStatus: 'sent' }
            });
            await expect(page.crdt.read({ handle: 'ordinary-unavailable-initial-live' })).resolves.toMatchObject({ value: { title: 'ordinary' } });
        }
        finally {
            await page.close();
            expect(facade.isConnected()).toBe(false);
        }
    });

    it('local CRDT capture intent preserves persisted authored state without constructing a live graph', async () => {
        const { page, facade } = createRuntime();
        try {
            const opened = await page.crdt.open({
                name: 'local-capture-control',
                applicationId: 'app',
                workspaceId: 'main',
                transport: 'local-only',
                persist: true,
                tabSync: false,
                initialValue: { title: 'local' },
                rallar: { rtcCaptureContext: { run: 'native' } }
            });
            expect(opened).toMatchObject({
                status: 'opened',
                value: { title: 'local' },
                rtcCapture: { status: 'unavailable', reason: 'not-applicable' }
            });
            expect(facade.isConnected()).toBe(false);
            await page.crdt.apply({
                handle: 'local-capture-control',
                batch: { kind: 'batch', operations: [{ kind: 'map.set', path: [], key: 'title', value: 'persisted' }] }
            });
            await page.crdt.close({ handle: 'local-capture-control' });
            const reopened = await page.crdt.open({
                name: 'local-capture-control',
                applicationId: 'app',
                workspaceId: 'main',
                transport: 'local-only',
                persist: true,
                tabSync: false
            });
            expect(reopened).toMatchObject({ value: { title: 'persisted' } });
            await expect(page.crdt.read({ handle: 'local-capture-control' })).resolves.toMatchObject({ value: { title: 'persisted' } });
        }
        finally {
            await page.close();
            expect(facade.isConnected()).toBe(false);
        }
    });

    it('ordinary HTTP CRDT catch-up preserves durable readback without a live message effect', async () => {
        const { page, facade } = createRuntime();
        try {
            facade.configure({ apiBaseUrl: 'https://test.invalid' });
            facade.setDefaults({ applicationId: 'app' });
            await facade.connect();
            vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
                expect(url).toBe('https://test.invalid/api/crdt/catch-up');
                expect(init.method).toBe('POST');
                const request: unknown = JSON.parse(String(init.body));
                if (
                    typeof request !== 'object' || request === null ||
                    !('requestId' in request) || typeof request.requestId !== 'string' ||
                    !('document' in request) || !isRallarCrdtDocumentRef(request.document)
                ) {
                    throw new TypeError('Expected a complete HTTP catch-up request.');
                }
                return Response.json({ ok: true, result: createHttpCatchUpResponse({ requestId: request.requestId, document: request.document }) });
            });
            const opened = await page.crdt.open({
                name: 'http-capture-control',
                applicationId: 'app',
                workspaceId: 'main',
                scope: { kind: 'custom', customScope: 'http-only' },
                transport: 'ws',
                durableCatchUp: 'http',
                persist: false,
                tabSync: false
            });
            console.info('ordinary HTTP catch-up readback', JSON.stringify(opened));
            expect(opened).toMatchObject({
                status: 'opened',
                value: { title: 'HTTP durable title' },
                health: { lastServerAppendSequence: 1, liveSentUpdateCount: 0 }
            });
            await expect(page.crdt.read({ handle: 'http-capture-control' })).resolves.toMatchObject({ value: { title: 'HTTP durable title' } });
        }
        finally {
            await page.close();
            expect(facade.isConnected()).toBe(false);
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
