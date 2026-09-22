import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import type * as MiddlewareModule from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import type * as StateCacheLifecycleModule from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
import type * as RefreshStateSnapshotsModule from '@shared-web/browser/state-read/refresh-state-snapshots.ts';
import { clearSession, readSession, resetAuthSessionStorage, writeSession } from '@shared/api/auth.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type * as ClientStateSnapshotsRepositoryModule from '@shared/repository/client-state-snapshots-repository.ts';
import type * as GroupStateSnapshotsRepositoryModule from '@shared/repository/group-state-snapshots-repository.ts';

import { createGroupSnapshotFixture } from './authoritative-group-fixtures.ts';

interface GroupSnapshotFixtureScope {
    readonly applicationId?: string;
    readonly workspaceId?: string;
}

const mocks = await vi.hoisted(async () => {
    const { createDefaultApiMiddlewareTestDouble } = await import(
        './api-middleware-test-double.ts'
    );
    const apiMiddleware = createDefaultApiMiddlewareTestDouble();
    return {
        apiMiddleware,
        hydrateStateCache: vi.fn<typeof StateCacheLifecycleModule.browserStateCacheLifecycle.hydrate>(() => Promise.resolve()),
        initialiseMiddleware: vi.fn<typeof MiddlewareModule.initialiseMiddleware>(() => Promise.resolve(apiMiddleware.middleware)),
        onCacheChange: vi.fn<typeof StateCacheLifecycleModule.browserStateCacheLifecycle.onChange>(() => vi.fn()),
        refreshStateSnapshots: vi.fn<typeof RefreshStateSnapshotsModule.refreshStateSnapshots>(() => Promise.resolve({ clients: [], groups: [] })),
        findClientStateSnapshotByPrincipalId: vi.fn<typeof ClientStateSnapshotsRepositoryModule.findClientStateSnapshotByPrincipalId>(() => undefined),
        getAllClientStateSnapshots: vi.fn<typeof ClientStateSnapshotsRepositoryModule.getAllClientStateSnapshots>(() => []),
        findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn<typeof GroupStateSnapshotsRepositoryModule.findFirstGroupStateSnapshotRefSessionIdIsIn>(() =>
            undefined
        ),
        findGroupStateSnapshotByRef: vi.fn<typeof GroupStateSnapshotsRepositoryModule.findGroupStateSnapshotByRef>(() => undefined),
        getAllGroupStateSnapshots: vi.fn<typeof GroupStateSnapshotsRepositoryModule.getAllGroupStateSnapshots>(() => [])
    };
});

vi.mock(
    import('@shared-web/browser/connection/initialise-browser-middleware.ts'),
    (): Partial<typeof MiddlewareModule> => ({
        initialiseMiddleware: mocks.initialiseMiddleware
    })
);

vi.mock(
    import('@shared-web/browser/state-read/refresh-state-snapshots.ts'),
    (): Partial<typeof RefreshStateSnapshotsModule> => ({
        refreshStateSnapshots: mocks.refreshStateSnapshots
    })
);

vi.mock(
    import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts'),
    (): Partial<typeof StateCacheLifecycleModule> => ({
        browserStateCacheLifecycle: {
            hydrate: mocks.hydrateStateCache,
            onChange: mocks.onCacheChange,
            initialise: vi.fn(),
            cancelSnapshotAssemblies: vi.fn(() => undefined)
        }
    })
);

vi.mock(
    import('@shared/repository/client-state-snapshots-repository.ts'),
    (): Partial<typeof ClientStateSnapshotsRepositoryModule> => ({
        findClientStateSnapshotByPrincipalId: mocks.findClientStateSnapshotByPrincipalId,
        getAllClientStateSnapshots: mocks.getAllClientStateSnapshots
    })
);

vi.mock(
    import('@shared/repository/group-state-snapshots-repository.ts'),
    (): Partial<typeof GroupStateSnapshotsRepositoryModule> => ({
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
        mocks.initialiseMiddleware.mockResolvedValue(mocks.apiMiddleware.middleware);
        const storage = new Map<string, string>();
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
            removeItem: (key: string) => storage.delete(key)
        });
        resetAuthSessionStorage();
        writeSession(mocks.apiMiddleware.session);
        onTestFinished(async () => {
            (await import('@shared-web/browser/connection/browser-transport-runtime.ts'))
                .browserTransportRuntime.shutdown('test-finished');
            vi.unstubAllGlobals();
        });
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
            mocks.apiMiddleware.session,
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

        expect(result.session).toEqual(mocks.apiMiddleware.session);
        expect(result.connected).toBe(true);
        expect(result.middleware).toMatchObject({
            middleware: mocks.apiMiddleware.middleware,
            session: mocks.apiMiddleware.session
        });
        expect(result.roomState?.rooms.map((room) => room.roomId)).toEqual([
            'match-1'
        ]);
        expect(result.peopleState?.clients).toEqual([]);
        expect(mocks.initialiseMiddleware).toHaveBeenCalledWith(
            mocks.apiMiddleware.session,
            expect.any(String),
            expect.objectContaining({
                scope: {
                    applicationId: 'default-app',
                    workspaceId: 'default'
                },
                timeoutMs: 123
            })
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
        clearSession();
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
        facade.auth.onChange((state) => {
            authChanges.push(state.reason);
        }, {
            emitCurrent: false
        });

        await expect(facade.connect()).rejects.toThrow('expired');

        expect(readSession()).toBeUndefined();
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
