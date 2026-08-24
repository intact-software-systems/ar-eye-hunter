import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import type { ApiMiddleware } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type { Middleware } from '@shared-web/browser/middleware.ts';
import { newALRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { OnMessageCallback } from '@shared/services/InboxOutboxContracts.ts';
import { DEFAULT_RTC_DATA_CHANNEL_LANE_ID, type QRtcPeerDto, type WebRtcPeerConnectionLeft } from '@shared/services/WebRtcConnectionService.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createActiveGroupMemberFixture, createActiveGroupPresenceSessionFixture, createGroupSnapshotFixture } from './authoritative-group-fixtures.ts';

type ApiIntegrationModule = typeof import('@shared-web/browser/api-integration.ts');
type AuthApiModule = typeof import('@shared-web/browser/auth/session-http-api.ts');
type ApiWorkflowsModule = typeof import('@shared-web/browser/api-workflows.ts');
type MiddlewareModule = typeof import('@shared-web/browser/middleware.ts');
type AuthModule = typeof import('@shared/api/auth.ts');
type BrowserALRuntimeStoresModule = typeof import('@shared-web/browser/browser-al-runtime-stores.ts');
type ClientStateSnapshotsRepositoryModule = typeof import('@shared/repository/client-state-snapshots-repository.ts');
type DataCachesModule = typeof import('@shared-web/browser/data-caches.ts');
type GroupStateSnapshotsRepositoryModule = typeof import('@shared/repository/group-state-snapshots-repository.ts');
type RoomGroupStateWorkflowsModule = typeof import('@shared-web/browser/rooms/room-group-state-workflows.ts');

const mocks = await vi.hoisted(async () => {
    const { createApiMiddlewareTestDouble } = await import(
        './api-middleware-test-double.ts'
    );
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
        initialiseMiddleware: vi.fn<MiddlewareModule['initialiseMiddleware']>(
            () => Promise.resolve(ctx.middleware)
        ),
        clearSession: vi.fn<AuthModule['clearSession']>(),
        readSession: vi.fn<AuthModule['readSession']>(() => session),
        writeSession: vi.fn<AuthModule['writeSession']>(),
        hydrateStateCaches: vi.fn<DataCachesModule['hydrateStateCaches']>(() => Promise.resolve()),
        onStateCacheChange: vi.fn<DataCachesModule['onStateCacheChange']>(() => vi.fn()),
        deleteBrowserALRuntimeEntriesForSession: vi.fn<BrowserALRuntimeStoresModule['deleteBrowserALRuntimeEntriesForSession']>(() =>
            Promise.resolve({
                dbName: '',
                storeName: '',
                keyPrefixes: [],
                scanned: 0,
                deleted: 0
            })
        ),
        createAndJoinStateGroup: vi.fn<ApiWorkflowsModule['createAndJoinStateGroup']>(
            () => Promise.reject(new Error('create not mocked'))
        ),
        joinStateGroup: vi.fn<ApiWorkflowsModule['joinStateGroup']>(() => Promise.reject(new Error('join not mocked'))),
        leaveStateGroup: vi.fn<ApiWorkflowsModule['leaveStateGroup']>(() => Promise.reject(new Error('leave not mocked'))),
        updateStateGroupMetadata: vi.fn<ApiWorkflowsModule['updateStateGroupMetadata']>(
            () => Promise.reject(new Error('metadata update not mocked'))
        ),
        refreshStateSnapshots: vi.fn<ApiWorkflowsModule['refreshStateSnapshots']>(() => Promise.resolve({ clients: [], groups: [] })),
        loginToApi: vi.fn<AuthApiModule['loginToApi']>(() => Promise.resolve(session)),
        logoutFromApi: vi.fn<AuthApiModule['logoutFromApi']>(() => Promise.resolve({ loggedOut: true })),
        registerWithApi: vi.fn<AuthApiModule['registerWithApi']>(() =>
            Promise.resolve({
                clientId: 'client-new',
                username: 'new-user',
                displayName: null,
                registeredAtEpochMs: 1_000
            })
        ),
        listStateClientEvents: vi.fn<ApiIntegrationModule['listStateClientEvents']>(() => Promise.reject(new Error('client events not mocked'))),
        listStateClientEventPage: vi.fn<ApiIntegrationModule['listStateClientEventPage']>(() => Promise.reject(new Error('client event page not mocked'))),
        listStateGroupEvents: vi.fn<ApiIntegrationModule['listStateGroupEvents']>(() => Promise.reject(new Error('group events not mocked'))),
        listStateGroupEventPage: vi.fn<ApiIntegrationModule['listStateGroupEventPage']>(
            () => Promise.reject(new Error('group event page not mocked'))
        ),
        clientRepositoryMissing: vi.fn(() => undefined),
        getAllClientStateSnapshots: vi.fn<ClientStateSnapshotsRepositoryModule['getAllClientStateSnapshots']>(() => []),
        findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn<
            GroupStateSnapshotsRepositoryModule[
                'findFirstGroupStateSnapshotRefSessionIdIsIn'
            ]
        >(),
        findGroupStateSnapshotByRef: vi.fn<GroupStateSnapshotsRepositoryModule['findGroupStateSnapshotByRef']>(),
        getAllGroupStateSnapshots: vi.fn<GroupStateSnapshotsRepositoryModule['getAllGroupStateSnapshots']>()
    };
});

vi.mock(
    import('@shared-web/browser/middleware.ts'),
    (): Partial<MiddlewareModule> => ({
        initialiseMiddleware: mocks.initialiseMiddleware
    })
);

vi.mock(
    import('@shared-web/browser/api-integration.ts'),
    (): Partial<ApiIntegrationModule> => ({
        listStateClientEventPage: mocks.listStateClientEventPage,
        listStateClientEvents: mocks.listStateClientEvents,
        listStateGroupEventPage: mocks.listStateGroupEventPage,
        listStateGroupEvents: mocks.listStateGroupEvents
    })
);

vi.mock(import('@shared-web/browser/auth/session-http-api.ts'), (): Partial<AuthApiModule> => ({
    loginToApi: mocks.loginToApi,
    logoutFromApi: mocks.logoutFromApi,
    registerWithApi: mocks.registerWithApi
}));

vi.mock(
    import('@shared-web/browser/api-workflows.ts'),
    (): Partial<ApiWorkflowsModule> => ({
        createAndJoinStateGroup: mocks.createAndJoinStateGroup,
        joinStateGroup: mocks.joinStateGroup,
        leaveStateGroup: mocks.leaveStateGroup,
        refreshStateSnapshots: mocks.refreshStateSnapshots,
        updateStateGroupMetadata: mocks.updateStateGroupMetadata
    })
);

vi.mock(
    import('@shared-web/browser/rooms/room-group-state-workflows.ts'),
    (): Partial<RoomGroupStateWorkflowsModule> => ({
        joinStateGroup: mocks.joinStateGroup,
        leaveStateGroup: mocks.leaveStateGroup
    })
);

vi.mock(
    import('@shared-web/browser/browser-al-runtime-stores.ts'),
    (): Partial<BrowserALRuntimeStoresModule> => ({
        deleteBrowserALRuntimeEntriesForSession: mocks.deleteBrowserALRuntimeEntriesForSession
    })
);

vi.mock(
    import('@shared-web/browser/data-caches.ts'),
    (): Partial<DataCachesModule> => ({
        hydrateStateCaches: mocks.hydrateStateCaches,
        onStateCacheChange: mocks.onStateCacheChange
    })
);

vi.mock(
    import('@shared/api/auth.ts'),
    (): Partial<AuthModule> => ({
        clearSession: mocks.clearSession,
        isLoggedIn: vi.fn(() => true),
        readSession: mocks.readSession,
        writeSession: mocks.writeSession
    })
);

vi.mock(
    import('@shared/repository/client-state-snapshots-repository.ts'),
    (): Partial<ClientStateSnapshotsRepositoryModule> => ({
        findClientStateSnapshotByPrincipalId: mocks.clientRepositoryMissing,
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

describe('Rallar auth session contract', () => {
    beforeEach(async () => {
        (await import('@shared-web/browser/connection/browser-transport-runtime.ts'))
            .browserTransportRuntime.shutdown('test-reset');
        vi.clearAllMocks();
        vi.useRealTimers();
        mocks.clientRepositoryMissing.mockReturnValue(undefined);
        mocks.getAllClientStateSnapshots.mockReturnValue([]);
        mockGroupRepositoryMissing();
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
        mocks.createAndJoinStateGroup.mockRejectedValue(new Error('create not mocked'));
        mocks.joinStateGroup.mockRejectedValue(new Error('join not mocked'));
        mocks.leaveStateGroup.mockRejectedValue(new Error('leave not mocked'));
        mocks.updateStateGroupMetadata.mockRejectedValue(
            new Error('metadata update not mocked')
        );
        mocks.webRtcConnectionService.peerIdsWithNoReconnectableLanes
            .mockReturnValue([]);
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
        mocks.webRtcConnectionService.onRtcPeerLifecycleDo.mockImplementation(() => mocks.ctx.middleware.webRtcConnectionService);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(undefined);
        mocks.webRtcConnectionService.removeRtcPeerLifecycleById.mockReturnValue(true);
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
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const signal = new AbortController().signal;

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

        expect(mocks.loginToApi.mock.calls[0]?.[0]).toEqual({
            username: 'principal-1',
            password: 'password-1'
        });
        const loginOptions = mocks.loginToApi.mock.calls[0]?.[1] as
            | { signal?: AbortSignal; }
            | undefined;
        expect(loginOptions?.signal).toBeInstanceOf(AbortSignal);
    });

    it('reuses one request ID when login retries after a lost response', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mocks.loginToApi
            .mockRejectedValueOnce(apiHttpError(503, 'response lost'))
            .mockResolvedValueOnce(mocks.ctx.session);

        await createRallarFacade().auth.login(
            { username: 'principal-1', password: 'password-1' },
            { maxAttempts: 2 }
        );

        const requestIds = mocks.loginToApi.mock.calls.map((call) => (call[1] as { requestId?: string; } | undefined)?.requestId);
        expect(requestIds).toHaveLength(2);
        expect(requestIds[0]).toBeTruthy();
        expect(new Set(requestIds).size).toBe(1);
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
            session: mocks.ctx.session
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
            expiresAtEpochMs: 1_500
        };
        mocks.initialiseMiddleware.mockResolvedValue(mocks.ctx.middleware);
        mocks.readSession.mockImplementation(() => Date.now() >= expiringSession.expiresAtEpochMs ? undefined : expiringSession);
        const facade = createRallarFacade();
        const authListener = vi.fn();
        facade.auth.onChange(authListener, { emitCurrent: false });

        await facade.connect();
        await vi.advanceTimersByTimeAsync(500);
        await Promise.resolve();
        await Promise.resolve();

        expect(mocks.webSocketQueueBox.close)
            .toHaveBeenCalledWith(1000, 'rallar-disconnect');
        expect(mocks.heartbeat.stop).toHaveBeenCalledOnce();
        expect(mocks.rtcRxStreamer.stopAllHeartbeats)
            .toHaveBeenCalledOnce();
        expect(mocks.logoutFromApi).not.toHaveBeenCalled();
        expect(mocks.clearSession).toHaveBeenCalledOnce();
        expect(authListener).toHaveBeenCalledWith({
            authenticated: false,
            reason: 'expired',
            session: undefined
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
            expiresAtEpochMs: 1_500
        };
        const nextSession = {
            ...mocks.ctx.session,
            sessionId: 'session-2',
            accessToken: 'token-2',
            expiresAtEpochMs: 10_000
        };
        let currentSession = oldSession;
        mocks.initialiseMiddleware.mockResolvedValue(mocks.ctx.middleware);
        mocks.readSession.mockImplementation(() => currentSession);
        const facade = createRallarFacade();

        await facade.connect();
        currentSession = nextSession;
        mocks.clearSession.mockClear();
        mocks.webSocketQueueBox.close.mockClear();
        await vi.advanceTimersByTimeAsync(500);

        expect(mocks.clearSession).not.toHaveBeenCalled();
        expect(mocks.webSocketQueueBox.close).not.toHaveBeenCalled();
    });

    it('locally logs out on API 401 without calling the logout endpoint', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();
        const authListener = vi.fn();
        facade.auth.onChange(authListener, { emitCurrent: false });
        await facade.connect();
        mocks.refreshStateSnapshots.mockRejectedValue(apiHttpError(401, 'Unauthorized'));

        await expect(facade.rooms.refresh()).rejects.toThrow('Unauthorized');

        expect(mocks.webSocketQueueBox.close)
            .toHaveBeenCalledWith(1000, 'rallar-disconnect');
        expect(mocks.logoutFromApi).not.toHaveBeenCalled();
        expect(mocks.clearSession).toHaveBeenCalledOnce();
        expect(authListener).toHaveBeenCalledWith({
            authenticated: false,
            reason: 'unauthorized',
            session: undefined
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
            workspaceId: 'workspace-1'
        });
        mocks.joinStateGroup.mockResolvedValueOnce(oldRoom);
        await facade.rooms.join('old-room');
        mockGroupSnapshot(oldRoom);

        facade.auth.onChange(authListener, { emitCurrent: false });
        mocks.joinStateGroup.mockResolvedValueOnce(newRoom);
        mocks.leaveStateGroup.mockRejectedValueOnce(apiHttpError(401, 'Unauthorized'));

        await expect(facade.rooms.join('new-room')).rejects.toThrow('Unauthorized');

        expect(authListener).toHaveBeenCalledTimes(1);
        expect(authListener).toHaveBeenCalledWith({
            authenticated: false,
            reason: 'unauthorized',
            session: undefined
        });
        expect(mocks.clearSession).toHaveBeenCalledOnce();
    });

    it('does not locally log out on API 403 authorization errors', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();
        await facade.connect();
        mocks.webSocketQueueBox.close.mockClear();
        mocks.refreshStateSnapshots.mockRejectedValue(apiHttpError(403, 'Forbidden'));

        await expect(facade.rooms.refresh()).rejects.toThrow('Forbidden');

        expect(mocks.webSocketQueueBox.close).not.toHaveBeenCalled();
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
            username: 'admin'
        };

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

        expect(mocks.registerWithApi.mock.calls[0]?.[0]).toEqual({
            username: 'new-user',
            password: 'password-1',
            displayName: 'New User'
        });
        const registerOptions = mocks.registerWithApi.mock.calls[0]?.[1] as
            | { signal?: AbortSignal; authSession?: unknown; }
            | undefined;
        expect(registerOptions?.signal).toBeInstanceOf(AbortSignal);
        expect(registerOptions?.authSession).toBe(adminSession);
    });

    it('reuses one request ID when registration retries after a lost response', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mocks.registerWithApi
            .mockRejectedValueOnce(apiHttpError(503, 'response lost'))
            .mockResolvedValueOnce({
                clientId: 'client-new',
                username: 'new-user',
                displayName: null,
                registeredAtEpochMs: 1_000
            });

        await createRallarFacade().auth.register(
            { username: 'new-user', password: 'password-1' },
            { maxAttempts: 2 }
        );

        const requestIds = mocks.registerWithApi.mock.calls.map((call) => (call[1] as { requestId?: string; } | undefined)?.requestId);
        expect(requestIds).toHaveLength(2);
        expect(requestIds[0]).toBeTruthy();
        expect(new Set(requestIds).size).toBe(1);
    });

    it('can register and then log in with the new user', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );

        await createRallarFacade().auth.registerAndLogin({
            username: 'new-user',
            password: 'password-1'
        });

        expect(mocks.registerWithApi).toHaveBeenCalledOnce();
        expect(mocks.loginToApi).toHaveBeenCalledWith(
            {
                username: 'new-user',
                password: 'password-1'
            },
            expect.any(Object)
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
            | { signal?: AbortSignal; }
            | undefined;
        expect(logoutOptions?.signal).toBeInstanceOf(AbortSignal);
        expect(mocks.clearSession).toHaveBeenCalledOnce();
    });

    it('reuses one request ID when logout retries after a lost response', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mocks.logoutFromApi
            .mockRejectedValueOnce(apiHttpError(503, 'response lost'))
            .mockResolvedValueOnce({ loggedOut: true });

        await createRallarFacade().auth.logout({ maxAttempts: 2 });

        const requestIds = mocks.logoutFromApi.mock.calls.map((call) => (call[0] as { requestId?: string; } | undefined)?.requestId);
        expect(requestIds).toHaveLength(2);
        expect(requestIds[0]).toBeTruthy();
        expect(new Set(requestIds).size).toBe(1);
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
            authSession: mocks.ctx.session
        });
    });

    it('deletes captured session browser AL runtime rows even when revoke fails', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mocks.logoutFromApi.mockRejectedValueOnce(new Error('revoke failed'));

        await expect(createRallarFacade().auth.logout()).rejects.toThrow(
            'revoke failed'
        );

        expect(mocks.deleteBrowserALRuntimeEntriesForSession)
            .toHaveBeenCalledWith('session-1');
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
                })
        );
        const facade = createRallarFacade();

        await facade.connect();
        const logoutPromise = facade.auth.logout();
        await vi.waitFor(() => {
            expect(mocks.logoutFromApi).toHaveBeenCalledOnce();
        });

        const startPromise = facade.start();
        await Promise.resolve();
        expect(mocks.initialiseMiddleware).toHaveBeenCalledTimes(1);
        releaseLogout?.();
        const startResult = await startPromise;
        await logoutPromise;

        expect(startResult).toEqual({
            session: undefined,
            connected: false
        });
    });

    it('shuts down middleware that resolves after logout during connect', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const deferred = createDeferred<Middleware>();
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
        expect(mocks.heartbeat.stop).toHaveBeenCalled();
        expect(mocks.rtcRxStreamer.stopAllHeartbeats)
            .toHaveBeenCalled();
        expect(mocks.webRtcConnectionService.knownPeerIds)
            .toHaveBeenCalled();
        expect(mocks.qboxEngine.stop).toHaveBeenCalled();
        expect(mocks.webSocketQueueBox.close)
            .toHaveBeenCalledWith(1000, 'rallar-disconnect');
    });

    it('closes WS through the queue-box service when logging out after connect', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();

        await facade.connect();
        await facade.auth.logout();

        expect(mocks.webSocketQueueBox.close)
            .toHaveBeenCalledWith(1000, 'rallar-disconnect');
        expect(mocks.heartbeat.stop).toHaveBeenCalledOnce();
        expect(mocks.rtcRxStreamer.stopAllHeartbeats)
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
            'peer-stale'
        ]);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue([
            'peer-ready',
            'peer-stale'
        ]);
        mocks.webRtcConnectionService.peerIdsWithNoReconnectableLanes
            .mockReturnValue(['peer-ready']);
        mocks.webRtcConnectionService.readyPeerIdsForLane
            .mockReturnValue(['peer-ready']);
        const facade = createRallarFacade();
        const wsLifecycle: unknown[] = [];
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

        expect(mocks.webRtcConnectionService.disconnectPeer)
            .toHaveBeenCalledWith('peer-ready');
        expect(mocks.webRtcConnectionService.disconnectPeer)
            .toHaveBeenCalledWith('peer-stale');
        expect(mocks.webRtcConnectionService.disconnectPeer)
            .toHaveBeenCalledTimes(2);
        expect(mocks.webSocketQueueBox.close)
            .toHaveBeenCalledWith(1000, 'rallar-disconnect');
        expect(mocks.webSocket.close)
            .toHaveBeenCalledWith(1000, 'rallar-disconnect');
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

function findLatestWsAnyMessageCallback(): OnMessageCallback | undefined {
    return mocks.webSocketQueueBox
        .onAnyInboxMessageDo.mock.calls
        .filter(([callbackId]) => callbackId === 'rallar:ws:any-message')
        .at(-1)?.[1];
}
function createChannelHealth(
    input: Readonly<{
        peerId: string;
        label: string;
        state: string;
        readyState: RTCDataChannelState;
    }>
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
            maxQueueItems: 32
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
            receivedBinary: 0
        }
    };
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
            (snapshot.group.workspaceId ?? '') === (ref.workspaceId ?? '')
        )
    );
    mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockImplementation((sessionId) =>
        snapshots.find((snapshot) => snapshot.group.groupId === sessionId)?.group
    );
}

function mockGroupRepositoryMissing(): void {
    mocks.getAllGroupStateSnapshots.mockReturnValue([]);
    mocks.findGroupStateSnapshotByRef.mockReturnValue(undefined);
    mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockReturnValue(undefined);
}

function withSnapshotVersion(
    snapshot: GroupSnapshot,
    snapshotVersion: number
): GroupSnapshot {
    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            snapshotVersion
        }
    };
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

function createDirectorGroupSnapshot(
    appointment?: Readonly<{
        sessionId: string;
        principalId: string;
        epoch: number;
        appointedAtEpochMs: number;
        heartbeatTtlMs: number;
    }>
): GroupSnapshot {
    const snapshot = createGroupSnapshot('room-1', ['session-1']);
    const activeSessions: GroupSnapshot['activeSessions'][number][] = [{
        ...snapshot.activeSessions[0],
        principalId: 'principal-1',
        sessionId: 'session-1'
    }];
    const members: GroupSnapshot['members'][number][] = [{
        ...snapshot.members[0],
        principalId: 'principal-1',
        role: 'owner'
    }];

    if (appointment) {
        activeSessions.push(createActiveGroupPresenceSessionFixture({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            principalId: appointment.principalId,
            sessionId: appointment.sessionId
        }));
        members.push(createActiveGroupMemberFixture({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            principalId: appointment.principalId,
            role: 'member',
            actorPrincipalId: 'principal-1'
        }));
    }

    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            created: {
                ...snapshot.group.created,
                actor: { kind: 'principal', principalId: 'principal-1' }
            },
            metadata: appointment
                ? {
                    rallarDirector: {
                        version: 1,
                        mode: 'appointed-spa',
                        ...appointment
                    }
                }
                : {}
        },
        members,
        activeSessions,
        memberCount: members.length,
        onlineMemberCount: activeSessions.length
    };
}

function apiHttpError(status: number, message: string): ApiHttpError {
    return new ApiHttpError(
        'POST',
        '/api/auth/test/requests/test-request-id',
        status,
        JSON.stringify({
            type: 'api-mutation-failure',
            version: 'canonical.v2',
            code: `test-${status}`,
            status,
            message,
            issues: null,
            denial: null,
            retry: status === 503
                ? {
                    retryable: true,
                    retryAfterMs: null,
                    reason: 'test-retry'
                }
                : null
        })
    );
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
    kind: 'audio' | 'video'
): MediaStreamTrack {
    const listeners = new Set<EventListenerOrEventListenerObject>();
    const track = {
        id,
        kind,
        enabled: true,
        readyState: 'live',
        addEventListener: vi.fn((
            type: string,
            listener: EventListenerOrEventListenerObject
        ) => {
            if (type === 'ended') {
                listeners.add(listener);
            }
        }),
        removeEventListener: vi.fn((
            type: string,
            listener: EventListenerOrEventListenerObject
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
                }
                else {
                    listener.handleEvent(event);
                }
            }
        })
    };

    return track as unknown as MediaStreamTrack;
}

function createMediaStream(
    id: string,
    tracks: readonly MediaStreamTrack[]
): MediaStream {
    return {
        id,
        active: tracks.some((track) => track.readyState !== 'ended'),
        getTracks: vi.fn(() => [...tracks]),
        getAudioTracks: vi.fn(() => tracks.filter((track) => track.kind === 'audio')),
        getVideoTracks: vi.fn(() => tracks.filter((track) => track.kind === 'video'))
    } as unknown as MediaStream;
}
