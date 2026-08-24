import { shutdownMiddleware } from '@shared-web/browser/app-context.ts';
import { createRallarConnectionFacade } from '@shared-web/browser/rallar-connection-facade.ts';
import { createRallarBrowserFacadeRuntimeContext } from '@shared-web/browser/rallar-runtime-context.ts';
import { createRallarLifecycleCoordinator } from '@shared-web/browser/rallar-runtime/lifecycle.ts';
import { createRallarSessionController } from '@shared-web/browser/rallar-runtime/session.ts';
import { describe, expect, it, vi } from 'vitest';
import { createApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';

type AppContextModule = typeof import('@shared-web/browser/app-context.ts');
type AuthModule = typeof import('@shared/api/auth.ts');

const mocks = vi.hoisted(() => ({
    initMiddleware: vi.fn<AppContextModule['initMiddleware']>(),
    readSession: vi.fn<AuthModule['readSession']>()
}));

vi.mock(
    import('@shared-web/browser/app-context.ts'),
    async (importOriginal): Promise<Partial<AppContextModule>> => ({
        ...await importOriginal(),
        initMiddleware: mocks.initMiddleware
    })
);

vi.mock(import('@shared/api/auth.ts'), (): Partial<AuthModule> => ({
    readSession: mocks.readSession
}));

describe('browser connection cleanup', () => {
    it('cleans one connected runtime once, continues past a heartbeat failure, and notifies after runtime clearing', async () => {
        const middleware = createApiMiddlewareTestDouble({
            middleware: {
                webRtcOverlayMulticastManager: {
                    dispose: vi.fn()
                }
            }
        });
        const effects: string[] = [];
        middleware.middleware.heartbeat?.stop.mockImplementation(() => {
            effects.push('heartbeat');
            throw new Error('heartbeat already stopped');
        });
        middleware.middleware.rtcRxStreamer.stopAllHeartbeats.mockImplementation(() => {
            effects.push('rtc-heartbeats');
        });
        middleware.middleware.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        middleware.middleware.webRtcConnectionService.disconnectPeer.mockImplementation(() => {
            effects.push('rtc-peer');
        });
        middleware.middleware.rtcRxStreamer.stopLocalMedia.mockImplementation(() => {
            effects.push('media');
        });
        middleware.middleware.webRtcOverlayMulticastManager?.dispose?.mockImplementation(() => {
            effects.push('multicast');
        });
        middleware.middleware.qboxEngine.stop.mockImplementation(() => {
            effects.push('queue');
        });
        middleware.middleware.webSocketQueueBox.socket.close.mockImplementation(() => {
            effects.push('websocket');
        });
        middleware.middleware.webSocketQueueBox.close.mockImplementation(() => {
            effects.push('queuebox');
            middleware.middleware.webSocketQueueBox.socket.close(1000, 'rallar-disconnect');
        });

        mocks.readSession.mockReturnValue(middleware.session);
        mocks.initMiddleware.mockResolvedValue(middleware);
        const runtime = createRallarBrowserFacadeRuntimeContext({
            clearMiddleware: () => shutdownMiddleware(middleware.middleware)
        });
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
            authRuntime: runtime,
            stateRuntime: runtime,
            lifecycle,
            start: async () => ({ connected: false }),
            emitState: () => undefined,
            closeDataScopes: async () => undefined
        });
        const connection = createRallarConnectionFacade(
            sessionController.connectionOperations
        );

        await connection.connect();
        await connection.disconnect();

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
});
