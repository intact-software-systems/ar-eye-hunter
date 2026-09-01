import { Either } from '@shared/resilience/Either.ts';
import { DEFAULT_RTC_DATA_CHANNEL_LANE_ID, type QRtcPeerDto, type WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import { vi } from 'vitest';
import { installGroupSnapshotRepositoryMocks } from '../auth-session-contract-fixtures.ts';
import type * as ContractModules from '../auth-session-contract-modules.ts';

const mocks = await vi.hoisted(async () => {
    const { createDefaultApiMiddlewareTestDouble } = await import('../api-middleware-test-double.ts');
    const ctx = createDefaultApiMiddlewareTestDouble();
    const session = ctx.session;

    return {
        ctx,
        heartbeat: vi.mocked(ctx.middleware.heartbeat),
        qboxEngine: vi.mocked(ctx.middleware.qboxEngine),
        rtcRxStreamer: vi.mocked(ctx.middleware.rtcRxStreamer),
        webRtcConnectionService: vi.mocked(ctx.middleware.webRtcConnectionService),
        webSocketQueueBox: vi.mocked(ctx.middleware.webSocketQueueBox),
        webSocket: vi.mocked(ctx.middleware.webSocketQueueBox.socket),
        initialiseMiddleware: vi.fn<ContractModules.BrowserMiddlewareModule['initialiseMiddleware']>(() => Promise.resolve(ctx.middleware)),
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

export function readAuthSessionContractMocks(): typeof mocks {
    return mocks;
}

vi.mock(
    import('@shared-web/browser/connection/initialise-browser-middleware.ts'),
    (): Partial<ContractModules.BrowserMiddlewareModule> => ({
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

export async function resetAuthSessionContractMocks(): Promise<void> {
    (
        await import('@shared-web/browser/connection/browser-transport-runtime.ts')
    ).browserTransportRuntime.shutdown('test-reset');
    vi.clearAllMocks();
    vi.useRealTimers();
    resetSessionAndRoomMocks();
    resetRtcTransportMocks();
    resetWebSocketTransportMocks();
    resetAuthAndEventHttpMocks();
}

function resetSessionAndRoomMocks(): void {
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
}

function resetRtcTransportMocks(): void {
    mocks.webRtcConnectionService.peerIdsWithNoReconnectableLanes.mockReturnValue(
        []
    );
    mocks.webRtcConnectionService.knownPeerIds.mockReturnValue([]);
    mocks.webRtcConnectionService.activePeerIds.mockReturnValue([]);
    mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue([]);
    mocks.webRtcConnectionService.ensurePeerConnectionStarted.mockImplementation(
        (peerId) =>
            Either.ofLeft<WebRtcConnectionService.PeerConnectionLeft, QRtcPeerDto>({
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
}

function resetWebSocketTransportMocks(): void {
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
}

function resetAuthAndEventHttpMocks(): void {
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
}
