import {
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import * as stores from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import * as middleware from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import type { RallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import * as rtc from '@shared-web/browser/rtc/initialise-browser-rtc-runtime.ts';
import * as ws from '@shared/services/ws-queue-box-client-service.ts';

import {
    createCaptureApplicationRuntime,
    installCaptureApplicationTestEnvironment
} from './capture-application-test-runtime.ts';

interface ReplacedAlmPortCase {
    readonly operation: 'connect' | 'crdt';
    readonly port: keyof Pick<RallarDiagnosticsPorts, 'outboundDiagnostics' | 'inboundDiagnostics' | 'storage'>;
}

const REPLACED_ALM_PORT_CASES: readonly ReplacedAlmPortCase[] = [
    { operation: 'connect', port: 'outboundDiagnostics' },
    { operation: 'connect', port: 'inboundDiagnostics' },
    { operation: 'connect', port: 'storage' },
    { operation: 'crdt', port: 'outboundDiagnostics' },
    { operation: 'crdt', port: 'inboundDiagnostics' },
    { operation: 'crdt', port: 'storage' }
];

installCaptureApplicationTestEnvironment();

it.each([undefined, true, false])('keeps the actual SDK run-Off receipt independent of ALM recording %s', async (almDiagnostics) => {
    const { page, facade, events } = createCaptureApplicationRuntime();
    try {
        const connected = await page.connect({
            connection: 'sdk-alm',
            rallar: {
                apiBaseUrl: 'https://test.invalid',
                applicationId: 'app',
                almDiagnostics,
                rtc: { captureMode: 'native' },
                rtcCaptureContext: { run: 'off' }
            }
        });
        expect(connected.rtcCapture).toMatchObject({
            status: 'observed',
            value: {
                configuration: { mode: 'off', origin: 'run' },
                application: { status: 'applied', mode: 'off' }
            }
        });
        expect(facade.rtcCapture()?.configuration).toEqual({ mode: 'off', origin: 'run' });
        expect(events).toContainEqual(expect.objectContaining({
            topic: 'rallar.browser.connect.phase_completed',
            data: expect.objectContaining({ phase: 'rallar-connect', almDiagnostics: almDiagnostics !== false })
        }));
        expect(events.filter((event) => event.topic === 'rallar.browser.rtc.signaling_diagnostics')).toEqual([]);
        if (almDiagnostics === false) {
            expect(events.filter((event) => event.topic.startsWith('rallar.browser.alm.'))).toEqual([]);
        }
    }
    finally {
        await page.close();
    }
});

it.each(REPLACED_ALM_PORT_CASES.flatMap((testCase) => [true, false].map((almDiagnostics) => ({ ...testCase, almDiagnostics }))))(
    'refuses unverified $operation application when external $port replaces prepared $almDiagnostics',
    async ({ operation, port, almDiagnostics }) => {
        const { page, facade, targetWindow, events } = createCaptureApplicationRuntime();
        onTestFinished(async () => {
            await page.close();
        });
        const consumed = observeConsumedDiagnosticsPorts();
        const defaults = vi.spyOn(facade, 'setDefaults');
        const prepared = Promise.withResolvers<void>();
        const publish = targetWindow.__blackBoxRallarEmit;
        targetWindow.__blackBoxRallarEmit = (event) => {
            void publish?.(event);
            if (
                event.topic === 'rallar.browser.crdt.configure_started' ||
                (event.topic === 'rallar.browser.connect.phase_completed' &&
                    typeof event.data === 'object' && event.data !== null &&
                    'phase' in event.data && event.data.phase === 'configure')
            ) {
                prepared.resolve();
            }
        };
        const config = {
            connection: 'application',
            rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app', workspaceId: 'default', almDiagnostics }
        };
        const acquisition = (operation === 'connect'
            ? page.connect(config)
            : page.crdt.open({
                name: 'application',
                transport: 'ws',
                apiBaseUrl: config.rallar.apiBaseUrl,
                applicationId: 'app',
                workspaceId: 'default',
                rallar: { almDiagnostics },
                persist: false,
                tabSync: false
            }))
            .then(() => undefined, (error: Error) => error);
        await prepared.promise;
        const preparedDefaults = defaults.mock.calls.at(-1)?.[0];
        if (!preparedDefaults?.diagnosticsPorts) {
            throw new Error('The scoped harness did not prepare its diagnostics ports.');
        }
        const externalSink = () => {};
        facade.setDefaults({ ...preparedDefaults, diagnosticsPorts: { ...preparedDefaults.diagnosticsPorts, [port]: externalSink } });
        const external = facade.connect();
        const error = await acquisition;
        const completion = await external;
        expect(completion.diagnosticsPorts).toBe(consumed[0]);
        expect(Object.isFrozen(completion.diagnosticsPorts)).toBe(true);
        expect(consumed[0]?.[port]).toBe(externalSink);
        expect(error).toBeInstanceOf(Error);
        expect(error?.message).toMatch(/unverified.*close.*reinitializ/i);
        const writes = defaults.mock.calls.length;
        await expect(page.connect(config)).rejects.toThrow(/unverified.*close.*reinitializ/i);
        expect(defaults.mock.calls).toHaveLength(writes);
        expect(events.filter((event) => typeof event.data === 'object' && event.data !== null && 'almDiagnostics' in event.data)).toEqual([]);
    }
);

it.each([undefined, true, false])('preserves unscoped acquisition and reuse without certifying ALM intent %s', async (almDiagnostics) => {
    const { page, facade, events } = createCaptureApplicationRuntime();
    onTestFinished(async () => {
        await page.close();
    });
    const defaults = vi.spyOn(facade, 'setDefaults');
    const config = { connection: 'unscoped', rallar: { apiBaseUrl: 'https://test.invalid', almDiagnostics } };
    await page.connect(config);
    expect(defaults).toHaveBeenCalledWith(undefined);
    const writes = defaults.mock.calls.length;
    const receipt = facade.rtcCapture();
    await page.connect(config);
    expect(defaults.mock.calls).toHaveLength(writes);
    expect(facade.rtcCapture()).toBe(receipt);
    expect(events.filter((event) => typeof event.data === 'object' && event.data !== null && 'almDiagnostics' in event.data)).toEqual([]);
});

function observeConsumedDiagnosticsPorts(): RallarDiagnosticsPorts[] {
    const consumed: RallarDiagnosticsPorts[] = [];
    const storage = vi.spyOn(stores, 'configureBrowserALRuntimeStores');
    const volatileStorage = vi.spyOn(stores, 'createBrowserALVolatileInboundRuntimeStores');
    const wsClient = vi.spyOn(ws, 'createDefaultWsQueueBoxClientService');
    const rtcReceiver = vi.spyOn(rtc, 'initialiseRtcRxStreamer');
    const initialise = middleware.initialiseMiddleware;
    vi.spyOn(middleware, 'initialiseMiddleware').mockImplementation(async (...args) => {
        const connected = await initialise(...args);
        const ports = args[2].diagnosticsPorts;
        expect(connected.middleware.outboundDiagnostics).toBe(ports.outboundDiagnostics);
        expect(storage.mock.calls[0]?.[1].diagnosticsPorts.storage).toBe(ports.storage);
        expect(volatileStorage.mock.calls[0]?.[2]).toBe(ports.storage);
        expect(wsClient.mock.calls[0]?.[0].outboundDiagnostics).toBe(ports.outboundDiagnostics);
        expect(wsClient.mock.calls[0]?.[0].inboundDiagnostics).toBe(ports.inboundDiagnostics);
        expect(rtcReceiver.mock.calls[0]?.[0].inboundDiagnostics).toBe(ports.inboundDiagnostics);
        consumed.push(ports);
        return connected;
    });
    return consumed;
}
