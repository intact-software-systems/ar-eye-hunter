import { readApiBaseUrl } from '@shared-web/browser/api-client-config.ts';
import { browserTransportRuntime } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MiddlewareModule = typeof import('@shared-web/browser/connection/initialise-browser-middleware.ts');
type RefreshStateSnapshotsModule = typeof import('@shared-web/browser/state-read/refresh-state-snapshots.ts');
type AuthModule = typeof import('@shared/api/auth.ts');
type StateCacheLifecycleModule = typeof import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts');
type ClientStateSnapshotsRepositoryModule = typeof import('@shared/repository/client-state-snapshots-repository.ts');
type GroupStateSnapshotsRepositoryModule = typeof import('@shared/repository/group-state-snapshots-repository.ts');

const runtime = await vi.hoisted(async () => {
    const { createDefaultApiMiddlewareTestDouble } = await import(
        '../api-middleware-test-double.ts'
    );
    const middleware = createDefaultApiMiddlewareTestDouble();
    return {
        middleware,
        initialiseMiddleware: vi.fn<MiddlewareModule['initialiseMiddleware']>(),
        readSession: vi.fn<AuthModule['readSession']>(),
        refreshStateSnapshots: vi.fn<RefreshStateSnapshotsModule['refreshStateSnapshots']>(),
        hydrateStateCache: vi.fn<StateCacheLifecycleModule['browserStateCacheLifecycle']['hydrate']>(),
        onCacheChange: vi.fn<StateCacheLifecycleModule['browserStateCacheLifecycle']['onChange']>(),
        findClientStateSnapshotByPrincipalId: vi.fn<ClientStateSnapshotsRepositoryModule['findClientStateSnapshotByPrincipalId']>(() => undefined),
        getAllClientStateSnapshots: vi.fn<ClientStateSnapshotsRepositoryModule['getAllClientStateSnapshots']>(() => []),
        findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn<GroupStateSnapshotsRepositoryModule['findFirstGroupStateSnapshotRefSessionIdIsIn']>(() => undefined),
        findGroupStateSnapshotByRef: vi.fn<GroupStateSnapshotsRepositoryModule['findGroupStateSnapshotByRef']>(() => undefined),
        getAllGroupStateSnapshots: vi.fn<GroupStateSnapshotsRepositoryModule['getAllGroupStateSnapshots']>(() => [])
    };
});

vi.mock(
    import('@shared-web/browser/connection/initialise-browser-middleware.ts'),
    (): Partial<MiddlewareModule> => ({
        initialiseMiddleware: runtime.initialiseMiddleware
    })
);

vi.mock(
    import('@shared-web/browser/state-read/refresh-state-snapshots.ts'),
    (): Partial<RefreshStateSnapshotsModule> => ({
        refreshStateSnapshots: runtime.refreshStateSnapshots
    })
);

vi.mock(
    import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts'),
    (): Partial<StateCacheLifecycleModule> => ({
        browserStateCacheLifecycle: {
            hydrate: runtime.hydrateStateCache,
            onChange: runtime.onCacheChange,
            initialise: vi.fn(),
            cancelSnapshotAssemblies: vi.fn(() => undefined)
        }
    })
);

vi.mock(import('@shared/api/auth.ts'), (): Partial<AuthModule> => ({
    clearSession: vi.fn(),
    isLoggedIn: () => true,
    readSession: runtime.readSession,
    writeSession: vi.fn()
}));

vi.mock(
    import('@shared/repository/client-state-snapshots-repository.ts'),
    (): Partial<ClientStateSnapshotsRepositoryModule> => ({
        findClientStateSnapshotByPrincipalId: runtime.findClientStateSnapshotByPrincipalId,
        getAllClientStateSnapshots: runtime.getAllClientStateSnapshots
    })
);

vi.mock(
    import('@shared/repository/group-state-snapshots-repository.ts'),
    (): Partial<GroupStateSnapshotsRepositoryModule> => ({
        findFirstGroupStateSnapshotRefSessionIdIsIn: runtime.findFirstGroupStateSnapshotRefSessionIdIsIn,
        findGroupStateSnapshotByRef: runtime.findGroupStateSnapshotByRef,
        getAllGroupStateSnapshots: runtime.getAllGroupStateSnapshots
    })
);

beforeEach(() => {
    browserTransportRuntime.shutdown('test-reset');
    vi.clearAllMocks();
    runtime.initialiseMiddleware.mockResolvedValue(runtime.middleware.middleware);
    runtime.readSession.mockReturnValue(runtime.middleware.session);
    runtime.refreshStateSnapshots.mockResolvedValue({ clients: [], groups: [] });
    runtime.hydrateStateCache.mockResolvedValue(undefined);
    runtime.onCacheChange.mockReturnValue(() => undefined);
});

describe('browser facade transport ownership', () => {
    it('connects and disconnects the facade through one transport owner', async () => {
        const shutdownEvents: string[] = [];
        const stopQueueEngine = vi.fn(() => {
            shutdownEvents.push('queue-engine-stopped');
        });
        const closeWebSocket = vi.fn(() => {
            shutdownEvents.push('websocket-closed');
        });
        runtime.middleware.middleware.qboxEngine.stop = stopQueueEngine;
        runtime.middleware.middleware.webSocketQueueBox.close = closeWebSocket;
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();

        await facade.connect();
        expect(browserTransportRuntime.readMiddleware()?.middleware).toBe(
            runtime.middleware.middleware
        );

        await facade.disconnect();

        expect(shutdownEvents).toEqual([
            'queue-engine-stopped',
            'websocket-closed'
        ]);
        expect(browserTransportRuntime.readMiddleware()).toBeUndefined();
    });
});

describe('browser facade setup without startup work', () => {
    it('configures defaults and honors explicitly disabled setup startup work', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();

        const result = await facade.setup({
            apiBaseUrl: 'https://api.example.test///',
            applicationId: 'arena',
            workspaceId: 'match',
            start: {
                restoreSession: false,
                connect: false,
                refreshRooms: false,
                refreshPeople: false
            }
        });

        expect(readApiBaseUrl()).toBe('https://api.example.test');
        expect(facade.defaults()).toEqual({
            applicationId: 'arena',
            workspaceId: 'match'
        });
        expect(result).toEqual({
            session: undefined,
            connected: false
        });
    });
});

describe('browser facade restored-session setup', () => {
    it('restores, connects, refreshes rooms, and returns the connected setup result by default', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();

        const result = await facade.setup({
            apiBaseUrl: 'https://api.example.test///',
            applicationId: 'arena',
            workspaceId: 'match',
            rtc: { maxPeerConnections: 10 },
            start: { timeoutMs: 123 }
        });

        expect(readApiBaseUrl()).toBe('https://api.example.test');
        expect(facade.defaults()).toEqual({
            applicationId: 'arena',
            workspaceId: 'match',
            rtc: { maxPeerConnections: 10 }
        });
        expect(result).toMatchObject({
            connected: true,
            middleware: expect.objectContaining({
                middleware: runtime.middleware.middleware,
                session: runtime.middleware.session
            }),
            session: runtime.middleware.session
        });
        expect(runtime.initialiseMiddleware).toHaveBeenCalledWith(
            runtime.middleware.session,
            expect.any(String),
            {
                onAuthInvalid: expect.any(Function),
                scope: {
                    applicationId: 'arena',
                    workspaceId: 'match'
                },
                timeoutMs: 123,
                maxPeerConnections: 10
            }
        );
        expect(runtime.refreshStateSnapshots).toHaveBeenCalledWith(
            {
                applicationId: 'arena',
                workspaceId: 'match'
            },
            {
                command: { timeoutMs: 123 }
            }
        );
    });
});

describe('browser facade subscriptions', () => {
    it('starts disconnected and owns idempotent subscription cleanup', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const cleanupEvents: string[] = [];
        const subscriptions = facade.subscriptions();

        subscriptions.add(() => {
            cleanupEvents.push('first');
        });
        subscriptions.add(undefined);
        subscriptions.add(() => {
            cleanupEvents.push('second');
        });
        subscriptions.unsubscribe();
        subscriptions.unsubscribe();
        subscriptions.add(() => {
            cleanupEvents.push('late');
        });

        expect(facade.status()).toBe('idle');
        expect(facade.isConnected()).toBe(false);
        expect(cleanupEvents).toEqual(['first', 'second', 'late']);
        expect(subscriptions.size()).toBe(0);
    });
});
