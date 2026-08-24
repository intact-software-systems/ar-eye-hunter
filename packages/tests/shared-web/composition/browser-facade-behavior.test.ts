import { readApiBaseUrl } from '@shared-web/browser/api-client-config.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type AppContextModule = typeof import('@shared-web/browser/app-context.ts');
type ApiWorkflowsModule = typeof import('@shared-web/browser/api-workflows.ts');
type AuthModule = typeof import('@shared/api/auth.ts');
type DataCachesModule = typeof import('@shared-web/browser/data-caches.ts');
type ClientStateSnapshotsRepositoryModule = typeof import('@shared/repository/client-state-snapshots-repository.ts');
type GroupStateSnapshotsRepositoryModule = typeof import('@shared/repository/group-state-snapshots-repository.ts');

const runtime = await vi.hoisted(async () => {
    const { createApiMiddlewareTestDouble } = await import(
        '../api-middleware-test-double.ts'
    );
    const middleware = createApiMiddlewareTestDouble();
    const missingClientRepository = (): never => {
        throw new Error(
            'Repository not found: shared.repository.client-state-snapshots'
        );
    };
    const missingGroupRepository = (): never => {
        throw new Error(
            'Repository not found: shared.repository.group-state-snapshots'
        );
    };

    return {
        middleware,
        initMiddleware: vi.fn<AppContextModule['initMiddleware']>(),
        readSession: vi.fn<AuthModule['readSession']>(),
        refreshStateSnapshots: vi.fn<ApiWorkflowsModule['refreshStateSnapshots']>(),
        hydrateStateCaches: vi.fn<DataCachesModule['hydrateStateCaches']>(),
        onStateCacheChange: vi.fn<DataCachesModule['onStateCacheChange']>(),
        findClientStateSnapshotByPrincipalId: vi.fn<ClientStateSnapshotsRepositoryModule['findClientStateSnapshotByPrincipalId']>(missingClientRepository),
        getAllClientStateSnapshots: vi.fn<ClientStateSnapshotsRepositoryModule['getAllClientStateSnapshots']>(missingClientRepository),
        findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn<GroupStateSnapshotsRepositoryModule['findFirstGroupStateSnapshotRefSessionIdIsIn']>(
            missingGroupRepository
        ),
        findGroupStateSnapshotByRef: vi.fn<GroupStateSnapshotsRepositoryModule['findGroupStateSnapshotByRef']>(missingGroupRepository),
        getAllGroupStateSnapshots: vi.fn<GroupStateSnapshotsRepositoryModule['getAllGroupStateSnapshots']>(missingGroupRepository)
    };
});

vi.mock(
    import('@shared-web/browser/app-context.ts'),
    (): Partial<AppContextModule> => ({
        clearMiddleware: vi.fn(),
        getMiddleware: () => runtime.middleware,
        initMiddleware: runtime.initMiddleware,
        isMiddlewareReady: () => false
    })
);

vi.mock(
    import('@shared-web/browser/api-workflows.ts'),
    (): Partial<ApiWorkflowsModule> => ({
        refreshStateSnapshots: runtime.refreshStateSnapshots
    })
);

vi.mock(
    import('@shared-web/browser/data-caches.ts'),
    (): Partial<DataCachesModule> => ({
        hydrateStateCaches: runtime.hydrateStateCaches,
        onStateCacheChange: runtime.onStateCacheChange
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

describe('browser facade behavior', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        runtime.initMiddleware.mockResolvedValue(runtime.middleware);
        runtime.readSession.mockReturnValue(runtime.middleware.session);
        runtime.refreshStateSnapshots.mockResolvedValue({ clients: [], groups: [] });
        runtime.hydrateStateCaches.mockResolvedValue(undefined);
        runtime.onStateCacheChange.mockReturnValue(() => undefined);
    });

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
            middleware: runtime.middleware,
            session: runtime.middleware.session
        });
        expect(runtime.initMiddleware).toHaveBeenCalledWith({
            onAuthInvalid: expect.any(Function),
            scope: {
                applicationId: 'arena',
                workspaceId: 'match'
            },
            timeoutMs: 123,
            maxPeerConnections: 10
        });
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

    it('starts disconnected and owns idempotent subscription cleanup', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const first = vi.fn();
        const second = vi.fn();
        const late = vi.fn();
        const subscriptions = facade.subscriptions();

        subscriptions.add(first);
        subscriptions.add(undefined);
        subscriptions.add(second);
        subscriptions.unsubscribe();
        subscriptions.unsubscribe();
        subscriptions.add(late);

        expect(facade.status()).toBe('idle');
        expect(facade.isConnected()).toBe(false);
        expect(first).toHaveBeenCalledOnce();
        expect(second).toHaveBeenCalledOnce();
        expect(late).toHaveBeenCalledOnce();
        expect(subscriptions.size()).toBe(0);
    });
});
