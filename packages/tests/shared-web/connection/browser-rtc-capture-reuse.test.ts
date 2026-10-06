import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import type { BrowserTransportRuntime } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type { BrowserConnectedMiddleware } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import { createBrowserRtcCapture } from '@shared-web/browser/rtc/create-browser-rtc-capture.ts';
import type { RallarSessionConnectionInput } from '@shared-web/browser/session/session-connection-lifecycle.ts';
import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import { readAuthSessionContractMocks, resetAuthSessionContractMocks } from '../session/browser-auth-session-contract-fixture.ts';

const mocks = readAuthSessionContractMocks();
installFakeBroadcastChannelPerTest();

describe('immutable RTC capture on browser connections', () => {
    beforeEach(resetAuthSessionContractMocks);

    it('keeps a pending selection and rejects incompatible requests before auth invalidation', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const pending = Promise.withResolvers<BrowserConnectedMiddleware>();
        const entered = Promise.withResolvers<void>();
        let constructed: BrowserConnectedMiddleware | undefined;
        let constructions = 0;
        mocks.initialiseMiddleware.mockImplementation(async (_session, _topic, options) => {
            constructions += 1;
            const capture = createBrowserRtcCapture({
                configuration: options.rtcCaptureConfiguration,
                connectionId: { status: 'observed', value: 'first' },
                record: options.diagnosticsPorts.signalingDiagnostics,
                nowEpochMs: () => 10
            });
            constructed = { middleware: mocks.ctx.middleware, checkpoints: [], rtcCaptureReceipt: capture.receipt };
            entered.resolve();
            return pending.promise;
        });
        const facade = createRallarFacade();
        facade.setDefaults({ applicationId: 'app', rtc: { captureMode: 'off' } });
        const first = facade.connect();
        await entered.promise;
        facade.setDefaults({ applicationId: 'app', rtc: { captureMode: 'native' } });
        expect(facade.rtcCapture()).toBeUndefined();
        await expect(facade.connect()).rejects.toMatchObject({
            code: 'new-connection-required',
            requestedConfiguration: { mode: 'native', origin: 'host' },
            currentConfiguration: { mode: 'off', origin: 'host' },
            currentReceipt: { status: 'unavailable', reason: 'absent' }
        });
        expect(mocks.readSession()).toEqual(mocks.ctx.session);
        expect(constructions).toBe(1);
        if (!constructed) {
            throw new Error('Expected the original connection to reach construction');
        }
        pending.resolve(constructed);
        await first;
        const original = facade.rtcCapture();
        expect(original?.configuration).toEqual({ mode: 'off', origin: 'host' });
        await facade.connect({ rtcCaptureMode: 'off' });
        expect(facade.rtcCapture()).toBe(original);
        await expect(facade.connect({ rtcCaptureMode: 'signaling' })).rejects.toMatchObject({
            code: 'new-connection-required',
            currentReceipt: { status: 'observed', value: original }
        });
        expect(constructions).toBe(1);
        await facade.disconnect();
        expect(facade.rtcCapture()).toBeUndefined();
    });

    it('passes explicit step Off over host Native through start and reconnects with a new receipt', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const configurations: Array<{ readonly mode: string; readonly origin: string; }> = [];
        mocks.initialiseMiddleware.mockImplementation(async (_session, _topic, options) => {
            configurations.push(options.rtcCaptureConfiguration);
            return {
                middleware: mocks.ctx.middleware,
                checkpoints: [],
                rtcCaptureReceipt: createBrowserRtcCapture({
                    configuration: options.rtcCaptureConfiguration,
                    connectionId: { status: 'observed', value: String(configurations.length) },
                    record: options.diagnosticsPorts.signalingDiagnostics,
                    nowEpochMs: () => 10
                }).receipt
            };
        });
        const facade = createRallarFacade();
        facade.setDefaults({ applicationId: 'app', rtc: { captureMode: 'native' } });
        await facade.start({ rtcCaptureMode: 'off', refreshRooms: false });
        expect(configurations).toEqual([{ mode: 'off', origin: 'step' }]);
        expect(facade.rtcCapture()?.application).toEqual({ status: 'applied', mode: 'off' });
        await facade.disconnect();
        await facade.connect();
        expect(configurations).toEqual([{ mode: 'off', origin: 'step' }, { mode: 'native', origin: 'host' }]);
        expect(facade.rtcCapture()?.application).toEqual({ status: 'unavailable', reason: 'sink-unavailable' });
        await facade.disconnect();
    });

    it('uses sink-dependent product defaults without application defaults', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const configurations: Array<{ readonly mode: string; readonly origin: string; }> = [];
        mocks.initialiseMiddleware.mockImplementation(async (_session, _topic, options) => {
            configurations.push(options.rtcCaptureConfiguration);
            return {
                middleware: mocks.ctx.middleware,
                checkpoints: [],
                rtcCaptureReceipt: createBrowserRtcCapture({
                    configuration: options.rtcCaptureConfiguration,
                    connectionId: { status: 'unavailable', reason: 'identity-source-absent' },
                    record: options.diagnosticsPorts.signalingDiagnostics,
                    nowEpochMs: () => 10
                }).receipt
            };
        });
        const facade = createRallarFacade();
        await facade.connect();
        expect(facade.rtcCapture()?.configuration).toEqual({ mode: 'off', origin: 'product-default' });
        await facade.disconnect();
        facade.setDefaults({ applicationId: 'app', diagnosticsPorts: { signalingDiagnostics: () => {} } });
        await facade.connect();
        expect(facade.rtcCapture()?.configuration).toEqual({ mode: 'signaling', origin: 'product-default' });
        expect(configurations).toEqual([{ mode: 'off', origin: 'product-default' }, { mode: 'signaling', origin: 'product-default' }]);
        await facade.disconnect();
    });

    it('rejects a sibling facade change without invoking authentication invalidation', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const { BrowserSessionAuthLifecycle } = await import('@shared-web/browser/session/session-auth-lifecycle.ts');
        const invalidations: Error[] = [];
        vi.spyOn(BrowserSessionAuthLifecycle.prototype, 'endUnauthorizedSession').mockImplementation(async (error) => {
            invalidations.push(error);
        });
        const first = createRallarFacade();
        const second = createRallarFacade();
        await first.connect({ rtcCaptureMode: 'off' });
        await expect(second.connect({ rtcCaptureMode: 'native' })).rejects.toMatchObject({ code: 'new-connection-required' });
        expect(invalidations).toEqual([]);
        await first.disconnect();
        await second.disconnect();
        vi.restoreAllMocks();
    });

    it('fences cancelled direct transport construction and snapshots caller configuration', async () => {
        const { BrowserTransportRuntime } = await import('@shared-web/browser/connection/browser-transport-runtime.ts');
        const firstUp = Promise.withResolvers<BrowserConnectedMiddleware>();
        const secondUp = Promise.withResolvers<BrowserConnectedMiddleware>();
        const configurations: Array<{ readonly mode: string; readonly origin: string; }> = [];
        mocks.initialiseMiddleware.mockImplementation(async (_session, _topic, options) => {
            configurations.push(options.rtcCaptureConfiguration);
            return configurations.length === 1 ? firstUp.promise : secondUp.promise;
        });
        const transport = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
        const configuration = { mode: 'off' as const, origin: 'step' as const };
        const options = {
            rtcCaptureConfiguration: configuration,
            diagnosticsPorts: toRallarDiagnosticsPorts(undefined),
            qosProvider: undefined,
            readVolatileSessionLimits: undefined,
            deliverySettlements: { ws: () => {}, rtc: () => {}, holds: () => false }
        };
        const first = transport.init(options);
        Object.assign(configuration, { mode: 'native', origin: 'host' });
        await expect(transport.init(options)).rejects.toMatchObject({
            code: 'new-connection-required',
            currentConfiguration: { mode: 'off', origin: 'step' },
            currentReceipt: { status: 'unavailable', reason: 'absent' }
        });
        transport.shutdown();
        expect(transport.readRtcCaptureReceipt()).toBeUndefined();
        const second = transport.init(options);
        const cancelled = expect(first).rejects.toThrow('cancelled');
        firstUp.resolve({
            middleware: mocks.ctx.middleware,
            checkpoints: [],
            rtcCaptureReceipt: createBrowserRtcCapture({
                configuration: { mode: 'off', origin: 'step' },
                connectionId: { status: 'observed', value: 'cancelled' },
                record: undefined,
                nowEpochMs: () => 10
            }).receipt
        });
        await cancelled;
        expect(transport.readRtcCaptureReceipt()).toBeUndefined();
        expect(transport.readRtcCaptureConfiguration()).toEqual({ mode: 'native', origin: 'host' });
        secondUp.resolve({
            middleware: mocks.ctx.middleware,
            checkpoints: [],
            rtcCaptureReceipt: createBrowserRtcCapture({
                configuration: { mode: 'native', origin: 'host' },
                connectionId: { status: 'observed', value: 'current' },
                record: undefined,
                nowEpochMs: () => 10
            }).receipt
        });
        await second;
        expect(transport.readRtcCaptureReceipt()?.connectionId).toEqual({ status: 'observed', value: 'current' });
        expect(configurations).toEqual([{ mode: 'off', origin: 'step' }, { mode: 'native', origin: 'host' }]);
        transport.shutdown();
    });

    it('leaves no pending capture selection when synchronous transport setup fails', async () => {
        const { BrowserTransportRuntime } = await import('@shared-web/browser/connection/browser-transport-runtime.ts');
        const failure = new Error('channel unavailable');
        let failSetup = true;
        const openSessionChannel = vi.fn<BrowserTransportRuntime.Input['openSessionChannelPort']>().mockReturnValue(undefined);
        const transport = new BrowserTransportRuntime({ openSessionChannelPort: openSessionChannel });
        openSessionChannel.mockImplementation(() => {
            if (failSetup) {
                throw failure;
            }
            return undefined;
        });
        const options = {
            rtcCaptureConfiguration: { mode: 'off' as const, origin: 'step' as const },
            diagnosticsPorts: toRallarDiagnosticsPorts(undefined),
            qosProvider: undefined,
            readVolatileSessionLimits: undefined,
            deliverySettlements: { ws: () => {}, rtc: () => {}, holds: () => false }
        };
        try {
            transport.init(options);
            throw new Error('Expected synchronous setup failure');
        }
        catch (error) {
            expect(error).toBe(failure);
        }
        expect(transport.isInitializing()).toBe(false);
        expect(transport.readRtcCaptureConfiguration()).toBeUndefined();
        expect(transport.readRtcCaptureReceipt()).toBeUndefined();
        failSetup = false;
        await transport.init({ ...options, rtcCaptureConfiguration: { mode: 'native', origin: 'step' } });
        expect(transport.readRtcCaptureConfiguration()).toEqual({ mode: 'native', origin: 'step' });
        transport.shutdown();
    });

    it('holds the selected mode during synchronous setup reentry', async () => {
        const { BrowserTransportRuntime } = await import('@shared-web/browser/connection/browser-transport-runtime.ts');
        const options = {
            rtcCaptureConfiguration: { mode: 'off' as const, origin: 'step' as const },
            diagnosticsPorts: toRallarDiagnosticsPorts(undefined),
            qosProvider: undefined,
            readVolatileSessionLimits: undefined,
            deliverySettlements: { ws: () => {}, rtc: () => {}, holds: () => false }
        };
        let reentered: Promise<BrowserTransportRuntime.Connection> | undefined;
        let entered = false;
        const openSessionChannel = vi.fn<BrowserTransportRuntime.Input['openSessionChannelPort']>().mockReturnValue(undefined);
        const transport = new BrowserTransportRuntime({ openSessionChannelPort: openSessionChannel });
        openSessionChannel.mockImplementation(() => {
            if (!entered) {
                entered = true;
                reentered = transport.init({ ...options, rtcCaptureConfiguration: { mode: 'native', origin: 'step' } });
            }
            return undefined;
        });
        await transport.init(options);
        await expect(reentered).rejects.toMatchObject({ code: 'new-connection-required' });
        expect(mocks.initialiseMiddleware).toHaveBeenCalledTimes(1);
        expect(transport.readRtcCaptureConfiguration()).toEqual({ mode: 'off', origin: 'step' });
        transport.shutdown();
    });

    it('shares one graph and the original receipt during compatible transport setup reentry', async () => {
        const { BrowserTransportRuntime } = await import('@shared-web/browser/connection/browser-transport-runtime.ts');
        const configurations: Array<{ readonly mode: string; readonly origin: string; }> = [];
        mocks.initialiseMiddleware.mockImplementation(async (_session, _topic, options) => {
            configurations.push(options.rtcCaptureConfiguration);
            return {
                middleware: mocks.ctx.middleware,
                checkpoints: [],
                rtcCaptureReceipt: createBrowserRtcCapture({
                    configuration: options.rtcCaptureConfiguration,
                    connectionId: { status: 'observed', value: 'original' },
                    record: undefined,
                    nowEpochMs: () => 10
                }).receipt
            };
        });
        const options = {
            rtcCaptureConfiguration: { mode: 'off' as const, origin: 'host' as const },
            diagnosticsPorts: toRallarDiagnosticsPorts(undefined),
            qosProvider: undefined,
            readVolatileSessionLimits: undefined,
            deliverySettlements: { ws: () => {}, rtc: () => {}, holds: () => false }
        };
        let reentered: Promise<BrowserTransportRuntime.Connection> | undefined;
        let entered = false;
        const openSessionChannel = vi.fn<BrowserTransportRuntime.Input['openSessionChannelPort']>().mockReturnValue(undefined);
        const transport = new BrowserTransportRuntime({ openSessionChannelPort: openSessionChannel });
        openSessionChannel.mockImplementation(() => {
            if (!entered) {
                entered = true;
                reentered = transport.init({ ...options, rtcCaptureConfiguration: { mode: 'off', origin: 'step' } });
            }
            return undefined;
        });
        onTestFinished(() => transport.shutdown());
        const first = transport.init(options);
        expect(configurations).toEqual([{ mode: 'off', origin: 'host' }]);
        expect(reentered).toBe(first);
        expect(await reentered).toBe(await first);
        expect(transport.readRtcCaptureConfiguration()).toEqual({ mode: 'off', origin: 'host' });
        expect(transport.readRtcCaptureReceipt()).toMatchObject({
            configuration: { mode: 'off', origin: 'host' },
            application: { status: 'applied', mode: 'off' },
            connectionId: { status: 'observed', value: 'original' }
        });
    });

    it('settles one session lifecycle during compatible synchronous setup reentry', async () => {
        const { BrowserTransportRuntime } = await import('@shared-web/browser/connection/browser-transport-runtime.ts');
        const { BrowserFacadeRuntimeState } = await import('@shared-web/browser/composition/browser-facade-runtime-state.ts');
        const { BrowserSessionConnectionLifecycle } = await import('@shared-web/browser/session/session-connection-lifecycle.ts');
        const { createRallarLifecycleCoordinator } = await import('@shared-web/browser/session/rallar-lifecycle-coordinator.ts');
        const { BrowserSessionDeliveries } = await import('@shared-web/browser/messages/browser-session-deliveries.ts');
        const { browserDeliveryComposition } = await import('@shared-web/browser/composition/browser-delivery-composition.ts');
        const configurations: Array<{ readonly mode: string; readonly origin: string; }> = [];
        mocks.initialiseMiddleware.mockImplementation(async (_session, _topic, options) => {
            configurations.push(options.rtcCaptureConfiguration);
            return {
                middleware: mocks.ctx.middleware,
                checkpoints: [],
                rtcCaptureReceipt: createBrowserRtcCapture({
                    configuration: options.rtcCaptureConfiguration,
                    connectionId: { status: 'observed', value: 'session-original' },
                    record: undefined,
                    nowEpochMs: () => 10
                }).receipt
            };
        });
        let reentered: Promise<BrowserTransportRuntime.Connection> | undefined;
        let entered = false;
        const openSessionChannel = vi.fn<BrowserTransportRuntime.Input['openSessionChannelPort']>().mockReturnValue(undefined);
        const transport = new BrowserTransportRuntime({ openSessionChannelPort: openSessionChannel });
        onTestFinished(() => transport.shutdown());
        const lifecycle = createRallarLifecycleCoordinator();
        const attachments: ApiMiddleware[] = [];
        const phases: string[] = [];
        lifecycle.register({ id: 'capture-proof', order: 0, attach: (middleware) => attachments.push(middleware), connected: () => phases.push('connected') });
        const connection = new BrowserSessionConnectionLifecycle({
            qosProvider: undefined,
            readVolatileSessionLimits: undefined,
            sessionDeliveries: new BrowserSessionDeliveries(browserDeliveryComposition.deliveries, transport, mocks.readSession),
            connectionRuntime: new BrowserFacadeRuntimeState(transport),
            transportRuntime: transport,
            lifecycle,
            clearCurrentRoom: () => {}
        });
        const input: RallarSessionConnectionInput = {
            rtcCaptureConfiguration: { mode: 'off', origin: 'host' },
            session: mocks.ctx.session,
            scope: undefined,
            operationOptions: {},
            diagnosticsPorts: toRallarDiagnosticsPorts(undefined),
            hasAuthEndInProgress: () => false,
            isSessionCurrent: () => true,
            onAuthInvalid: async () => {}
        };
        openSessionChannel.mockImplementation(() => {
            if (!entered) {
                entered = true;
                reentered = connection.connect({ ...input, rtcCaptureConfiguration: { mode: 'off', origin: 'step' } });
            }
            return undefined;
        });
        const first = connection.connect(input);
        expect(configurations).toEqual([{ mode: 'off', origin: 'host' }]);
        const result = await first;
        expect(await reentered).toBe(result);
        expect(configurations).toEqual([{ mode: 'off', origin: 'host' }]);
        expect(attachments).toEqual([result.middleware]);
        expect(phases).toEqual(['connected']);
        expect(transport.readRtcCaptureReceipt()).toMatchObject({
            configuration: { mode: 'off', origin: 'host' },
            application: { status: 'applied', mode: 'off' },
            connectionId: { status: 'observed', value: 'session-original' }
        });
        await connection.disconnect();
    });

    it('rejects a compatible transport waiter with the original synchronous setup failure', async () => {
        const { BrowserTransportRuntime } = await import('@shared-web/browser/connection/browser-transport-runtime.ts');
        const failure = new Error('reentrant setup unavailable');
        const options = {
            rtcCaptureConfiguration: { mode: 'off' as const, origin: 'host' as const },
            diagnosticsPorts: toRallarDiagnosticsPorts(undefined),
            qosProvider: undefined,
            readVolatileSessionLimits: undefined,
            deliverySettlements: { ws: () => {}, rtc: () => {}, holds: () => false }
        };
        let reentered: Promise<BrowserTransportRuntime.Connection> | undefined;
        let entered = false;
        const openSessionChannel = vi.fn<BrowserTransportRuntime.Input['openSessionChannelPort']>().mockReturnValue(undefined);
        const transport = new BrowserTransportRuntime({ openSessionChannelPort: openSessionChannel });
        openSessionChannel.mockImplementation(() => {
            if (!entered) {
                entered = true;
                reentered = transport.init({ ...options, rtcCaptureConfiguration: { mode: 'off', origin: 'step' } });
                throw failure;
            }
            return undefined;
        });
        onTestFinished(() => transport.shutdown());
        try {
            transport.init(options);
            throw new Error('Expected synchronous setup failure');
        }
        catch (error) {
            expect(error).toBe(failure);
        }
        await expect(reentered).rejects.toBe(failure);
        expect(transport.isInitializing()).toBe(false);
        expect(transport.readRtcCaptureConfiguration()).toBeUndefined();
        expect(transport.readRtcCaptureReceipt()).toBeUndefined();
        await transport.init({ ...options, rtcCaptureConfiguration: { mode: 'native', origin: 'step' } });
        expect(transport.readRtcCaptureConfiguration()).toEqual({ mode: 'native', origin: 'step' });
    });

    it('preserves a replacement transport reservation when the older synchronous setup throws', async () => {
        const { BrowserTransportRuntime } = await import('@shared-web/browser/connection/browser-transport-runtime.ts');
        const failure = new Error('older setup failed');
        const options = {
            rtcCaptureConfiguration: { mode: 'off' as const, origin: 'host' as const },
            diagnosticsPorts: toRallarDiagnosticsPorts(undefined),
            qosProvider: undefined,
            readVolatileSessionLimits: undefined,
            deliverySettlements: { ws: () => {}, rtc: () => {}, holds: () => false }
        };
        let replacement: Promise<BrowserTransportRuntime.Connection> | undefined;
        let entered = false;
        const openSessionChannel = vi.fn<BrowserTransportRuntime.Input['openSessionChannelPort']>().mockReturnValue(undefined);
        const transport = new BrowserTransportRuntime({ openSessionChannelPort: openSessionChannel });
        openSessionChannel.mockImplementation(() => {
            if (!entered) {
                entered = true;
                transport.shutdown();
                replacement = transport.init({ ...options, rtcCaptureConfiguration: { mode: 'native', origin: 'step' } });
                throw failure;
            }
            return undefined;
        });
        onTestFinished(() => transport.shutdown());
        try {
            transport.init(options);
            throw new Error('Expected synchronous setup failure');
        }
        catch (error) {
            expect(error).toBe(failure);
        }
        await replacement;
        expect(transport.readRtcCaptureConfiguration()).toEqual({ mode: 'native', origin: 'step' });
        expect(transport.isReady()).toBe(true);
        expect(transport.isInitializing()).toBe(false);
    });

    it('clears the session reservation and rejects both compatible callers when synchronous setup fails', async () => {
        const { BrowserTransportRuntime } = await import('@shared-web/browser/connection/browser-transport-runtime.ts');
        const { BrowserFacadeRuntimeState } = await import('@shared-web/browser/composition/browser-facade-runtime-state.ts');
        const { BrowserSessionConnectionLifecycle } = await import('@shared-web/browser/session/session-connection-lifecycle.ts');
        const { createRallarLifecycleCoordinator } = await import('@shared-web/browser/session/rallar-lifecycle-coordinator.ts');
        const { BrowserSessionDeliveries } = await import('@shared-web/browser/messages/browser-session-deliveries.ts');
        const { browserDeliveryComposition } = await import('@shared-web/browser/composition/browser-delivery-composition.ts');
        const failure = new Error('session setup failed');
        let reentered: Promise<BrowserTransportRuntime.Connection> | undefined;
        let entered = false;
        const openSessionChannel = vi.fn<BrowserTransportRuntime.Input['openSessionChannelPort']>().mockReturnValue(undefined);
        const transport = new BrowserTransportRuntime({ openSessionChannelPort: openSessionChannel });
        onTestFinished(() => transport.shutdown());
        const lifecycle = createRallarLifecycleCoordinator();
        const phases: string[] = [];
        lifecycle.register({ id: 'failure-proof', order: 0, attach: () => phases.push('attach'), connected: () => phases.push('connected') });
        const connectionRuntime = new BrowserFacadeRuntimeState(transport);
        const connection = new BrowserSessionConnectionLifecycle({
            qosProvider: undefined,
            readVolatileSessionLimits: undefined,
            sessionDeliveries: new BrowserSessionDeliveries(browserDeliveryComposition.deliveries, transport, mocks.readSession),
            connectionRuntime,
            transportRuntime: transport,
            lifecycle,
            clearCurrentRoom: () => {}
        });
        const invalidations: Error[] = [];
        const input: RallarSessionConnectionInput = {
            rtcCaptureConfiguration: { mode: 'off', origin: 'host' },
            session: mocks.ctx.session,
            scope: undefined,
            operationOptions: {},
            diagnosticsPorts: toRallarDiagnosticsPorts(undefined),
            hasAuthEndInProgress: () => false,
            isSessionCurrent: () => true,
            onAuthInvalid: async (error) => {
                invalidations.push(error);
            }
        };
        openSessionChannel.mockImplementation(() => {
            if (!entered) {
                entered = true;
                reentered = connection.connect({ ...input, rtcCaptureConfiguration: { mode: 'off', origin: 'step' } });
                throw failure;
            }
            return undefined;
        });
        const first = connection.connect(input);
        await expect(first).rejects.toBe(failure);
        await expect(reentered).rejects.toBe(failure);
        expect(phases).toEqual([]);
        expect(invalidations).toEqual([]);
        expect(connectionRuntime.readConnectState()).toBe('idle');
        expect(transport.isInitializing()).toBe(false);
        expect(transport.readRtcCaptureConfiguration()).toBeUndefined();
        await connection.connect({ ...input, rtcCaptureConfiguration: { mode: 'native', origin: 'step' } });
        expect(phases).toEqual(['attach', 'connected']);
        expect(transport.readRtcCaptureConfiguration()).toEqual({ mode: 'native', origin: 'step' });
        await connection.disconnect();
    });

    it('rejects invalid JavaScript selections before constructing a connection', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        await expect(facade.connect(JSON.parse('{"rtcCaptureMode":true}'))).rejects.toThrow('RTC capture mode');
        expect(() => facade.setDefaults(JSON.parse('{"applicationId":"app","rtc":{"captureMode":false}}'))).toThrow('RTC capture mode');
        expect(facade.isConnected()).toBe(false);
        await facade.disconnect();
    });
});
