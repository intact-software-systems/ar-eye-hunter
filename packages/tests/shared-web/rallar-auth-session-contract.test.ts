import type { Middleware } from '@shared-web/browser/middleware.ts';
import type { RallarAuthState } from '@shared-web/browser/session/rallar-auth-facade.ts';
import type { RallarWsLifecycleEvent } from '@shared-web/browser/rallar-realtime-facade.ts';
import { Either } from '@shared/resilience/Either.ts';
import { DEFAULT_RTC_DATA_CHANNEL_LANE_ID, type QRtcPeerDto, type WebRtcPeerConnectionLeft } from '@shared/services/WebRtcConnectionService.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthSessionApiHttpError, createAuthSessionGroupSnapshot, installGroupSnapshotRepositoryMocks } from './auth-session-contract-fixtures.ts';
import type * as ContractModules from './auth-session-contract-modules.ts';
import { createDeferred, createMediaStream, createMediaTrack } from './browser-lifecycle-fixtures.ts';

const mocks = await vi.hoisted(async () => {
    const { createApiMiddlewareTestDouble } = await import('./api-middleware-test-double.ts');
    const ctx = createApiMiddlewareTestDouble();
    const session = ctx.session;

    return {
        ctx,
        heartbeat: vi.mocked(ctx.middleware.heartbeat),
        qboxEngine: vi.mocked(ctx.middleware.qboxEngine),
        rtcRxStreamer: vi.mocked(ctx.middleware.rtcRxStreamer),
        webRtcConnectionService: vi.mocked(ctx.middleware.webRtcConnectionService),
        webSocketQueueBox: vi.mocked(ctx.middleware.webSocketQueueBox),
        webSocket: vi.mocked(ctx.middleware.webSocketQueueBox.socket),
        initialiseMiddleware: vi.fn<ContractModules.Middleware['initialiseMiddleware']>(() => Promise.resolve(ctx.middleware)),
        clearSession: vi.fn<ContractModules.Auth['clearSession']>(),
        readSession: vi.fn<ContractModules.Auth['readSession']>(() => session),
        writeSession: vi.fn<ContractModules.Auth['writeSession']>(),
        hydrateStateCache: vi.fn<ContractModules.StateCacheLifecycle['browserStateCacheLifecycle']['hydrate']>(() => Promise.resolve()),
        onCacheChange: vi.fn<ContractModules.StateCacheLifecycle['browserStateCacheLifecycle']['onChange']>(() => vi.fn()),
        deleteBrowserALRuntimeEntriesForSession: vi.fn<ContractModules.BrowserALRuntimeCleanup['deleteBrowserALRuntimeEntriesForSession']>(() =>
            Promise.resolve({
                dbName: '',
                storeName: '',
                keyPrefixes: [],
                scanned: 0,
                deleted: 0
            })
        ),
        createAndJoinStateGroup: vi.fn<ContractModules.RoomGroupStateWorkflows['createAndJoinStateGroup']>(() =>
            Promise.reject(new Error('create not mocked'))
        ),
        joinStateGroup: vi.fn<ContractModules.RoomGroupStateWorkflows['joinStateGroup']>(() => Promise.reject(new Error('join not mocked'))),
        leaveStateGroup: vi.fn<ContractModules.RoomGroupStateWorkflows['leaveStateGroup']>(() => Promise.reject(new Error('leave not mocked'))),
        updateStateGroupMetadata: vi.fn<ContractModules.RoomMutationWorkflows['updateStateGroupMetadata']>(() =>
            Promise.reject(new Error('metadata update not mocked'))
        ),
        refreshStateSnapshots: vi.fn<ContractModules.RefreshStateSnapshots['refreshStateSnapshots']>(
            () => Promise.resolve({ clients: [], groups: [] })
        ),
        loginToApi: vi.fn<ContractModules.AuthApi['loginToApi']>(() => Promise.resolve(session)),
        logoutFromApi: vi.fn<ContractModules.AuthApi['logoutFromApi']>(() => Promise.resolve({ loggedOut: true })),
        registerWithApi: vi.fn<ContractModules.AuthApi['registerWithApi']>(() =>
            Promise.resolve({
                clientId: 'client-new',
                username: 'new-user',
                displayName: null,
                registeredAtEpochMs: 1_000
            })
        ),
        listStateClientEvents: vi.fn<ContractModules.StateEventHttpApi['listStateClientEvents']>(
            () => Promise.reject(new Error('client events not mocked'))
        ),
        listStateClientEventPage: vi.fn<ContractModules.StateEventHttpApi['listStateClientEventPage']>(() =>
            Promise.reject(new Error('client event page not mocked'))
        ),
        listStateGroupEvents: vi.fn<ContractModules.StateEventHttpApi['listStateGroupEvents']>(
            () => Promise.reject(new Error('group events not mocked'))
        ),
        listStateGroupEventPage: vi.fn<ContractModules.StateEventHttpApi['listStateGroupEventPage']>(() =>
            Promise.reject(new Error('group event page not mocked'))
        ),
        clientRepositoryMissing: vi.fn(() => undefined),
        getAllClientStateSnapshots: vi.fn<ContractModules.ClientStateSnapshotsRepository['getAllClientStateSnapshots']>(() => []),
        findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn<ContractModules.GroupStateSnapshotsRepository['findFirstGroupStateSnapshotRefSessionIdIsIn']>(),
        findGroupStateSnapshotByRef: vi.fn<ContractModules.GroupStateSnapshotsRepository['findGroupStateSnapshotByRef']>(),
        getAllGroupStateSnapshots: vi.fn<ContractModules.GroupStateSnapshotsRepository['getAllGroupStateSnapshots']>()
    };
});

vi.mock(
    import('@shared-web/browser/middleware.ts'),
    (): Partial<ContractModules.Middleware> => ({
        initialiseMiddleware: mocks.initialiseMiddleware
    })
);

vi.mock(
    import('@shared-web/browser/state-read/state-event-http-api.ts'),
    (): Partial<ContractModules.StateEventHttpApi> => ({
        listStateClientEventPage: mocks.listStateClientEventPage,
        listStateClientEvents: mocks.listStateClientEvents,
        listStateGroupEventPage: mocks.listStateGroupEventPage,
        listStateGroupEvents: mocks.listStateGroupEvents
    })
);

vi.mock(
    import('@shared-web/browser/auth/session-http-api.ts'),
    (): Partial<ContractModules.AuthApi> => ({
        loginToApi: mocks.loginToApi,
        logoutFromApi: mocks.logoutFromApi,
        registerWithApi: mocks.registerWithApi
    })
);

vi.mock(import('@shared-web/browser/state-read/refresh-state-snapshots.ts'), (): Partial<ContractModules.RefreshStateSnapshots> => ({
    refreshStateSnapshots: mocks.refreshStateSnapshots
}));
vi.mock(import('@shared-web/browser/rooms/room-group-state-mutation-workflows.ts'), (): Partial<ContractModules.RoomMutationWorkflows> => ({
    updateStateGroupMetadata: mocks.updateStateGroupMetadata
}));

vi.mock(
    import('@shared-web/browser/rooms/room-group-state-workflows.ts'),
    (): Partial<ContractModules.RoomGroupStateWorkflows> => ({
        createAndJoinStateGroup: mocks.createAndJoinStateGroup,
        joinStateGroup: mocks.joinStateGroup,
        leaveStateGroup: mocks.leaveStateGroup
    })
);

vi.mock(
    import('@shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts'),
    (): Partial<ContractModules.BrowserALRuntimeCleanup> => ({
        deleteBrowserALRuntimeEntriesForSession: mocks.deleteBrowserALRuntimeEntriesForSession
    })
);

vi.mock(
    import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts'),
    (): Partial<ContractModules.StateCacheLifecycle> => ({
        browserStateCacheLifecycle: {
            hydrate: mocks.hydrateStateCache,
            onChange: mocks.onCacheChange,
            initialise: vi.fn()
        }
    })
);

vi.mock(import('@shared/api/auth.ts'), (): Partial<ContractModules.Auth> => ({
    clearSession: mocks.clearSession,
    isLoggedIn: vi.fn(() => true),
    readSession: mocks.readSession,
    writeSession: mocks.writeSession
}));

vi.mock(
    import('@shared/repository/client-state-snapshots-repository.ts'),
    (): Partial<ContractModules.ClientStateSnapshotsRepository> => ({
        findClientStateSnapshotByPrincipalId: mocks.clientRepositoryMissing,
        getAllClientStateSnapshots: mocks.getAllClientStateSnapshots
    })
);

vi.mock(
    import('@shared/repository/group-state-snapshots-repository.ts'),
    (): Partial<ContractModules.GroupStateSnapshotsRepository> => ({
        findFirstGroupStateSnapshotRefSessionIdIsIn: mocks.findFirstGroupStateSnapshotRefSessionIdIsIn,
        findGroupStateSnapshotByRef: mocks.findGroupStateSnapshotByRef,
        getAllGroupStateSnapshots: mocks.getAllGroupStateSnapshots
    })
);

describe('Rallar auth session contract', () => {
    beforeEach(async () => {
        (
            await import('@shared-web/browser/connection/browser-transport-runtime.ts')
        ).browserTransportRuntime.shutdown('test-reset');
        vi.clearAllMocks();
        vi.useRealTimers();
        mocks.clientRepositoryMissing.mockReturnValue(undefined);
        mocks.getAllClientStateSnapshots.mockReturnValue([]);
        installGroupSnapshotRepositoryMocks(mocks, []);
        mocks.refreshStateSnapshots.mockResolvedValue({ clients: [], groups: [] });
        mocks.initialiseMiddleware.mockResolvedValue(mocks.ctx.middleware);
        mocks.clearSession.mockImplementation(() => undefined);
        mocks.readSession.mockReturnValue(mocks.ctx.session);
        mocks.logoutFromApi.mockResolvedValue({ loggedOut: true });
        mocks.deleteBrowserALRuntimeEntriesForSession.mockResolvedValue({
            dbName: 'rallar-browser-al-runtime',
            storeName: 'entries',
            keyPrefixes: [],
            scanned: 0,
            deleted: 0
        });
        mocks.createAndJoinStateGroup.mockRejectedValue(
            new Error('create not mocked')
        );
        mocks.joinStateGroup.mockRejectedValue(new Error('join not mocked'));
        mocks.leaveStateGroup.mockRejectedValue(new Error('leave not mocked'));
        mocks.updateStateGroupMetadata.mockRejectedValue(
            new Error('metadata update not mocked')
        );
        mocks.webRtcConnectionService.peerIdsWithNoReconnectableLanes.mockReturnValue(
            []
        );
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue([]);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue([]);
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue([]);
        mocks.webRtcConnectionService.ensurePeerConnectionStarted.mockImplementation(
            (peerId) =>
                Either.ofLeft<WebRtcPeerConnectionLeft, QRtcPeerDto>({
                    kind: 'connect-failed',
                    peerId,
                    error: new Error('connect not mocked')
                })
        );
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
            async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => ({
                status: 'connect-failed',
                peerId,
                laneId,
                error: new Error('connect not mocked')
            })
        );
        mocks.webRtcConnectionService.onRtcPeerLifecycleDo.mockImplementation(
            () => mocks.ctx.middleware.webRtcConnectionService
        );
        mocks.webRtcConnectionService.readPeer.mockReturnValue(undefined);
        mocks.webRtcConnectionService.removeRtcPeerLifecycleById.mockReturnValue(
            true
        );
        mocks.rtcRxStreamer.enqueueOutboxIfAbsent.mockImplementation(
            async (message) => ({
                status: 'enqueued',
                message,
                entries: []
            })
        );
        mocks.rtcRxStreamer.onInboxMessageDo.mockReturnValue(
            mocks.ctx.middleware.rtcRxStreamer
        );
        mocks.rtcRxStreamer.removeInboxMessageCallback.mockReturnValue(true);
        mocks.webSocketQueueBox.enqueueOutboxIfAbsent.mockImplementation(
            async (message) => ({
                status: 'enqueued',
                message,
                entries: []
            })
        );
        mocks.webSocketQueueBox.onAnyInboxMessageDo.mockReturnValue(
            mocks.ctx.middleware.webSocketQueueBox
        );
        mocks.webSocketQueueBox.removeAnyInboxMessageCallback.mockReturnValue(true);
        mocks.webSocketQueueBox.readHealth.mockReturnValue({
            sessionId: mocks.ctx.session.sessionId,
            url: 'ws://localhost/ws',
            readyState: 'missing',
            isOpen: false,
            reconnecting: false,
            reconnectEnabled: false,
            reconnectAttempts: 0,
            maxReconnectAttempts: 12,
            reconnectExhausted: false
        });
        mocks.webSocketQueueBox.close.mockImplementation((code, reason) => {
            mocks.webSocket.close(code, reason);
        });
        mocks.webSocket.onWebsocketCallbacksDo.mockReturnValue(
            mocks.ctx.middleware.webSocketQueueBox.socket
        );
        mocks.webSocket.removeWebsocketCallbackById.mockReturnValue(true);
        mocks.registerWithApi.mockResolvedValue({
            clientId: 'client-new',
            username: 'new-user',
            displayName: null,
            registeredAtEpochMs: 1_000
        });
        mocks.listStateClientEvents.mockRejectedValue(
            new Error('client events not mocked')
        );
        mocks.listStateClientEventPage.mockRejectedValue(
            new Error('client event page not mocked')
        );
        mocks.listStateGroupEvents.mockRejectedValue(
            new Error('group events not mocked')
        );
        mocks.listStateGroupEventPage.mockRejectedValue(
            new Error('group event page not mocked')
        );
    });

    it('passes signal and timeout options into auth login', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const signal = new AbortController().signal;
        let loginRequest: Parameters<ContractModules.AuthApi['loginToApi']>[0] | undefined;
        let loginOptions: Parameters<ContractModules.AuthApi['loginToApi']>[1] | undefined;
        mocks.loginToApi.mockImplementationOnce(async (request, options) => {
            loginRequest = request;
            loginOptions = options;
            return mocks.ctx.session;
        });

        await createRallarFacade().auth.login(
            {
                username: 'principal-1',
                password: 'password-1'
            },
            {
                signal,
                timeoutMs: 123
            }
        );

        expect(loginRequest).toEqual({
            username: 'principal-1',
            password: 'password-1'
        });
        expect(loginOptions?.signal).toBeInstanceOf(AbortSignal);
    });

    it('reuses one request ID when login retries after a lost response', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const requestIds: Array<string | undefined> = [];
        mocks.loginToApi.mockImplementation(async (_request, options) => {
            requestIds.push(options?.requestId);
            if (requestIds.length === 1) {
                throw createAuthSessionApiHttpError(503, 'response lost');
            }
            return mocks.ctx.session;
        });

        await createRallarFacade().auth.login(
            { username: 'principal-1', password: 'password-1' },
            { maxAttempts: 2 }
        );

        expect(requestIds).toHaveLength(2);
        expect(requestIds[0]).toBeTruthy();
        expect(new Set(requestIds).size).toBe(1);
    });

    it('emits the current auth state to auth change subscribers', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const authStates: RallarAuthState[] = [];

        const unsubscribe = createRallarFacade().auth.onChange((authState) => {
            authStates.push(authState);
        });

        expect(authStates).toEqual([
            {
                authenticated: true,
                reason: 'current',
                session: mocks.ctx.session
            }
        ]);

        unsubscribe();
    });

    it('locally logs out and tears down active transports when the session expires', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const expiringSession = {
            ...mocks.ctx.session,
            expiresAtEpochMs: 1_500
        };
        mocks.initialiseMiddleware.mockResolvedValue(mocks.ctx.middleware);
        mocks.readSession.mockImplementation(() =>
            Date.now() >= expiringSession.expiresAtEpochMs
                ? undefined
                : expiringSession
        );
        const transportState = {
            heartbeatStopped: false,
            rtcHeartbeatsStopped: false,
            remoteLogoutRequested: false,
            sessionCleared: false
        };
        let webSocketClose: { readonly code: number; readonly reason: string; } | undefined;
        mocks.heartbeat.stop.mockImplementation(() => {
            transportState.heartbeatStopped = true;
        });
        mocks.rtcRxStreamer.stopAllHeartbeats.mockImplementation(() => {
            transportState.rtcHeartbeatsStopped = true;
        });
        mocks.logoutFromApi.mockImplementation(async () => {
            transportState.remoteLogoutRequested = true;
            return { loggedOut: true };
        });
        mocks.clearSession.mockImplementation(() => {
            transportState.sessionCleared = true;
        });
        mocks.webSocketQueueBox.close.mockImplementation((code, reason) => {
            if (code === undefined || reason === undefined) {
                throw new Error('Auth cleanup must close WebSocket with code and reason');
            }
            webSocketClose = { code, reason };
            mocks.webSocket.close(code, reason);
        });
        const facade = createRallarFacade();
        const authStates: RallarAuthState[] = [];
        facade.auth.onChange((authState) => {
            authStates.push(authState);
        }, { emitCurrent: false });

        await facade.connect();
        await vi.advanceTimersByTimeAsync(500);
        await Promise.resolve();
        await Promise.resolve();

        expect({ ...transportState, webSocketClose }).toEqual({
            heartbeatStopped: true,
            rtcHeartbeatsStopped: true,
            remoteLogoutRequested: false,
            sessionCleared: true,
            webSocketClose: { code: 1000, reason: 'rallar-disconnect' }
        });
        expect(authStates).toEqual([
            {
                authenticated: false,
                reason: 'expired',
                session: undefined
            }
        ]);
        expect(facade.isConnected()).toBe(false);
    });

    it('does not expire a replacement session when an old expiry timer fires', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const oldSession = {
            ...mocks.ctx.session,
            expiresAtEpochMs: 1_500
        };
        const nextSession = {
            ...mocks.ctx.session,
            sessionId: 'session-2',
            accessToken: 'token-2',
            expiresAtEpochMs: 10_000
        };
        let currentSession: typeof oldSession | undefined = oldSession;
        let transportClosed = false;
        mocks.initialiseMiddleware.mockResolvedValue(mocks.ctx.middleware);
        mocks.readSession.mockImplementation(() => currentSession);
        mocks.clearSession.mockImplementation(() => {
            currentSession = undefined;
        });
        mocks.webSocketQueueBox.close.mockImplementation(() => {
            transportClosed = true;
        });
        const facade = createRallarFacade();

        await facade.connect();
        currentSession = nextSession;
        await vi.advanceTimersByTimeAsync(500);

        expect(currentSession).toBe(nextSession);
        expect(transportClosed).toBe(false);
        expect(facade.isConnected()).toBe(true);
    });

    it('locally logs out on API 401 without calling the logout endpoint', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        let storedSession: typeof mocks.ctx.session | undefined = mocks.ctx.session;
        let remoteLogoutRequested = false;
        const authStates: RallarAuthState[] = [];
        mocks.readSession.mockImplementation(() => storedSession);
        mocks.clearSession.mockImplementation(() => {
            storedSession = undefined;
        });
        mocks.logoutFromApi.mockImplementation(async () => {
            remoteLogoutRequested = true;
            return { loggedOut: true };
        });
        facade.auth.onChange((authState) => {
            authStates.push(authState);
        }, { emitCurrent: false });
        await facade.connect();
        mocks.refreshStateSnapshots.mockRejectedValue(
            createAuthSessionApiHttpError(401, 'Unauthorized')
        );

        await expect(facade.rooms.refresh()).rejects.toThrow('Unauthorized');

        expect(mocks.webSocketQueueBox.close).toHaveBeenCalledWith(
            1000,
            'rallar-disconnect'
        );
        expect(remoteLogoutRequested).toBe(false);
        expect(storedSession).toBeUndefined();
        expect(authStates).toEqual([
            {
                authenticated: false,
                reason: 'unauthorized',
                session: undefined
            }
        ]);
    });

    it('emits unauthorized auth state once when nested room operations see the same 401', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        let storedSession: typeof mocks.ctx.session | undefined = mocks.ctx.session;
        const authStates: RallarAuthState[] = [];
        const oldRoom = createAuthSessionGroupSnapshot('old-room', ['session-1']);
        const newRoom = createAuthSessionGroupSnapshot('new-room', ['session-1']);
        mocks.readSession.mockImplementation(() => storedSession);
        mocks.clearSession.mockImplementation(() => {
            storedSession = undefined;
        });

        facade.setDefaults({
            applicationId: 'app-1',
            workspaceId: 'workspace-1'
        });
        mocks.joinStateGroup.mockResolvedValueOnce(oldRoom);
        await facade.rooms.join('old-room');
        installGroupSnapshotRepositoryMocks(mocks, [oldRoom]);

        facade.auth.onChange((authState) => {
            authStates.push(authState);
        }, { emitCurrent: false });
        mocks.joinStateGroup.mockResolvedValueOnce(newRoom);
        mocks.leaveStateGroup.mockRejectedValueOnce(
            createAuthSessionApiHttpError(401, 'Unauthorized')
        );

        await expect(facade.rooms.join('new-room')).rejects.toThrow('Unauthorized');

        expect(authStates).toEqual([
            {
                authenticated: false,
                reason: 'unauthorized',
                session: undefined
            }
        ]);
        expect(storedSession).toBeUndefined();
    });

    it('does not locally log out on API 403 authorization errors', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        let storedSession: typeof mocks.ctx.session | undefined = mocks.ctx.session;
        const authStates: RallarAuthState[] = [];
        mocks.readSession.mockImplementation(() => storedSession);
        mocks.clearSession.mockImplementation(() => {
            storedSession = undefined;
        });
        await facade.connect();
        facade.auth.onChange((authState) => {
            authStates.push(authState);
        });
        mocks.refreshStateSnapshots.mockRejectedValue(
            createAuthSessionApiHttpError(403, 'Forbidden')
        );

        await expect(facade.rooms.refresh()).rejects.toThrow('Forbidden');

        expect(storedSession).toBe(mocks.ctx.session);
        expect(authStates.at(-1)).toEqual({
            authenticated: true,
            reason: 'current',
            session: mocks.ctx.session
        });
        expect(facade.isConnected()).toBe(true);
    });

    it('passes an explicit admin session into auth registration', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const signal = new AbortController().signal;
        const adminSession = {
            ...mocks.ctx.session,
            clientId: 'admin',
            accessToken: 'admin-token',
            username: 'admin'
        };
        let registerRequest: Parameters<ContractModules.AuthApi['registerWithApi']>[0] | undefined;
        let registerOptions: Parameters<ContractModules.AuthApi['registerWithApi']>[1] | undefined;
        mocks.registerWithApi.mockImplementationOnce(async (request, options) => {
            registerRequest = request;
            registerOptions = options;
            return {
                clientId: 'client-new',
                username: 'new-user',
                displayName: null,
                registeredAtEpochMs: 1_000
            };
        });

        await createRallarFacade().auth.register(
            {
                username: 'new-user',
                password: 'password-1',
                displayName: 'New User'
            },
            {
                adminSession,
                signal,
                timeoutMs: 123
            }
        );

        expect(registerRequest).toEqual({
            username: 'new-user',
            password: 'password-1',
            displayName: 'New User'
        });
        expect(registerOptions?.signal).toBeInstanceOf(AbortSignal);
        expect(registerOptions?.authSession).toBe(adminSession);
    });

    it('reuses one request ID when registration retries after a lost response', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const requestIds: Array<string | undefined> = [];
        mocks.registerWithApi.mockImplementation(async (_request, options) => {
            requestIds.push(options?.requestId);
            if (requestIds.length === 1) {
                throw createAuthSessionApiHttpError(503, 'response lost');
            }
            return {
                clientId: 'client-new',
                username: 'new-user',
                displayName: null,
                registeredAtEpochMs: 1_000
            };
        });

        await createRallarFacade().auth.register(
            { username: 'new-user', password: 'password-1' },
            { maxAttempts: 2 }
        );

        expect(requestIds).toHaveLength(2);
        expect(requestIds[0]).toBeTruthy();
        expect(new Set(requestIds).size).toBe(1);
    });

    it('can register and then log in with the new user', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const registrationRequests: Array<Parameters<ContractModules.AuthApi['registerWithApi']>[0]> = [];
        const loginRequests: Array<Parameters<ContractModules.AuthApi['loginToApi']>[0]> = [];
        const writtenSessions: Array<Parameters<ContractModules.Auth['writeSession']>[0]> = [];
        mocks.registerWithApi.mockImplementation(async (request) => {
            registrationRequests.push(request);
            return {
                clientId: 'client-new',
                username: 'new-user',
                displayName: null,
                registeredAtEpochMs: 1_000
            };
        });
        mocks.loginToApi.mockImplementation(async (request) => {
            loginRequests.push(request);
            return mocks.ctx.session;
        });
        mocks.writeSession.mockImplementation((session) => {
            writtenSessions.push(session);
        });

        await createRallarFacade().auth.registerAndLogin({
            username: 'new-user',
            password: 'password-1'
        });

        expect(registrationRequests).toEqual([
            { username: 'new-user', password: 'password-1' }
        ]);
        expect(loginRequests).toEqual([
            {
                username: 'new-user',
                password: 'password-1'
            }
        ]);
        expect(writtenSessions).toEqual([mocks.ctx.session]);
    });

    it('revokes the backend session when logging out', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const signal = new AbortController().signal;
        let storedSession: typeof mocks.ctx.session | undefined = mocks.ctx.session;
        let logoutOptions: Parameters<ContractModules.AuthApi['logoutFromApi']>[0] | undefined;
        mocks.readSession.mockImplementation(() => storedSession);
        mocks.clearSession.mockImplementation(() => {
            storedSession = undefined;
        });
        mocks.logoutFromApi.mockImplementationOnce(async (options) => {
            logoutOptions = options;
            return { loggedOut: true };
        });

        await createRallarFacade().auth.logout({ signal, timeoutMs: 123 });

        expect(logoutOptions?.signal).toBeInstanceOf(AbortSignal);
        expect(storedSession).toBeUndefined();
    });

    it('reuses one request ID when logout retries after a lost response', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const requestIds: Array<string | undefined> = [];
        mocks.logoutFromApi.mockImplementation(async (options) => {
            requestIds.push(options?.requestId);
            if (requestIds.length === 1) {
                throw createAuthSessionApiHttpError(503, 'response lost');
            }
            return { loggedOut: true };
        });

        await createRallarFacade().auth.logout({ maxAttempts: 2 });

        expect(requestIds).toHaveLength(2);
        expect(requestIds[0]).toBeTruthy();
        expect(new Set(requestIds).size).toBe(1);
    });

    it('clears local auth before revoking manual logout and uses the captured session', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        let storedSession: typeof mocks.ctx.session | undefined = mocks.ctx.session;
        let sessionWasClearedBeforeRevoke = false;
        let logoutOptions: Parameters<ContractModules.AuthApi['logoutFromApi']>[0] | undefined;
        mocks.readSession.mockImplementation(() => storedSession);
        mocks.clearSession.mockImplementation(() => {
            storedSession = undefined;
        });
        mocks.logoutFromApi.mockImplementationOnce(async (options) => {
            sessionWasClearedBeforeRevoke = storedSession === undefined;
            logoutOptions = options;
            return { loggedOut: true };
        });

        await createRallarFacade().auth.logout();

        expect(sessionWasClearedBeforeRevoke).toBe(true);
        expect(logoutOptions).toMatchObject({
            authSession: mocks.ctx.session
        });
    });

    it('deletes captured session browser AL runtime rows even when revoke fails', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const deletedSessionIds: string[] = [];
        mocks.logoutFromApi.mockRejectedValueOnce(new Error('revoke failed'));
        mocks.deleteBrowserALRuntimeEntriesForSession.mockImplementation(
            async (sessionId) => {
                deletedSessionIds.push(sessionId);
                return {
                    dbName: 'rallar-browser-al-runtime',
                    storeName: 'entries',
                    keyPrefixes: [],
                    scanned: 0,
                    deleted: 0
                };
            }
        );

        await expect(createRallarFacade().auth.logout()).rejects.toThrow(
            'revoke failed'
        );

        expect(deletedSessionIds).toEqual(['session-1']);
    });

    it('does not reconnect with a stale session while manual logout is in progress', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        let storedSession: typeof mocks.ctx.session | undefined = mocks.ctx.session;
        const logoutStarted = createDeferred<void>();
        const logoutResult = createDeferred<{ loggedOut: boolean; }>();
        const initializedSessionIds: string[] = [];
        mocks.readSession.mockImplementation(() => storedSession);
        mocks.clearSession.mockImplementation(() => {
            storedSession = undefined;
        });
        mocks.logoutFromApi.mockImplementation(() => {
            logoutStarted.resolve();
            return logoutResult.promise;
        });
        mocks.initialiseMiddleware.mockImplementation(async (session) => {
            initializedSessionIds.push(session.sessionId);
            return mocks.ctx.middleware;
        });
        const facade = createRallarFacade();

        await facade.connect();
        const logoutPromise = facade.auth.logout();
        await logoutStarted.promise;

        const startPromise = facade.start();
        await Promise.resolve();
        logoutResult.resolve({ loggedOut: true });
        const startResult = await startPromise;
        await logoutPromise;

        expect(initializedSessionIds).toEqual(['session-1']);
        expect(startResult).toEqual({
            session: undefined,
            connected: false
        });
    });

    it('shuts down middleware that resolves after logout during connect', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const deferred = createDeferred<Middleware>();
        const cleanupState = {
            heartbeatStopped: false,
            rtcHeartbeatsStopped: false,
            knownPeersRead: false,
            queueStopped: false
        };
        let webSocketClose: { readonly code: number; readonly reason: string; } | undefined;
        mocks.heartbeat.stop.mockImplementation(() => {
            cleanupState.heartbeatStopped = true;
        });
        mocks.rtcRxStreamer.stopAllHeartbeats.mockImplementation(() => {
            cleanupState.rtcHeartbeatsStopped = true;
        });
        mocks.webRtcConnectionService.knownPeerIds.mockImplementation(() => {
            cleanupState.knownPeersRead = true;
            return [];
        });
        mocks.qboxEngine.stop.mockImplementation(() => {
            cleanupState.queueStopped = true;
        });
        mocks.webSocketQueueBox.close.mockImplementation((code, reason) => {
            if (code === undefined || reason === undefined) {
                throw new Error('Auth cleanup must close WebSocket with code and reason');
            }
            webSocketClose = { code, reason };
            mocks.webSocket.close(code, reason);
        });
        mocks.initialiseMiddleware.mockReturnValueOnce(deferred.promise);
        const facade = createRallarFacade();

        const connectPromise = facade.connect();
        await Promise.resolve();

        await facade.auth.logout();
        const expectation = expect(connectPromise).rejects.toThrow(
            'Rallar connection was cancelled because auth ended.'
        );

        deferred.resolve(mocks.ctx.middleware);
        await expectation;

        expect(facade.status()).toBe('idle');
        expect(facade.isConnected()).toBe(false);
        expect({ ...cleanupState, webSocketClose }).toEqual({
            heartbeatStopped: true,
            rtcHeartbeatsStopped: true,
            knownPeersRead: true,
            queueStopped: true,
            webSocketClose: { code: 1000, reason: 'rallar-disconnect' }
        });
    });

    it('cancels a pending connection before replacing credentials and reconnects with the replacement', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const pendingMiddleware = createDeferred<Middleware>();
        const replacementSession = {
            ...mocks.ctx.session,
            sessionId: 'session-2',
            accessToken: 'token-2'
        };
        const firstInitializationStarted = createDeferred<void>();
        const initializedSessionIds: string[] = [];
        let currentSession = mocks.ctx.session;
        mocks.readSession.mockImplementation(() => currentSession);
        mocks.writeSession.mockImplementation((session) => {
            currentSession = session;
        });
        mocks.initialiseMiddleware
            .mockImplementationOnce((session) => {
                initializedSessionIds.push(session.sessionId);
                firstInitializationStarted.resolve();
                return pendingMiddleware.promise;
            })
            .mockImplementationOnce(async (session) => {
                initializedSessionIds.push(session.sessionId);
                return mocks.ctx.middleware;
            });
        mocks.loginToApi.mockResolvedValue(replacementSession);
        const facade = createRallarFacade();

        const pendingConnect = facade.connect();
        await firstInitializationStarted.promise;

        await expect(
            facade.auth.login({
                username: 'principal-2',
                password: 'password-2'
            })
        ).resolves.toBe(replacementSession);

        expect(facade.status()).toBe('idle');
        expect(facade.isConnected()).toBe(false);

        pendingMiddleware.resolve(mocks.ctx.middleware);
        await expect(pendingConnect).rejects.toThrow(
            'Rallar connection was cancelled because auth ended.'
        );

        await expect(facade.connect()).resolves.toMatchObject({
            session: replacementSession
        });
        expect(initializedSessionIds).toEqual(['session-1', 'session-2']);
    });

    it('closes WS through the queue-box service when logging out after connect', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        let storedSession: typeof mocks.ctx.session | undefined = mocks.ctx.session;
        const logoutState = {
            heartbeatStopped: false,
            rtcHeartbeatsStopped: false,
            backendRevoked: false
        };
        let webSocketClose: { readonly code: number; readonly reason: string; } | undefined;
        mocks.readSession.mockImplementation(() => storedSession);
        mocks.clearSession.mockImplementation(() => {
            storedSession = undefined;
        });
        mocks.heartbeat.stop.mockImplementation(() => {
            logoutState.heartbeatStopped = true;
        });
        mocks.rtcRxStreamer.stopAllHeartbeats.mockImplementation(() => {
            logoutState.rtcHeartbeatsStopped = true;
        });
        mocks.logoutFromApi.mockImplementation(async () => {
            logoutState.backendRevoked = true;
            return { loggedOut: true };
        });
        mocks.webSocketQueueBox.close.mockImplementation((code, reason) => {
            if (code === undefined || reason === undefined) {
                throw new Error('Auth cleanup must close WebSocket with code and reason');
            }
            webSocketClose = { code, reason };
            mocks.webSocket.close(code, reason);
        });
        const facade = createRallarFacade();

        await facade.connect();
        await facade.auth.logout();

        expect({ ...logoutState, webSocketClose }).toEqual({
            heartbeatStopped: true,
            rtcHeartbeatsStopped: true,
            backendRevoked: true,
            webSocketClose: { code: 1000, reason: 'rallar-disconnect' }
        });
        expect(storedSession).toBeUndefined();
        expect(facade.isConnected()).toBe(false);
    });

    it('disconnects every known RTC peer, including stale lane peers', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue([
            'peer-ready',
            'peer-stale'
        ]);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue([
            'peer-ready',
            'peer-stale'
        ]);
        mocks.webRtcConnectionService.peerIdsWithNoReconnectableLanes.mockReturnValue(
            ['peer-ready']
        );
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue([
            'peer-ready'
        ]);
        const disconnectedPeerIds: string[] = [];
        mocks.webRtcConnectionService.disconnectPeer.mockImplementation((peerId) => {
            disconnectedPeerIds.push(peerId);
            return true;
        });
        const facade = createRallarFacade();
        const wsLifecycle: RallarWsLifecycleEvent[] = [];
        facade.ws.onLifecycle(
            (event) => {
                wsLifecycle.push(event);
            },
            {
                emitCurrent: false
            }
        );

        await facade.connect();
        await facade.disconnect();

        expect(disconnectedPeerIds).toEqual(['peer-ready', 'peer-stale']);
        expect(mocks.webSocketQueueBox.close).toHaveBeenCalledWith(
            1000,
            'rallar-disconnect'
        );
        expect(mocks.webSocket.close).toHaveBeenCalledWith(
            1000,
            'rallar-disconnect'
        );
        expect(wsLifecycle.at(-1)).toMatchObject({
            kind: 'disconnected',
            code: 1000,
            reason: 'rallar-disconnect',
            intentional: true,
            status: {
                connectState: 'idle',
                readyState: 'missing',
                reconnectEnabled: false
            }
        });
    });
});
