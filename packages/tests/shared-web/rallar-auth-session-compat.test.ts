import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import {
    newALRoute,
    newALUnicastMessage,
} from '@shared/al-contracts/al-contract.ts';

const mocks = vi.hoisted(() => {
    const session = {
        clientId: 'principal-1',
        sessionId: 'session-1',
        username: 'principal-1',
        accessToken: 'token-1',
        expiresAtEpochMs: Date.now() + 60_000,
    };
    const webRtcConnectionService = {
        peerIdsWithNoReconnectableLanes: vi.fn((): readonly string[] => []),
        knownPeerIds: vi.fn((): readonly string[] => []),
        activePeerIds: vi.fn((): readonly string[] => []),
        readyPeerIdsForLane: vi.fn((_laneId?: string): readonly string[] => []),
        ensurePeerConnectionStarted: vi.fn((_peerId: string) =>
            ({
                left: {
                    kind: 'connect-failed',
                    peerId: _peerId,
                    error: new Error('connect not mocked'),
                },
            })
        ),
        ensurePeerLaneOpen: vi.fn(async (peerId: string, laneId: string) => ({
            status: 'connect-failed',
            peerId,
            laneId,
            error: new Error('connect not mocked'),
        })),
        disconnectPeer: vi.fn(() => true),
        onRtcPeerLifecycleDo: vi.fn(),
        readPeer: vi.fn(),
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
                onRemoteStreamDo: vi.fn(),
                removeOnRemoteStreamCallbackById: vi.fn(),
                setLocalMediaStream: vi.fn(),
                setLocalAudioEnabled: vi.fn(),
                setLocalVideoEnabled: vi.fn(),
                setMediaPolicy: vi.fn(),
                stopLocalMedia: vi.fn(),
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
        clearSession: vi.fn(),
        clearMiddleware: vi.fn(),
        hydrateStateCaches: vi.fn(() => Promise.resolve()),
        initMiddleware: vi.fn((_options?: unknown) => Promise.resolve(ctx)),
        isMiddlewareReady: vi.fn(() => false),
        createAndJoinStateGroup: vi.fn(
            (
                _displayName?: unknown,
                _principalId?: unknown,
                _sessionId?: unknown,
                _scope?: unknown,
                _policies?: unknown,
            ) => Promise.reject(new Error('create not mocked')),
        ),
        joinStateGroup: vi.fn(
            (
                _roomId?: unknown,
                _principalId?: unknown,
                _sessionId?: unknown,
                _scope?: unknown,
                _policies?: unknown,
            ) => Promise.reject(new Error('join not mocked')),
        ),
        leaveStateGroup: vi.fn(
            (
                _roomId?: unknown,
                _principalId?: unknown,
                _sessionId?: unknown,
                _scope?: unknown,
                _policies?: unknown,
            ) => Promise.reject(new Error('leave not mocked')),
        ),
        updateStateGroupMetadata: vi.fn(
            (
                _roomId?: unknown,
                _patch?: unknown,
                _principalId?: unknown,
                _sessionId?: unknown,
                _scope?: unknown,
                _policies?: unknown,
            ) => Promise.reject(new Error('metadata update not mocked')),
        ),
        loginToApi: vi.fn((_request?: unknown, _options?: unknown) =>
            Promise.resolve(session)
        ),
        listStateClientEvents: vi.fn((_principalId?: unknown, _scope?: unknown, _options?: unknown) =>
            Promise.reject(new Error('client events not mocked'))
        ),
        listStateClientEventPage: vi.fn((_principalId?: unknown, _scope?: unknown, _options?: unknown) =>
            Promise.reject(new Error('client event page not mocked'))
        ),
        listStateGroupEvents: vi.fn((_groupId?: unknown, _scope?: unknown, _options?: unknown) =>
            Promise.reject(new Error('group events not mocked'))
        ),
        listStateGroupEventPage: vi.fn((_groupId?: unknown, _scope?: unknown, _options?: unknown) =>
            Promise.reject(new Error('group event page not mocked'))
        ),
        logoutFromApi: vi.fn((_options?: unknown) =>
            Promise.resolve({ loggedOut: true })
        ),
        registerWithApi: vi.fn((_request?: unknown, _options?: unknown) =>
            Promise.resolve({
                clientId: 'client-new',
                username: 'new-user',
                registeredAtEpochMs: 1_000,
            })
        ),
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
        webRtcConnectionService,
        writeSession: vi.fn(),
    };
});

vi.mock('@shared-web/browser/app-context.ts', () => ({
    clearMiddleware: mocks.clearMiddleware,
    getMiddleware: vi.fn(() => mocks.ctx),
    initMiddleware: mocks.initMiddleware,
    isMiddlewareReady: mocks.isMiddlewareReady,
}));

vi.mock('@shared-web/browser/api-integration.ts', () => ({
    listStateClientEventPage: mocks.listStateClientEventPage,
    listStateClientEvents: mocks.listStateClientEvents,
    listStateGroupEventPage: mocks.listStateGroupEventPage,
    listStateGroupEvents: mocks.listStateGroupEvents,
    loginToApi: mocks.loginToApi,
    logoutFromApi: mocks.logoutFromApi,
    registerWithApi: mocks.registerWithApi,
}));

vi.mock('@shared-web/browser/api-workflows.ts', () => ({
    createAndJoinStateGroup: mocks.createAndJoinStateGroup,
    joinStateGroup: mocks.joinStateGroup,
    leaveStateGroup: mocks.leaveStateGroup,
    refreshStateSnapshots: mocks.refreshStateSnapshots,
    updateStateGroupMetadata: mocks.updateStateGroupMetadata,
}));

vi.mock('@shared-web/browser/data-caches.ts', () => ({
    hydrateStateCaches: mocks.hydrateStateCaches,
    onStateCacheChange: mocks.onStateCacheChange,
}));

vi.mock('@shared/api/auth.ts', () => ({
    clearSession: mocks.clearSession,
    isLoggedIn: vi.fn(() => true),
    readSession: mocks.readSession,
    writeSession: mocks.writeSession,
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

describe('Rallar auth session compatibility', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
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
        mocks.refreshStateSnapshots.mockResolvedValue({ clients: [], groups: [] });
        mocks.initMiddleware.mockResolvedValue(mocks.ctx);
        mocks.isMiddlewareReady.mockReturnValue(false);
        mocks.clearSession.mockImplementation(() => undefined);
        mocks.readSession.mockReturnValue(mocks.ctx.session);
        mocks.logoutFromApi.mockResolvedValue({ loggedOut: true });
        mocks.createAndJoinStateGroup.mockRejectedValue(new Error('create not mocked'));
        mocks.joinStateGroup.mockRejectedValue(new Error('join not mocked'));
        mocks.leaveStateGroup.mockRejectedValue(new Error('leave not mocked'));
        mocks.updateStateGroupMetadata.mockRejectedValue(
            new Error('metadata update not mocked'),
        );
        mocks.webRtcConnectionService.peerIdsWithNoReconnectableLanes
            .mockReturnValue([]);
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue([]);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue([]);
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue([]);
        mocks.webRtcConnectionService.ensurePeerConnectionStarted.mockImplementation(
            (peerId: string) =>
                ({
                    left: {
                        kind: 'connect-failed',
                        peerId,
                        error: new Error('connect not mocked'),
                    },
                }),
        );
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId: string, laneId: string) => ({
                status: 'connect-failed',
                peerId,
                laneId,
                error: new Error('connect not mocked'),
            }),
        );
        mocks.webRtcConnectionService.onRtcPeerLifecycleDo.mockImplementation(() =>
            mocks.webRtcConnectionService
        );
        mocks.webRtcConnectionService.readPeer.mockReturnValue(undefined);
        mocks.webRtcConnectionService.removeRtcPeerLifecycleById.mockReturnValue(true);
        mocks.ctx.middleware.rtcRxStreamer.enqueueOutboxIfAbsent.mockResolvedValue({
            status: 'enqueued',
            entries: [],
        });
        mocks.ctx.middleware.rtcRxStreamer.onInboxMessageDo.mockReturnValue(
            mocks.ctx.middleware.rtcRxStreamer,
        );
        mocks.ctx.middleware.rtcRxStreamer.removeInboxMessageCallback
            .mockReturnValue(true);
        mocks.ctx.middleware.webSocketQueueBox.enqueueOutboxIfAbsent.mockResolvedValue({
            status: 'enqueued',
            entries: [],
        });
        mocks.ctx.middleware.webSocketQueueBox.onAnyInboxMessageDo.mockReturnValue(
            mocks.ctx.middleware.webSocketQueueBox,
        );
        mocks.ctx.middleware.webSocketQueueBox.removeAnyInboxMessageCallback
            .mockReturnValue(true);
        mocks.ctx.middleware.webSocketQueueBox.readHealth.mockReturnValue({
            sessionId: mocks.ctx.session.sessionId,
            url: 'ws://localhost/ws',
            readyState: 'missing',
            isOpen: false,
            reconnecting: false,
            reconnectEnabled: false,
            reconnectAttempts: 0,
            maxReconnectAttempts: 12,
            reconnectExhausted: false,
        });
        mocks.ctx.middleware.webSocketQueueBox.close.mockImplementation(
            (code?: number, reason?: string) => {
                mocks.ctx.middleware.webSocketQueueBox.socket.close(code, reason);
            },
        );
        mocks.ctx.middleware.webSocketQueueBox.socket.onWebsocketCallbacksDo
            .mockReturnValue(mocks.ctx.middleware.webSocketQueueBox.socket);
        mocks.ctx.middleware.webSocketQueueBox.socket.removeWebsocketCallbackById
            .mockReturnValue(true);
        mocks.registerWithApi.mockResolvedValue({
            clientId: 'client-new',
            username: 'new-user',
            registeredAtEpochMs: 1_000,
        });
        mocks.listStateClientEvents.mockRejectedValue(
            new Error('client events not mocked'),
        );
        mocks.listStateClientEventPage.mockRejectedValue(
            new Error('client event page not mocked'),
        );
        mocks.listStateGroupEvents.mockRejectedValue(
            new Error('group events not mocked'),
        );
        mocks.listStateGroupEventPage.mockRejectedValue(
            new Error('group event page not mocked'),
        );
    });

    it('passes signal and timeout options into auth login', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const signal = new AbortController().signal;

        await createRallarFacade().auth.login(
            {
                username: 'principal-1',
                password: 'password-1',
            },
            {
                signal,
                timeoutMs: 123,
            },
        );

        expect(mocks.loginToApi.mock.calls[0]?.[0]).toEqual({
            username: 'principal-1',
            password: 'password-1',
        });
        const loginOptions = mocks.loginToApi.mock.calls[0]?.[1] as
            | { signal?: AbortSignal }
            | undefined;
        expect(loginOptions?.signal).toBeInstanceOf(AbortSignal);
    });

    it('emits the current auth state to auth change subscribers', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const listener = vi.fn();

        const unsubscribe = createRallarFacade().auth.onChange(listener);

        expect(listener).toHaveBeenCalledWith({
            authenticated: true,
            reason: 'current',
            session: mocks.ctx.session,
        });

        unsubscribe();
    });

    it('locally logs out and tears down active transports when the session expires', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const expiringSession = {
            ...mocks.ctx.session,
            expiresAtEpochMs: 1_500,
        };
        mocks.initMiddleware.mockResolvedValue({
            ...mocks.ctx,
            session: expiringSession,
        } as ApiMiddleware);
        mocks.readSession.mockImplementation(() =>
            Date.now() >= expiringSession.expiresAtEpochMs
                ? undefined
                : expiringSession
        );
        const facade = createRallarFacade();
        const authListener = vi.fn();
        facade.auth.onChange(authListener, { emitCurrent: false });

        await facade.connect();
        await vi.advanceTimersByTimeAsync(500);
        await Promise.resolve();
        await Promise.resolve();

        expect(mocks.ctx.middleware.webSocketQueueBox.close)
            .toHaveBeenCalledWith(1000, 'rallar-disconnect');
        expect(mocks.ctx.middleware.heartbeat.stop).toHaveBeenCalledOnce();
        expect(mocks.ctx.middleware.rtcRxStreamer.stopAllHeartbeats)
            .toHaveBeenCalledOnce();
        expect(mocks.logoutFromApi).not.toHaveBeenCalled();
        expect(mocks.clearSession).toHaveBeenCalledOnce();
        expect(authListener).toHaveBeenCalledWith({
            authenticated: false,
            reason: 'expired',
            session: undefined,
        });
        expect(facade.isConnected()).toBe(false);
    });

    it('does not expire a replacement session when an old expiry timer fires', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const oldSession = {
            ...mocks.ctx.session,
            expiresAtEpochMs: 1_500,
        };
        const nextSession = {
            ...mocks.ctx.session,
            sessionId: 'session-2',
            accessToken: 'token-2',
            expiresAtEpochMs: 10_000,
        };
        let currentSession = oldSession;
        mocks.initMiddleware.mockResolvedValue({
            ...mocks.ctx,
            session: oldSession,
        } as ApiMiddleware);
        mocks.readSession.mockImplementation(() => currentSession);
        const facade = createRallarFacade();

        await facade.connect();
        currentSession = nextSession;
        mocks.clearSession.mockClear();
        mocks.ctx.middleware.webSocketQueueBox.close.mockClear();
        await vi.advanceTimersByTimeAsync(500);

        expect(mocks.clearSession).not.toHaveBeenCalled();
        expect(mocks.ctx.middleware.webSocketQueueBox.close).not.toHaveBeenCalled();
    });

    it('locally logs out on API 401 without calling the logout endpoint', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();
        const authListener = vi.fn();
        facade.auth.onChange(authListener, { emitCurrent: false });
        await facade.connect();
        mocks.refreshStateSnapshots.mockRejectedValue(
            Object.assign(new Error('Unauthorized'), { status: 401 }),
        );

        await expect(facade.rooms.refresh()).rejects.toThrow('Unauthorized');

        expect(mocks.ctx.middleware.webSocketQueueBox.close)
            .toHaveBeenCalledWith(1000, 'rallar-disconnect');
        expect(mocks.logoutFromApi).not.toHaveBeenCalled();
        expect(mocks.clearSession).toHaveBeenCalledOnce();
        expect(authListener).toHaveBeenCalledWith({
            authenticated: false,
            reason: 'unauthorized',
            session: undefined,
        });
    });

    it('emits unauthorized auth state once when nested room operations see the same 401', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();
        const authListener = vi.fn();
        const oldRoom = createGroupSnapshot('old-room', ['session-1']);
        const newRoom = createGroupSnapshot('new-room', ['session-1']);

        facade.setDefaults({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        });
        mocks.joinStateGroup.mockResolvedValueOnce(oldRoom);
        await facade.rooms.join('old-room');
        mockGroupSnapshot(oldRoom);

        facade.auth.onChange(authListener, { emitCurrent: false });
        mocks.joinStateGroup.mockResolvedValueOnce(newRoom);
        mocks.leaveStateGroup.mockRejectedValueOnce(
            Object.assign(new Error('Unauthorized'), { status: 401 }),
        );

        await expect(facade.rooms.join('new-room')).rejects.toThrow('Unauthorized');

        expect(authListener).toHaveBeenCalledTimes(1);
        expect(authListener).toHaveBeenCalledWith({
            authenticated: false,
            reason: 'unauthorized',
            session: undefined,
        });
        expect(mocks.clearSession).toHaveBeenCalledOnce();
    });

    it('does not locally log out on API 403 authorization errors', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();
        await facade.connect();
        mocks.ctx.middleware.webSocketQueueBox.close.mockClear();
        mocks.refreshStateSnapshots.mockRejectedValue(
            Object.assign(new Error('Forbidden'), { status: 403 }),
        );

        await expect(facade.rooms.refresh()).rejects.toThrow('Forbidden');

        expect(mocks.ctx.middleware.webSocketQueueBox.close).not.toHaveBeenCalled();
        expect(mocks.logoutFromApi).not.toHaveBeenCalled();
        expect(mocks.clearSession).not.toHaveBeenCalled();
    });

    it('passes an explicit admin session into auth registration', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const signal = new AbortController().signal;
        const adminSession = {
            ...mocks.ctx.session,
            clientId: 'admin',
            accessToken: 'admin-token',
            username: 'admin',
        };

        await createRallarFacade().auth.register(
            {
                username: 'new-user',
                password: 'password-1',
                displayName: 'New User',
            },
            {
                adminSession,
                signal,
                timeoutMs: 123,
            },
        );

        expect(mocks.registerWithApi.mock.calls[0]?.[0]).toEqual({
            username: 'new-user',
            password: 'password-1',
            displayName: 'New User',
        });
        const registerOptions = mocks.registerWithApi.mock.calls[0]?.[1] as
            | { signal?: AbortSignal; authSession?: unknown }
            | undefined;
        expect(registerOptions?.signal).toBeInstanceOf(AbortSignal);
        expect(registerOptions?.authSession).toBe(adminSession);
    });

    it('can register and then log in with the new user', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );

        await createRallarFacade().auth.registerAndLogin({
            username: 'new-user',
            password: 'password-1',
        });

        expect(mocks.registerWithApi).toHaveBeenCalledOnce();
        expect(mocks.loginToApi).toHaveBeenCalledWith(
            {
                username: 'new-user',
                password: 'password-1',
            },
            expect.any(Object),
        );
        expect(mocks.writeSession).toHaveBeenCalledWith(mocks.ctx.session);
    });

    it('revokes the backend session when logging out', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const signal = new AbortController().signal;

        await createRallarFacade().auth.logout({ signal, timeoutMs: 123 });

        expect(mocks.logoutFromApi).toHaveBeenCalledOnce();
        const logoutOptions = mocks.logoutFromApi.mock.calls[0]?.[0] as
            | { signal?: AbortSignal }
            | undefined;
        expect(logoutOptions?.signal).toBeInstanceOf(AbortSignal);
        expect(mocks.clearSession).toHaveBeenCalledOnce();
    });

    it('clears local auth before revoking manual logout and uses the captured session', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );

        await createRallarFacade().auth.logout();

        expect(mocks.clearSession).toHaveBeenCalledOnce();
        expect(mocks.logoutFromApi).toHaveBeenCalledOnce();
        expect(mocks.clearSession.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.logoutFromApi.mock.invocationCallOrder[0]);
        expect(mocks.logoutFromApi.mock.calls[0]?.[0]).toMatchObject({
            authSession: mocks.ctx.session,
        });
    });

    it('does not reconnect with a stale session while manual logout is in progress', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        let storedSession: typeof mocks.ctx.session | undefined = mocks.ctx.session;
        let releaseLogout: (() => void) | undefined;
        mocks.readSession.mockImplementation(() => storedSession);
        mocks.clearSession.mockImplementation(() => {
            storedSession = undefined;
        });
        mocks.logoutFromApi.mockImplementation(
            () =>
                new Promise((resolve) => {
                    releaseLogout = () => resolve({ loggedOut: true });
                }),
        );
        const facade = createRallarFacade();

        await facade.connect();
        const logoutPromise = facade.auth.logout();
        await vi.waitFor(() => {
            expect(mocks.logoutFromApi).toHaveBeenCalledOnce();
        });

        const startPromise = facade.start();
        await Promise.resolve();
        expect(mocks.initMiddleware).toHaveBeenCalledTimes(1);
        releaseLogout?.();
        const startResult = await startPromise;
        await logoutPromise;

        expect(startResult).toEqual({
            session: undefined,
            connected: false,
        });
    });

    it('closes WS through the queue-box service when logging out after connect', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        const facade = createRallarFacade();

        await facade.connect();
        await facade.auth.logout();

        expect(mocks.ctx.middleware.webSocketQueueBox.close)
            .toHaveBeenCalledWith(1000, 'rallar-disconnect');
        expect(mocks.ctx.middleware.heartbeat.stop).toHaveBeenCalledOnce();
        expect(mocks.ctx.middleware.rtcRxStreamer.stopAllHeartbeats)
            .toHaveBeenCalledOnce();
        expect(mocks.logoutFromApi).toHaveBeenCalledOnce();
        expect(mocks.clearSession).toHaveBeenCalledOnce();
    });

    it('disconnects every known RTC peer, including stale lane peers', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
            );
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue([
            'peer-ready',
            'peer-stale',
        ]);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue([
            'peer-ready',
            'peer-stale',
        ]);
        mocks.webRtcConnectionService.peerIdsWithNoReconnectableLanes
            .mockReturnValue(['peer-ready']);
        mocks.webRtcConnectionService.readyPeerIdsForLane
            .mockReturnValue(['peer-ready']);
        const facade = createRallarFacade();
        const wsLifecycle: unknown[] = [];
        facade.ws.onLifecycle(
            (event) => wsLifecycle.push(event),
            {
                emitCurrent: false,
            },
        );

        await facade.connect();
        await facade.disconnect();

        expect(mocks.webRtcConnectionService.disconnectPeer)
            .toHaveBeenCalledWith('peer-ready');
        expect(mocks.webRtcConnectionService.disconnectPeer)
            .toHaveBeenCalledWith('peer-stale');
        expect(mocks.webRtcConnectionService.disconnectPeer)
            .toHaveBeenCalledTimes(2);
        expect(mocks.ctx.middleware.webSocketQueueBox.close)
            .toHaveBeenCalledWith(1000, 'rallar-disconnect');
        expect(mocks.ctx.middleware.webSocketQueueBox.socket.close)
            .toHaveBeenCalledWith(1000, 'rallar-disconnect');
        expect(mocks.clearMiddleware).toHaveBeenCalledOnce();
        expect(wsLifecycle.at(-1)).toMatchObject({
            kind: 'disconnected',
            code: 1000,
            reason: 'rallar-disconnect',
            intentional: true,
            status: {
                connectState: 'idle',
                readyState: 'missing',
                reconnectEnabled: false,
            },
        });
    });

});


function findLatestWsAnyMessageCallback(): {
    onMessage?: (message: unknown) => Promise<void>;
} | undefined {
    return mocks.ctx.middleware.webSocketQueueBox
        .onAnyInboxMessageDo.mock.calls
        .filter(([callbackId]) => callbackId === 'rallar:ws:any-message')
        .at(-1)?.[1] as { onMessage?: (message: unknown) => Promise<void> } | undefined;
}

function createChannelHealth(
    input: Readonly<{
        peerId: string;
        label: string;
        state: string;
        readyState: RTCDataChannelState;
    }>,
) {
    return {
        peerId: input.peerId,
        label: input.label,
        state: input.state,
        role: 'Initiator',
        readyState: input.readyState,
        binaryType: 'arraybuffer' as const,
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0,
        queuedItemCount: 0,
        rawCallbackCount: 0,
        messageCallbackCount: 0,
        lifecycleCallbackCount: 0,
        flowControl: {
            highWatermarkBytes: 64 * 1024,
            lowWatermarkBytes: 16 * 1024,
            overflow: 'drop-new' as const,
            maxQueueItems: 32,
        },
        counters: {
            sent: 0,
            queued: 0,
            dropped: 0,
            replaced: 0,
            closed: 0,
            flushed: 0,
            droppedOldest: 0,
            droppedStale: 0,
            receivedRaw: 0,
            receivedString: 0,
            receivedBinary: 0,
        },
    };
}

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

function withSnapshotVersion(
    snapshot: GroupSnapshot,
    snapshotVersion: number,
): GroupSnapshot {
    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            snapshotVersion,
        },
    };
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

function createDirectorGroupSnapshot(
    appointment?: Readonly<{
        sessionId: string;
        principalId: string;
        epoch: number;
        appointedAtEpochMs: number;
        heartbeatTtlMs: number;
    }>,
): GroupSnapshot {
    const snapshot = createGroupSnapshot('room-1', ['session-1']);
    const activeSessions = [
        {
            ...snapshot.activeSessions[0],
            principalId: 'principal-1',
            sessionId: 'session-1',
        },
    ];
    const members = [
        {
            ...snapshot.members[0],
            principalId: 'principal-1',
            role: 'owner' as const,
        },
    ];

    if (appointment) {
        activeSessions.push({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            principalId: appointment.principalId,
            sessionId: appointment.sessionId,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_000,
        });
        members.push({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            principalId: appointment.principalId,
            role: 'member',
            status: 'active',
            joined: {
                atEpochMs: 1,
                byPrincipalId: 'principal-1',
            },
            updated: {
                atEpochMs: 1,
                byPrincipalId: 'principal-1',
            },
        });
    }

    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            created: {
                ...snapshot.group.created,
                byPrincipalId: 'principal-1',
            },
            metadata: appointment
                ? {
                    rallarDirector: {
                        version: 1,
                        mode: 'appointed-spa',
                        ...appointment,
                    },
                }
                : {},
        },
        members,
        activeSessions,
        memberCount: members.length,
        onlineMemberCount: activeSessions.length,
    };
}

function createDeferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
} {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });

    return { promise, resolve, reject };
}

function createMediaTrack(
    id: string,
    kind: 'audio' | 'video',
): MediaStreamTrack {
    const listeners = new Set<EventListenerOrEventListenerObject>();
    const track = {
        id,
        kind,
        enabled: true,
        readyState: 'live',
        addEventListener: vi.fn((
            type: string,
            listener: EventListenerOrEventListenerObject,
        ) => {
            if (type === 'ended') {
                listeners.add(listener);
            }
        }),
        removeEventListener: vi.fn((
            type: string,
            listener: EventListenerOrEventListenerObject,
        ) => {
            if (type === 'ended') {
                listeners.delete(listener);
            }
        }),
        stop: vi.fn(() => {
            track.readyState = 'ended';
            const event = { type: 'ended' } as Event;
            for (const listener of listeners) {
                if (typeof listener === 'function') {
                    listener(event);
                } else {
                    listener.handleEvent(event);
                }
            }
        }),
    };

    return track as unknown as MediaStreamTrack;
}

function createMediaStream(
    id: string,
    tracks: readonly MediaStreamTrack[],
): MediaStream {
    return {
        id,
        active: tracks.some((track) => track.readyState !== 'ended'),
        getTracks: vi.fn(() => [...tracks]),
        getAudioTracks: vi.fn(() =>
            tracks.filter((track) => track.kind === 'audio')
        ),
        getVideoTracks: vi.fn(() =>
            tracks.filter((track) => track.kind === 'video')
        ),
    } as unknown as MediaStream;
}
