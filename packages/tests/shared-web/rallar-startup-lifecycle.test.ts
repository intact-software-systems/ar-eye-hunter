import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupSnapshotFixture } from './authoritative-group-fixtures.ts';

type AppContextModule = typeof import('@shared-web/browser/app-context.ts');
type ApiWorkflowsModule = typeof import('@shared-web/browser/api-workflows.ts');
type DataCachesModule = typeof import('@shared-web/browser/data-caches.ts');
type AuthModule = typeof import('@shared/api/auth.ts');
type ClientStateSnapshotsRepositoryModule = typeof import('@shared/repository/client-state-snapshots-repository.ts');
type GroupStateSnapshotsRepositoryModule = typeof import('@shared/repository/group-state-snapshots-repository.ts');

const mocks = await vi.hoisted(async () => {
    const { createApiMiddlewareTestDouble } = await import(
        './api-middleware-test-double.ts'
    );
    const ctx = createApiMiddlewareTestDouble();
    const throwClientRepositoryMissing = () => {
        throw new Error(
            'Repository not found: shared.repository.client-state-snapshots'
        );
    };
    const throwGroupRepositoryMissing = () => {
        throw new Error(
            'Repository not found: shared.repository.group-state-snapshots'
        );
    };

    return {
        ctx,
        throwClientRepositoryMissing,
        throwGroupRepositoryMissing,
        hydrateStateCaches: vi.fn<DataCachesModule['hydrateStateCaches']>(() => Promise.resolve()),
        initMiddleware: vi.fn<AppContextModule['initMiddleware']>(() => Promise.resolve(ctx)),
        isMiddlewareReady: vi.fn<AppContextModule['isMiddlewareReady']>(() => false),
        onStateCacheChange: vi.fn<DataCachesModule['onStateCacheChange']>(() => vi.fn()),
        readSession: vi.fn<AuthModule['readSession']>(() => ctx.session),
        refreshStateSnapshots: vi.fn<ApiWorkflowsModule['refreshStateSnapshots']>(() => Promise.resolve({ clients: [], groups: [] })),
        clientRepositoryMissing: vi.fn(throwClientRepositoryMissing),
        findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn<
            GroupStateSnapshotsRepositoryModule[
                'findFirstGroupStateSnapshotRefSessionIdIsIn'
            ]
        >(throwGroupRepositoryMissing),
        findGroupStateSnapshotByRef: vi.fn<GroupStateSnapshotsRepositoryModule['findGroupStateSnapshotByRef']>(throwGroupRepositoryMissing),
        getAllGroupStateSnapshots: vi.fn<GroupStateSnapshotsRepositoryModule['getAllGroupStateSnapshots']>(throwGroupRepositoryMissing)
    };
});

vi.mock(
    import('@shared-web/browser/app-context.ts'),
    (): Partial<AppContextModule> => ({
        clearMiddleware: vi.fn(),
        getMiddleware: vi.fn(() => mocks.ctx),
        initMiddleware: mocks.initMiddleware,
        isMiddlewareReady: mocks.isMiddlewareReady
    })
);

vi.mock(
    import('@shared-web/browser/api-workflows.ts'),
    (): Partial<ApiWorkflowsModule> => ({
        refreshStateSnapshots: mocks.refreshStateSnapshots
    })
);

vi.mock(
    import('@shared-web/browser/data-caches.ts'),
    (): Partial<DataCachesModule> => ({
        hydrateStateCaches: mocks.hydrateStateCaches,
        onStateCacheChange: mocks.onStateCacheChange
    })
);

vi.mock(import('@shared/api/auth.ts'), (): Partial<AuthModule> => ({
    clearSession: vi.fn(),
    isLoggedIn: vi.fn(() => true),
    readSession: mocks.readSession,
    writeSession: vi.fn()
}));

vi.mock(
    import('@shared/repository/client-state-snapshots-repository.ts'),
    (): Partial<ClientStateSnapshotsRepositoryModule> => ({
        findClientStateSnapshotByPrincipalId: mocks.clientRepositoryMissing,
        getAllClientStateSnapshots: mocks.clientRepositoryMissing
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

describe('Rallar startup lifecycle compatibility', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.clientRepositoryMissing.mockImplementation(
            mocks.throwClientRepositoryMissing
        );
        mockGroupRepositoryMissing();
        mocks.hydrateStateCaches.mockResolvedValue(undefined);
        mocks.initMiddleware.mockResolvedValue(mocks.ctx);
        mocks.isMiddlewareReady.mockReturnValue(false);
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

        expect(mocks.initMiddleware).toHaveBeenCalledWith(
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
        expect(result.middleware).toBe(mocks.ctx);
        expect(result.roomState?.rooms.map((room) => room.roomId)).toEqual([
            'match-1'
        ]);
        expect(result.peopleState?.clients).toEqual([]);
        expect(mocks.initMiddleware).toHaveBeenCalledWith({
            onAuthInvalid: expect.any(Function),
            scope: {
                applicationId: 'default-app',
                workspaceId: 'default'
            },
            timeoutMs: 123
        });
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
        expect(mocks.initMiddleware).not.toHaveBeenCalled();
        expect(mocks.refreshStateSnapshots).not.toHaveBeenCalled();
    });
});

function mockGroupRepositoryMissing(): void {
    mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockImplementation(
        mocks.throwGroupRepositoryMissing
    );
    mocks.findGroupStateSnapshotByRef.mockImplementation(
        mocks.throwGroupRepositoryMissing
    );
    mocks.getAllGroupStateSnapshots.mockImplementation(
        mocks.throwGroupRepositoryMissing
    );
}

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
        snapshots.find((snapshot) => sessionId === snapshot.group.groupId)?.group
    );
}

function createGroupSnapshot(
    groupId: string,
    sessionIds: readonly string[],
    scope: Readonly<{
        applicationId?: string;
        workspaceId?: string;
    }> = {}
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
