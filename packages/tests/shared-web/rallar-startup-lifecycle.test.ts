import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupSnapshotFixture } from './authoritative-group-fixtures.ts';

type MiddlewareModule = typeof import('@shared-web/browser/connection/initialise-browser-middleware.ts');
type RefreshStateSnapshotsModule = typeof import('@shared-web/browser/state-read/refresh-state-snapshots.ts');
type StateCacheLifecycleModule = typeof import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts');
type AuthModule = typeof import('@shared/api/auth.ts');
type ClientStateSnapshotsRepositoryModule = typeof import('@shared/repository/client-state-snapshots-repository.ts');
type GroupStateSnapshotsRepositoryModule = typeof import('@shared/repository/group-state-snapshots-repository.ts');

interface GroupSnapshotFixtureScope {
    readonly applicationId?: string;
    readonly workspaceId?: string;
}

const mocks = await vi.hoisted(async () => {
    const { createDefaultApiMiddlewareTestDouble } = await import(
        './api-middleware-test-double.ts'
    );
    const ctx = createDefaultApiMiddlewareTestDouble();
    return {
        clearSession: vi.fn<AuthModule['clearSession']>(),
        ctx,
        hydrateStateCache: vi.fn<StateCacheLifecycleModule['browserStateCacheLifecycle']['hydrate']>(() => Promise.resolve()),
        initialiseMiddleware: vi.fn<MiddlewareModule['initialiseMiddleware']>(() => Promise.resolve(ctx.middleware)),
        onCacheChange: vi.fn<StateCacheLifecycleModule['browserStateCacheLifecycle']['onChange']>(() => vi.fn()),
        readSession: vi.fn<AuthModule['readSession']>(() => ctx.session),
        refreshStateSnapshots: vi.fn<RefreshStateSnapshotsModule['refreshStateSnapshots']>(() => Promise.resolve({ clients: [], groups: [] })),
        findClientStateSnapshotByPrincipalId: vi.fn<ClientStateSnapshotsRepositoryModule['findClientStateSnapshotByPrincipalId']>(() => undefined),
        getAllClientStateSnapshots: vi.fn<ClientStateSnapshotsRepositoryModule['getAllClientStateSnapshots']>(() => []),
        findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn<
            GroupStateSnapshotsRepositoryModule[
                'findFirstGroupStateSnapshotRefSessionIdIsIn'
            ]
        >(() => undefined),
        findGroupStateSnapshotByRef: vi.fn<GroupStateSnapshotsRepositoryModule['findGroupStateSnapshotByRef']>(() => undefined),
        getAllGroupStateSnapshots: vi.fn<GroupStateSnapshotsRepositoryModule['getAllGroupStateSnapshots']>(() => [])
    };
});

vi.mock(
    import('@shared-web/browser/connection/initialise-browser-middleware.ts'),
    (): Partial<MiddlewareModule> => ({
        initialiseMiddleware: mocks.initialiseMiddleware
    })
);

vi.mock(
    import('@shared-web/browser/state-read/refresh-state-snapshots.ts'),
    (): Partial<RefreshStateSnapshotsModule> => ({
        refreshStateSnapshots: mocks.refreshStateSnapshots
    })
);

vi.mock(
    import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts'),
    (): Partial<StateCacheLifecycleModule> => ({
        browserStateCacheLifecycle: {
            hydrate: mocks.hydrateStateCache,
            onChange: mocks.onCacheChange,
            initialise: vi.fn(),
            cancelSnapshotAssemblies: vi.fn(() => undefined)
        }
    })
);

vi.mock(import('@shared/api/auth.ts'), (): Partial<AuthModule> => ({
    clearSession: mocks.clearSession,
    isLoggedIn: vi.fn(() => true),
    readSession: mocks.readSession,
    writeSession: vi.fn()
}));

vi.mock(
    import('@shared/repository/client-state-snapshots-repository.ts'),
    (): Partial<ClientStateSnapshotsRepositoryModule> => ({
        findClientStateSnapshotByPrincipalId: mocks.findClientStateSnapshotByPrincipalId,
        getAllClientStateSnapshots: mocks.getAllClientStateSnapshots
    })
);

vi.mock(
    import('@shared/repository/group-state-snapshots-repository.ts'),
    (): Partial<GroupStateSnapshotsRepositoryModule> => ({
        findFirstGroupStateSnapshotRefSessionIdIsIn: mocks.findFirstGroupStateSnapshotRefSessionIdIsIn,
        findGroupStateSnapshotByRef: mocks.findGroupStateSnapshotByRef,
        getAllGroupStateSnapshots: mocks.getAllGroupStateSnapshots
    })
);

describe('Rallar startup lifecycle behavior', () => {
    beforeEach(async () => {
        (await import('@shared-web/browser/connection/browser-transport-runtime.ts'))
            .browserTransportRuntime.shutdown('test-reset');
        vi.clearAllMocks();
        mocks.findClientStateSnapshotByPrincipalId.mockReturnValue(undefined);
        mocks.getAllClientStateSnapshots.mockReturnValue([]);
        mockGroupSnapshots([]);
        mocks.hydrateStateCache.mockResolvedValue(undefined);
        mocks.clearSession.mockReset();
        mocks.initialiseMiddleware.mockResolvedValue(mocks.ctx.middleware);
        mocks.readSession.mockReturnValue(mocks.ctx.session);
        mocks.refreshStateSnapshots.mockResolvedValue({ clients: [], groups: [] });
    });

    it('passes facade defaults into middleware startup scope', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();

        facade.setDefaults({
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default'
        });

        await facade.start({ refreshRooms: true });

        expect(mocks.initialiseMiddleware).toHaveBeenCalledWith(
            mocks.ctx.session,
            expect.any(String),
            expect.objectContaining({
                scope: {
                    applicationId: 'ar-eye-hunter',
                    workspaceId: 'default'
                }
            })
        );
        expect(mocks.refreshStateSnapshots).toHaveBeenCalledWith(
            {
                applicationId: 'ar-eye-hunter',
                workspaceId: 'default'
            },
            expect.any(Object)
        );
    });

    it('starts by restoring a session, connecting, and refreshing requested state', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(createGroupSnapshot('match-1', ['session-1', 'peer-1'], {
            applicationId: 'default-app',
            workspaceId: 'default'
        }));
        const facade = createRallarFacade();
        facade.setDefaults({
            applicationId: 'default-app',
            operations: {
                timeoutMs: 123
            }
        });

        const result = await facade.start({
            refreshRooms: true,
            refreshPeople: true
        });

        expect(result.session).toEqual(mocks.ctx.session);
        expect(result.connected).toBe(true);
        expect(result.middleware).toMatchObject({
            middleware: mocks.ctx.middleware,
            session: mocks.ctx.session
        });
        expect(result.roomState?.rooms.map((room) => room.roomId)).toEqual([
            'match-1'
        ]);
        expect(result.peopleState?.clients).toEqual([]);
        expect(mocks.initialiseMiddleware).toHaveBeenCalledWith(
            mocks.ctx.session,
            expect.any(String),
            {
                onAuthInvalid: expect.any(Function),
                scope: {
                    applicationId: 'default-app',
                    workspaceId: 'default'
                },
                timeoutMs: 123
            }
        );
        expect(mocks.refreshStateSnapshots).toHaveBeenCalledWith(
            {
                applicationId: 'default-app',
                workspaceId: 'default'
            },
            {
                command: {
                    timeoutMs: 123
                }
            }
        );
    });

    it('does not connect on start when no session can be restored', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mocks.readSession.mockReturnValue(undefined);
        const facade = createRallarFacade();

        const result = await facade.start();

        expect(result).toEqual({
            session: undefined,
            connected: false
        });
    });

    it('leaves the facade idle when middleware initialization fails', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mocks.initialiseMiddleware.mockRejectedValueOnce(new Error('network unavailable'));
        const facade = createRallarFacade();

        await expect(facade.connect()).rejects.toThrow('network unavailable');

        expect(facade.status()).toBe('idle');
        expect(facade.isConnected()).toBe(false);
    });

    it('ends the restored auth session when connection initialization reports 401', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mocks.initialiseMiddleware.mockRejectedValueOnce(
            new ApiHttpError('GET', '/session', 401, 'expired')
        );
        const facade = createRallarFacade();
        const authChanges: string[] = [];
        const authCleanupEvents: string[] = [];
        mocks.clearSession.mockImplementation(() => {
            authCleanupEvents.push('session-cleared');
        });
        facade.auth.onChange((state) => {
            authChanges.push(state.reason);
        }, {
            emitCurrent: false
        });

        await expect(facade.connect()).rejects.toThrow('expired');

        expect(authCleanupEvents).toEqual(['session-cleared']);
        expect(authChanges).toEqual(['unauthorized']);
        expect(facade.status()).toBe('idle');
    });
});

function mockGroupSnapshot(snapshot: GroupSnapshot): void {
    mockGroupSnapshots([snapshot]);
}

function mockGroupSnapshots(snapshots: readonly GroupSnapshot[]): void {
    mocks.getAllGroupStateSnapshots.mockImplementation(() => [...snapshots]);
    mocks.findGroupStateSnapshotByRef.mockImplementation((ref) =>
        snapshots.find((snapshot) =>
            snapshot.group.groupId === ref.groupId &&
            snapshot.group.applicationId === ref.applicationId &&
            snapshot.group.workspaceId === ref.workspaceId
        )
    );
    mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockImplementation((sessionId) =>
        snapshots.find((snapshot) => snapshot.activeSessions.some((activeSession) => activeSession.sessionId === sessionId))?.group
    );
}

function createGroupSnapshot(
    groupId: string,
    sessionIds: readonly string[],
    scope: GroupSnapshotFixtureScope = {}
): GroupSnapshot {
    const applicationId = scope.applicationId ?? 'app-1';
    const workspaceId = scope.workspaceId ?? 'workspace-1';
    return createGroupSnapshotFixture({
        applicationId,
        workspaceId,
        groupId,
        sessionIds
    });
}
