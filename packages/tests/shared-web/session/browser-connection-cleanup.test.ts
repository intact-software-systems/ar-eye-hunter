import { BrowserTransportRuntime } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type { Middleware } from '@shared-web/browser/middleware.ts';
import { BrowserFacadeRuntimeState } from '@shared-web/browser/rallar-runtime-context.ts';
import { createRallarLifecycleCoordinator } from '@shared-web/browser/session/rallar-lifecycle-coordinator.ts';
import { createRallarSessionController } from '@shared-web/browser/session/rallar-session-controller.ts';
import { BrowserSessionConnectionLifecycle, type RallarSessionConnectionInput } from '@shared-web/browser/session/session-connection-lifecycle.ts';
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
    it('continues transport and lifecycle cleanup when a detach participant fails', async () => {
        const middleware = createApiMiddlewareTestDouble();
        const effects: string[] = [];
        vi.mocked(middleware.middleware.webSocketQueueBox.close).mockImplementation(() => {
            effects.push('transport-closed');
        });
        mocks.readSession.mockReturnValue(middleware.session);
        mocks.initialiseMiddleware.mockResolvedValue(middleware.middleware);
        const transportRuntime = new BrowserTransportRuntime();
        const runtime = new BrowserFacadeRuntimeState(transportRuntime);
        const lifecycle = createRallarLifecycleCoordinator();
        lifecycle.register({
            id: 'failing-detach',
            order: 10,
            detach: () => {
                effects.push('detach-failed');
                throw new Error('detach failed');
            }
        });
        lifecycle.register({
            id: 'remaining-cleanup',
            order: 20,
            detach: () => effects.push('detach-continued'),
            disconnected: () => effects.push('disconnected')
        });
        const connection = new BrowserSessionConnectionLifecycle({
            connectionRuntime: runtime,
            transportRuntime,
            lifecycle,
            clearCurrentRoom: () => effects.push('room-cleared')
        });

        await connection.connect(toConnectionInput(middleware.session.sessionId));

        await expect(connection.disconnect()).rejects.toThrow('detach failed');
        expect(effects).toEqual([
            'detach-failed',
            'detach-continued',
            'transport-closed',
            'room-cleared',
            'disconnected'
        ]);
        expect(runtime.readConnectState()).toBe('idle');
        expect(transportRuntime.readMiddleware()).toBeUndefined();
    });

    it('rolls back transport and attached lifecycle state when attach fails', async () => {
        const middleware = createApiMiddlewareTestDouble();
        const effects: string[] = [];
        vi.mocked(middleware.middleware.webSocketQueueBox.close).mockImplementation(() => {
            effects.push('transport-closed');
        });
        mocks.readSession.mockReturnValue(middleware.session);
        mocks.initialiseMiddleware.mockResolvedValue(middleware.middleware);
        const transportRuntime = new BrowserTransportRuntime();
        const runtime = new BrowserFacadeRuntimeState(transportRuntime);
        const lifecycle = createRallarLifecycleCoordinator();
        lifecycle.register({
            id: 'state',
            order: 10,
            attach: () => effects.push('state-attached'),
            detach: () => effects.push('state-detached'),
            disconnected: () => effects.push('state-disconnected')
        });
        lifecycle.register({
            id: 'failing-attach',
            order: 20,
            attach: () => {
                effects.push('attach-failed');
                throw new Error('attach failed');
            }
        });
        const connection = new BrowserSessionConnectionLifecycle({
            connectionRuntime: runtime,
            transportRuntime,
            lifecycle,
            clearCurrentRoom: () => effects.push('room-cleared')
        });

        await expect(
            connection.connect(toConnectionInput(middleware.session.sessionId))
        ).rejects.toThrow('attach failed');

        expect(effects).toEqual([
            'state-attached',
            'attach-failed',
            'state-detached',
            'transport-closed',
            'room-cleared',
            'state-disconnected'
        ]);
        expect(runtime.readConnectState()).toBe('idle');
        expect(transportRuntime.readMiddleware()).toBeUndefined();
    });

    it('rolls back transport and attached lifecycle state when connected notification fails', async () => {
        const middleware = createApiMiddlewareTestDouble();
        const effects: string[] = [];
        vi.mocked(middleware.middleware.webSocketQueueBox.close).mockImplementation(() => {
            effects.push('transport-closed');
        });
        mocks.readSession.mockReturnValue(middleware.session);
        mocks.initialiseMiddleware.mockResolvedValue(middleware.middleware);
        const transportRuntime = new BrowserTransportRuntime();
        const runtime = new BrowserFacadeRuntimeState(transportRuntime);
        const lifecycle = createRallarLifecycleCoordinator();
        lifecycle.register({
            id: 'state',
            order: 10,
            attach: () => effects.push('state-attached'),
            connected: () => {
                effects.push('connected-failed');
                throw new Error('connected failed');
            },
            detach: () => effects.push('state-detached'),
            disconnected: () => effects.push('state-disconnected')
        });
        const connection = new BrowserSessionConnectionLifecycle({
            connectionRuntime: runtime,
            transportRuntime,
            lifecycle,
            clearCurrentRoom: () => effects.push('room-cleared')
        });

        await expect(
            connection.connect(toConnectionInput(middleware.session.sessionId))
        ).rejects.toThrow('connected failed');

        expect(effects).toEqual([
            'state-attached',
            'connected-failed',
            'state-detached',
            'transport-closed',
            'room-cleared',
            'state-disconnected'
        ]);
        expect(runtime.readConnectState()).toBe('idle');
        expect(transportRuntime.readMiddleware()).toBeUndefined();
    });

    it('starts a new session connection while a cancelled initializer is still pending', async () => {
        const first = createApiMiddlewareTestDouble({
            session: { sessionId: 'session-old', accessToken: 'token-old' }
        });
        const second = createApiMiddlewareTestDouble({
            session: { sessionId: 'session-new', accessToken: 'token-new' }
        });
        const initializationSessions: string[] = [];
        let resolveFirst: ((middleware: Middleware) => void) | undefined;
        let resolveSecond: ((middleware: Middleware) => void) | undefined;
        mocks.initialiseMiddleware.mockImplementation((session) => {
            initializationSessions.push(session.sessionId);
            return new Promise((resolve) => {
                if (session.sessionId === first.session.sessionId) {
                    resolveFirst = resolve;
                }
                else {
                    resolveSecond = resolve;
                }
            });
        });
        mocks.readSession.mockReturnValue(first.session);
        const transportRuntime = new BrowserTransportRuntime();
        const runtime = new BrowserFacadeRuntimeState(transportRuntime);
        const connection = new BrowserSessionConnectionLifecycle({
            connectionRuntime: runtime,
            transportRuntime,
            lifecycle: createRallarLifecycleCoordinator(),
            clearCurrentRoom: () => undefined
        });

        const firstConnection = connection.connect(
            toConnectionInput(first.session.sessionId)
        );
        await vi.waitFor(() => {
            expect(initializationSessions).toEqual(['session-old']);
        });
        await connection.disconnect();
        mocks.readSession.mockReturnValue(second.session);

        const secondConnection = connection.connect(
            toConnectionInput(second.session.sessionId)
        );
        await vi.waitFor(() => {
            expect(initializationSessions).toEqual(['session-old', 'session-new']);
        });
        resolveSecond?.(second.middleware);
        await expect(secondConnection).resolves.toMatchObject({
            session: { sessionId: 'session-new' }
        });

        resolveFirst?.(first.middleware);
        await expect(firstConnection).rejects.toThrow(
            'Rallar connection was cancelled because auth ended.'
        );
        expect(transportRuntime.readMiddleware()?.session.sessionId).toBe('session-new');
    });

    it('cancels pending middleware initialization and tears down its resolved transport once', async () => {
        const middleware = createApiMiddlewareTestDouble();
        const cleanupEffects: string[] = [];
        vi.mocked(middleware.middleware.qboxEngine.stop).mockImplementation(() => {
            cleanupEffects.push('queue-stopped');
        });
        vi.mocked(middleware.middleware.webSocketQueueBox.close).mockImplementation(() => {
            cleanupEffects.push('websocket-closed');
        });
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

        expect(cleanupEffects).toEqual(['queue-stopped', 'websocket-closed']);
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
    });

    it('fences configure during connection and coalesces concurrent session disconnects', async () => {
        const middleware = createApiMiddlewareTestDouble();
        const cleanupEffects: string[] = [];
        vi.mocked(middleware.middleware.qboxEngine.stop).mockImplementation(() => {
            cleanupEffects.push('queue-stopped');
        });
        vi.mocked(middleware.middleware.webSocketQueueBox.close).mockImplementation(() => {
            cleanupEffects.push('websocket-closed');
        });
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
            disconnected: () => cleanupEffects.push('disconnected')
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

        expect(cleanupEffects).toEqual([
            'disconnected',
            'queue-stopped',
            'websocket-closed'
        ]);
        expect(runtime.readConnectState()).toBe('idle');
        expect(runtime.readMiddleware()).toBeUndefined();
    });
});

function toConnectionInput(sessionId: string): RallarSessionConnectionInput {
    return {
        sessionId,
        scope: undefined,
        operationOptions: {},
        hasAuthEndInProgress: () => false,
        isSessionCurrent: () => true,
        onAuthInvalid: async () => undefined
    };
}
