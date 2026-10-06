import type { BlackBoxRallarEvent } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import type { BlackBoxRallarRuntime } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts';
import type { RallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/browser/browser-command-contracts.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../setup-browser-indexeddb.ts';

import { createBlackBoxRallarRuntime } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime.ts';
import {
    createBlackBoxBrowserRallarRuntimeDependency,
    type BlackBoxBrowserRallarRuntimeDependency
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts';
import { BlackBoxRallarVolatileLimits } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-volatile-limits.ts';
import { createSpaBrowserRallarRuntime } from '@shared-test/rallar-bb-test/browser-rallar-runtime-bridge.ts';
import { parseControlServerMessage } from '@shared-test/rallar-bb-test/control-protocol.ts';
import { createRallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import * as connectionHttp from '@shared-web/browser/connection/connection-http-api.ts';
import * as heartbeat from '@shared-web/browser/session/browser-session-heartbeat.ts';
import * as snapshots from '@shared-web/browser/state-read/refresh-state-snapshots.ts';
import * as auth from '@shared/api/auth.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';
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
    readonly events: readonly BlackBoxRallarEvent[];
    readonly facade: BlackBoxBrowserRallarRuntimeDependency;
    readonly page: BlackBoxRallarRuntime;
    readonly runtime: RallarBlackBoxBrowserTestRuntime;
}

function createRuntime(): CaptureApplicationRuntime {
    const events: BlackBoxRallarEvent[] = [];
    const volatileLimits = new BlackBoxRallarVolatileLimits();
    const facade = createBlackBoxBrowserRallarRuntimeDependency({ readVolatileSessionLimits: volatileLimits.get });
    const page = createBlackBoxRallarRuntime({
        facade,
        volatileLimits,
        targetWindow: {
            __blackBoxRallarEmit: (event) => {
                events.push(event);
            }
        },
        clock: { now: Date.now },
        readDocument: () => ({ timeOrigin: 1, origin: 'https://test.invalid' }),
        delay: async () => {}
    });
    vi.stubGlobal('window', Object.assign(new EventTarget(), { __blackBoxRallar: page }));
    return { events, facade, page, runtime: createRallarBlackBoxBrowserTestRuntime({ rallarRuntime: createSpaBrowserRallarRuntime() }) };
}

describe('decoded recipe application through the SPA and SDK initializer', () => {
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

    it('retains typed unavailable capture facts in the serialized page refusal event', async () => {
        const { page, facade, events } = createRuntime();
        try {
            await page.connect({ connection: 'default', rallar: { apiBaseUrl: 'https://test.invalid', rtcCaptureMode: 'native' } });
            await expect(page.sendWs({ typeId: 'test', topicId: 'app.capture', payload: {} })).rejects.toMatchObject({ code: 'RALLAR_RTC_CAPTURE_UNVERIFIED' });
            expect(JSON.parse(JSON.stringify(events))).toEqual(expect.arrayContaining([expect.objectContaining({
                topic: 'rallar.browser.ws.send_failed',
                error: expect.objectContaining({
                    code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                    reason: 'application-unavailable',
                    requestedConfiguration: { mode: 'native', origin: 'step' },
                    rtcCapture: { status: 'observed', value: facade.rtcCapture() }
                })
            })]));
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
                (error: unknown) => ({ error })
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
        const { page, runtime } = createRuntime();
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
            return { error };
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
