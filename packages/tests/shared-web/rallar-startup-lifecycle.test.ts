import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';

const mocks = vi.hoisted(() => {
    const session = {
        clientId: 'principal-1',
        sessionId: 'session-1',
        username: 'principal-1',
        accessToken: 'token-1',
        expiresAtEpochMs: Date.now() + 60_000,
    };
    const webRtcConnectionService = {
        knownPeerIds: vi.fn((): readonly string[] => []),
        activePeerIds: vi.fn((): readonly string[] => []),
        disconnectPeer: vi.fn(() => true),
        onRtcPeerLifecycleDo: vi.fn(),
        removeRtcPeerLifecycleById: vi.fn(() => true),
    };
    webRtcConnectionService.onRtcPeerLifecycleDo.mockImplementation(() =>
        webRtcConnectionService
    );
    const ctx = {
        session,
        authFetch: vi.fn(),
        middleware: {
            qboxEngine: {
                wake: vi.fn(),
                stop: vi.fn(),
            },
            rtcRxStreamer: {
                enqueueOutboxIfAbsent: vi.fn(async () => ({
                    status: 'enqueued',
                    entries: [],
                })),
                onInboxMessageDo: vi.fn(),
                removeInboxMessageCallback: vi.fn(() => true),
                stopAllHeartbeats: vi.fn(),
            },
            webRtcGroupManager: {},
            webRtcConnectionService,
            heartbeat: {
                stop: vi.fn(),
            },
            webSocketQueueBox: {
                enqueueOutboxIfAbsent: vi.fn(async () => ({
                    status: 'enqueued',
                    entries: [],
                })),
                readHealth: vi.fn(() => ({
                    sessionId: session.sessionId,
                    url: 'ws://localhost/ws',
                    readyState: 'missing',
                    isOpen: false,
                    reconnecting: false,
                    reconnectEnabled: false,
                    reconnectAttempts: 0,
                    maxReconnectAttempts: 12,
                    reconnectExhausted: false,
                })),
                close: vi.fn(),
                onAnyInboxMessageDo: vi.fn(),
                removeAnyInboxMessageCallback: vi.fn(() => true),
                socket: {
                    close: vi.fn(),
                    onWebsocketCallbacksDo: vi.fn(),
                    removeWebsocketCallbackById: vi.fn(() => true),
                },
            },
        },
    } as unknown as ApiMiddleware;

    return {
        ctx,
        hydrateStateCaches: vi.fn(() => Promise.resolve()),
        initMiddleware: vi.fn((_options?: unknown) => Promise.resolve(ctx)),
        isMiddlewareReady: vi.fn(() => false),
        onStateCacheChange: vi.fn(() => vi.fn()),
        readSession: vi.fn(() => session),
        refreshStateSnapshots: vi.fn((_scope?: unknown, _policies?: unknown) =>
            Promise.resolve({ clients: [], groups: [] })
        ),
        clientRepositoryMissing: vi.fn((_value?: unknown): unknown => {
            throw new Error(
                'Repository not found: shared.repository.client-state-snapshots',
            );
        }),
        groupRepositoryMissing: vi.fn((_value?: unknown): unknown => {
            throw new Error(
                'Repository not found: shared.repository.group-state-snapshots',
            );
        }),
    };
});

vi.mock('@shared-web/browser/app-context.ts', () => ({
    clearMiddleware: vi.fn(),
    getMiddleware: vi.fn(() => mocks.ctx),
    initMiddleware: mocks.initMiddleware,
    isMiddlewareReady: mocks.isMiddlewareReady,
}));

vi.mock('@shared-web/browser/api-workflows.ts', () => ({
    refreshStateSnapshots: mocks.refreshStateSnapshots,
}));

vi.mock('@shared-web/browser/data-caches.ts', () => ({
    hydrateStateCaches: mocks.hydrateStateCaches,
    onStateCacheChange: mocks.onStateCacheChange,
}));

vi.mock('@shared/api/auth.ts', () => ({
    clearSession: vi.fn(),
    isLoggedIn: vi.fn(() => true),
    readSession: mocks.readSession,
    writeSession: vi.fn(),
}));

vi.mock('@shared/repository/client-state-snapshots-repository.ts', () => ({
    findClientStateSnapshotByPrincipalId: mocks.clientRepositoryMissing,
    getAllClientStateSnapshots: mocks.clientRepositoryMissing,
}));

vi.mock('@shared/repository/group-state-snapshots-repository.ts', () => ({
    findFirstGroupStateSnapshotRefSessionIdIsIn: mocks.groupRepositoryMissing,
    findGroupStateSnapshotByRef: mocks.groupRepositoryMissing,
    getAllGroupStateSnapshots: mocks.groupRepositoryMissing,
}));

describe('Rallar startup lifecycle compatibility', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.clientRepositoryMissing.mockImplementation(() => {
            throw new Error(
                'Repository not found: shared.repository.client-state-snapshots',
            );
        });
        mocks.groupRepositoryMissing.mockImplementation(() => {
            throw new Error(
                'Repository not found: shared.repository.group-state-snapshots',
            );
        });
        mocks.hydrateStateCaches.mockResolvedValue(undefined);
        mocks.initMiddleware.mockResolvedValue(mocks.ctx);
        mocks.isMiddlewareReady.mockReturnValue(false);
        mocks.readSession.mockReturnValue(mocks.ctx.session);
        mocks.refreshStateSnapshots.mockResolvedValue({ clients: [], groups: [] });
        mocks.ctx.middleware.rtcRxStreamer.onInboxMessageDo.mockReturnValue(
            mocks.ctx.middleware.rtcRxStreamer,
        );
        mocks.ctx.middleware.rtcRxStreamer.removeInboxMessageCallback
            .mockReturnValue(true);
        mocks.ctx.middleware.webRtcConnectionService.onRtcPeerLifecycleDo
            .mockReturnValue(mocks.ctx.middleware.webRtcConnectionService);
        mocks.ctx.middleware.webSocketQueueBox.onAnyInboxMessageDo.mockReturnValue(
            mocks.ctx.middleware.webSocketQueueBox,
        );
        mocks.ctx.middleware.webSocketQueueBox.removeAnyInboxMessageCallback
            .mockReturnValue(true);
        mocks.ctx.middleware.webSocketQueueBox.socket.onWebsocketCallbacksDo
            .mockReturnValue(mocks.ctx.middleware.webSocketQueueBox.socket);
        mocks.ctx.middleware.webSocketQueueBox.socket.removeWebsocketCallbackById
            .mockReturnValue(true);
    });

    it('passes facade defaults into middleware startup scope', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();

        facade.setDefaults({
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
        });

        await facade.start({ refreshRooms: true });

        expect(mocks.initMiddleware).toHaveBeenCalledWith(
            expect.objectContaining({
                scope: {
                    applicationId: 'ar-eye-hunter',
                    workspaceId: 'default',
                },
            }),
        );
        expect(mocks.refreshStateSnapshots).toHaveBeenCalledWith(
            {
                applicationId: 'ar-eye-hunter',
                workspaceId: 'default',
            },
            expect.any(Object),
        );
    });

    it('starts by restoring a session, connecting, and refreshing requested state', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(createGroupSnapshot('match-1', ['session-1', 'peer-1'], {
            applicationId: 'default-app',
            workspaceId: 'default',
        }));
        const facade = createRallarFacade();
        facade.setDefaults({
            applicationId: 'default-app',
            operations: {
                timeoutMs: 123,
            },
        });

        const result = await facade.start({
            refreshRooms: true,
            refreshPeople: true,
        });

        expect(result.session).toEqual(mocks.ctx.session);
        expect(result.connected).toBe(true);
        expect(result.middleware).toBe(mocks.ctx);
        expect(result.roomState?.rooms.map((room) => room.roomId)).toEqual([
            'match-1',
        ]);
        expect(result.peopleState?.clients).toEqual([]);
        expect(mocks.initMiddleware).toHaveBeenCalledWith({
            onAuthInvalid: expect.any(Function),
            scope: {
                applicationId: 'default-app',
                workspaceId: 'default',
            },
            timeoutMs: 123,
        });
        expect(mocks.refreshStateSnapshots).toHaveBeenCalledWith(
            {
                applicationId: 'default-app',
                workspaceId: 'default',
            },
            {
                command: {
                    timeoutMs: 123,
                },
            },
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
            connected: false,
        });
        expect(mocks.initMiddleware).not.toHaveBeenCalled();
        expect(mocks.refreshStateSnapshots).not.toHaveBeenCalled();
    });
});

function mockGroupSnapshot(snapshot: GroupSnapshot): void {
    mockGroupSnapshots([snapshot]);
}

function mockGroupSnapshots(snapshots: readonly GroupSnapshot[]): void {
    mocks.groupRepositoryMissing.mockImplementation((key?: unknown) => {
        if (key === undefined) {
            return [...snapshots];
        }

        if (isGroupRefLike(key)) {
            return snapshots.find((snapshot) =>
                snapshot.group.groupId === key.groupId &&
                snapshot.group.applicationId === key.applicationId &&
                (snapshot.group.workspaceId ?? '') === (key.workspaceId ?? '')
            );
        }

        return snapshots.find((snapshot) => key === snapshot.group.groupId);
    });
}

function isGroupRefLike(value: unknown): value is GroupSnapshot['group'] {
    return typeof value === 'object' &&
        value !== null &&
        typeof (value as { groupId?: unknown }).groupId === 'string' &&
        typeof (value as { applicationId?: unknown }).applicationId === 'string';
}

function createGroupSnapshot(
    groupId: string,
    sessionIds: readonly string[],
    scope: Readonly<{
        applicationId?: string;
        workspaceId?: string;
    }> = {},
): GroupSnapshot {
    const applicationId = scope.applicationId ?? 'app-1';
    const workspaceId = scope.workspaceId ?? 'workspace-1';
    return {
        group: {
            applicationId,
            workspaceId,
            groupId,
            displayName: groupId,
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: {},
            snapshotVersion: 1,
            metadataVersion: 0,
            rosterVersion: 1,
            presenceVersion: 1,
            created: {
                atEpochMs: 1,
                byPrincipalId: 'creator',
            },
            updated: {
                atEpochMs: 1,
                byPrincipalId: 'creator',
            },
        },
        members: sessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: 'member',
            status: 'active',
            joined: {
                atEpochMs: 1,
                byPrincipalId: 'creator',
            },
            updated: {
                atEpochMs: 1,
                byPrincipalId: 'creator',
            },
        })),
        activeSessions: sessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId: sessionId,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_000,
        })),
        memberCount: sessionIds.length,
        onlineMemberCount: sessionIds.length,
    };
}
