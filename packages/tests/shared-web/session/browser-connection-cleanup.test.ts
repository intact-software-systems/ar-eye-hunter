import { BrowserTransportRuntime } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type { Middleware } from '@shared-web/browser/middleware.ts';
import { BrowserFacadeRuntimeState } from '@shared-web/browser/rallar-runtime-context.ts';
import { createRallarLifecycleCoordinator } from '@shared-web/browser/rallar-runtime/lifecycle.ts';
import { createRallarSessionController } from '@shared-web/browser/rallar-runtime/session.ts';
import { describe, expect, it, vi } from 'vitest';
import { createApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';

type MiddlewareModule = typeof import('@shared-web/browser/middleware.ts');
type AuthModule = typeof import('@shared/api/auth.ts');

const mocks = vi.hoisted(() => ({
    initialiseMiddleware: vi.fn<MiddlewareModule['initialiseMiddleware']>(),
    readSession: vi.fn<AuthModule['readSession']>()
}));

vi.mock(
    import('@shared-web/browser/middleware.ts'),
    async (importOriginal): Promise<Partial<MiddlewareModule>> => ({
        ...await importOriginal(),
        initialiseMiddleware: mocks.initialiseMiddleware
    })
);

vi.mock(import('@shared/api/auth.ts'), (): Partial<AuthModule> => ({
    readSession: mocks.readSession
}));

describe('browser connection cleanup', () => {
    it('cancels pending middleware initialization and tears down its resolved transport once', async () => {
        const middleware = createApiMiddlewareTestDouble();
        let resolveMiddleware: ((middleware: Middleware) => void) | undefined;
        mocks.readSession.mockReturnValue(middleware.session);
        mocks.initialiseMiddleware.mockReturnValue(
            new Promise((resolve) => {
                resolveMiddleware = resolve;
            })
        );
        const transportRuntime = new BrowserTransportRuntime();

        const pending = transportRuntime.init();
        transportRuntime.shutdown();
        resolveMiddleware?.(middleware.middleware);

        await expect(pending).rejects.toThrow(
            'Rallar connection was cancelled because auth ended.'
        );

        expect(middleware.middleware.qboxEngine.stop).toHaveBeenCalledOnce();
        expect(middleware.middleware.webSocketQueueBox.close).toHaveBeenCalledOnce();
        expect(transportRuntime.readMiddleware()).toBeUndefined();
    });

    it('cleans one connected runtime once, continues past a heartbeat failure, and notifies after runtime clearing', async () => {
        const middleware = createApiMiddlewareTestDouble({
            middleware: {
                webRtcOverlayMulticastManager: {
                    dispose: vi.fn()
                }
            }
        });
        const effects: string[] = [];
        vi.mocked(middleware.middleware.heartbeat!.stop).mockImplementation(() => {
            effects.push('heartbeat');
            throw new Error('heartbeat already stopped');
        });
        vi.mocked(middleware.middleware.rtcRxStreamer.stopAllHeartbeats).mockImplementation(() => {
            effects.push('rtc-heartbeats');
        });
        vi.mocked(middleware.middleware.webRtcConnectionService.knownPeerIds).mockReturnValue(['peer-1']);
        vi.mocked(middleware.middleware.webRtcConnectionService.disconnectPeer).mockImplementation(() => {
            effects.push('rtc-peer');
            return true;
        });
        vi.mocked(middleware.middleware.rtcRxStreamer.stopLocalMedia).mockImplementation(() => {
            effects.push('media');
        });
        vi.mocked(middleware.middleware.webRtcOverlayMulticastManager!.dispose!).mockImplementation(() => {
            effects.push('multicast');
        });
        vi.mocked(middleware.middleware.qboxEngine.stop).mockImplementation(() => {
            effects.push('queue');
        });
        vi.mocked(middleware.middleware.webSocketQueueBox.socket.close).mockImplementation(() => {
            effects.push('websocket');
        });
        vi.mocked(middleware.middleware.webSocketQueueBox.close).mockImplementation(() => {
            effects.push('queuebox');
            middleware.middleware.webSocketQueueBox.socket.close(1000, 'rallar-disconnect');
        });

        mocks.readSession.mockReturnValue(middleware.session);
        mocks.initialiseMiddleware.mockResolvedValue(middleware.middleware as Middleware);
        const transportRuntime = new BrowserTransportRuntime();
        const runtime = new BrowserFacadeRuntimeState(transportRuntime);
        const lifecycle = createRallarLifecycleCoordinator();
        lifecycle.register({
            id: 'state-cache',
            order: 20,
            attach: () => effects.push('state-cache-attached'),
            detach: () => effects.push('state-cache-detached'),
            disconnected: () => {
                expect(runtime.readConnectState()).toBe('idle');
                expect(runtime.readMiddleware()).toBeUndefined();
                effects.push('lifecycle-disconnected');
            }
        });

        const sessionController = createRallarSessionController({
            connectionRuntime: runtime,
            transportRuntime,
            authRuntime: runtime,
            stateRuntime: runtime,
            lifecycle,
            emitState: () => undefined,
            closeDataScopes: async () => undefined
        });
        await sessionController.connect();
        await sessionController.disconnect();

        expect(effects).toEqual([
            'state-cache-attached',
            'state-cache-detached',
            'heartbeat',
            'rtc-heartbeats',
            'rtc-peer',
            'media',
            'multicast',
            'queue',
            'queuebox',
            'websocket',
            'lifecycle-disconnected'
        ]);
        expect(middleware.middleware.webSocketQueueBox.close).toHaveBeenCalledOnce();
        expect(middleware.middleware.qboxEngine.stop).toHaveBeenCalledOnce();
        expect(middleware.middleware.webRtcConnectionService.disconnectPeer)
            .toHaveBeenCalledOnce();
        expect(middleware.middleware.rtcRxStreamer.stopLocalMedia).toHaveBeenCalledOnce();
    });

    it('fences configure during connection and coalesces concurrent session disconnects', async () => {
        const middleware = createApiMiddlewareTestDouble();
        const disconnected = vi.fn();
        let resolveMiddleware: ((value: Middleware) => void) | undefined;
        mocks.readSession.mockReturnValue(middleware.session);
        mocks.initialiseMiddleware.mockReturnValue(
            new Promise((resolve) => {
                resolveMiddleware = resolve;
            })
        );
        const transportRuntime = new BrowserTransportRuntime();
        const runtime = new BrowserFacadeRuntimeState(transportRuntime);
        const lifecycle = createRallarLifecycleCoordinator();
        lifecycle.register({
            id: 'test-lifecycle',
            order: 1,
            disconnected
        });
        const sessionController = createRallarSessionController({
            connectionRuntime: runtime,
            transportRuntime,
            authRuntime: runtime,
            stateRuntime: runtime,
            lifecycle,
            emitState: () => undefined,
            closeDataScopes: async () => undefined
        });

        const pendingConnect = sessionController.connectionOperations.connect();
        await vi.waitFor(() => {
            expect(transportRuntime.isInitializing()).toBe(true);
        });

        expect(() =>
            sessionController.connectionOperations.configure({
                apiBaseUrl: 'https://api.example.test'
            })
        ).toThrow('Rallar must be configured before connecting.');

        const firstDisconnect = sessionController.connectionOperations.disconnect();
        const secondDisconnect = sessionController.connectionOperations.disconnect();
        expect(secondDisconnect).toBe(firstDisconnect);
        resolveMiddleware?.(middleware.middleware);

        await Promise.all([firstDisconnect, secondDisconnect]);
        await expect(pendingConnect).rejects.toThrow(
            'Rallar connection was cancelled because auth ended.'
        );
        await sessionController.connectionOperations.disconnect();

        expect(disconnected).toHaveBeenCalledOnce();
        expect(middleware.middleware.qboxEngine.stop).toHaveBeenCalledOnce();
        expect(middleware.middleware.webSocketQueueBox.close).toHaveBeenCalledOnce();
        expect(runtime.readConnectState()).toBe('idle');
        expect(runtime.readMiddleware()).toBeUndefined();
    });
});
